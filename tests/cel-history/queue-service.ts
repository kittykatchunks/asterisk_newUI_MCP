import assert from "node:assert/strict";
import { join } from "node:path";
import { openCelHistory } from "../../src/cel-history.ts";
import { buildHistoryProjection, PROJECTION_ALGORITHM } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";
import { inspectHistoryMarker } from "../../src/history-markers.ts";

export async function proveQueueService(
  database: string, directory: string, generation: string,
  docker: (args: string[], timeout?: number) => Promise<string>,
  snapshot: (customer: string, kind?: "cel" | "queue") => Promise<Buffer>,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
  ending: "member" | "caller" = "member",
) {
  const callerEnded = ending === "caller";
  const context = callerEnded ? "history-caller-service" : "history-service";
  const queueName = callerEnded ? "caller-service-queue" : "service-queue";
  const terminal = callerEnded ? "COMPLETECALLER" : "COMPLETEAGENT";
  const memberName = callerEnded ? "synthetic-caller-member" : "synthetic-member";
  for (const customer of ["customer-a", "customer-b"]) {
    await docker(["exec", "-T", customer, "asterisk", "-rx",
      `channel originate Local/entry@${context}/n application Wait ${callerEnded ? 3 : 12}`]);
  }
  for (const customer of ["customer-a", "customer-b"]) {
    const deadline = performance.now() + 25000;
    while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
      if (performance.now() > deadline) throw new Error("Synthetic queue service call did not finish");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const source = `pbx-${customer}`;
    const cel = await snapshot(customer);
    const queue = await snapshot(customer, "queue");
    const history = openCelHistory(database);
    const projections = openHistoryProjections(join(directory, "projections.sqlite"));
    try {
      const scope = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1` };
      const previousJourneys = buildHistoryProjection(history, scope).document.journeys;
      const previous = projections.read(scope);
      const previousCel = history.sources(customer).sources[0].consumedBytes;
      const previousQueue = history.queue.sources(customer).sources[0].consumedBytes;
      history.ingest({ customer, source, generation, timeBasis: "UTC" }, cel);
      history.queue.ingest({ customer, source, generation }, queue);
      assert.equal(history.ingest({ customer, source, generation, timeBasis: "UTC" }, cel).inserted, 0);
      assert.equal(history.queue.ingest({ customer, source, generation }, queue).inserted, 0);
      history.manifests.register({ customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1`,
        operator: "synthetic-queue-service", reason: "Appended isolated automated member call in the same observed PBX boot",
        routes: [{ context, extension: "entry", routeRevision: callerEnded ? "caller-service-v1" : "service-v1", entryKind: "synthetic" }],
        ranges: [{ kind: "cel", source, generation, start: previousCel, end: cel.length },
          { kind: "queue", source, generation, start: previousQueue, end: queue.length }] });
      const allCel = history.read({ customer, source, generation, limit: 200 });
      const allQueue = history.queue.read({ customer, source, generation, limit: 200 });
      assert.equal(allCel.nextAfterOffset, null); assert.equal(allQueue.nextAfterOffset, null);
      assert.deepEqual(Buffer.from(allCel.events.map((e) => e.rawRecord).join("")), cel);
      assert.deepEqual(Buffer.from(allQueue.events.map((e) => e.rawRecord).join("")), queue);
      const served = allQueue.events.filter((e) => e.queue === queueName);
      assert.deepEqual(served.map((e) => e.event), ["ENTERQUEUE", "CONNECT", terminal]);
      assert.equal(new Set(served.map((e) => e.callId)).size, 1);
      assert.equal(served[1].member, memberName);
      assert.equal(served[2].member, served[1].member);
      const memberId = served[1].parameters[1];
      const member = history.read({ customer, source, generation, uniqueid: memberId }).events;
      assert.deepEqual(member.map((e) => e.event),
        ["CHAN_START", "ANSWER", "BRIDGE_ENTER", "BRIDGE_EXIT", "HANGUP", "CHAN_END"]);
      const caller = history.read({ customer, source, generation, uniqueid: served[0].callId }).events;
      const names = caller.map((e) => e.event);
      const entryOffset = names.indexOf("HISTORY_ENTRY"), visitOffset = names.indexOf("HISTORY_QUEUE_VISIT");
      assert.ok(entryOffset > 0 && entryOffset < names.indexOf("ANSWER"));
      assert.ok(visitOffset > entryOffset && visitOffset < names.indexOf("APP_START"));
      assert.equal(inspectHistoryMarker(history, customer, source, generation, caller[entryOffset].offset).markerStatus, "validated-marker");
      assert.equal(inspectHistoryMarker(history, customer, source, generation, caller[visitOffset].offset).markerStatus, "validated-marker");
      const built = buildHistoryProjection(history, scope);
      const roots = built.document.journeys.filter((j) => j.visits.some((v) => v.queue === queueName));
      assert.equal(roots.length, 1); assert.equal(built.document.journeys.length, callerEnded ? 3 : 2);
      const root = roots[0];
      assert.equal(root.channel?.answer, "observed");
      assert.equal(root.channel.end, "observed");
      assert.equal(root.channel.uniqueid, served[0].callId);
      assert.equal(root.visits.length, 1);
      const visit = root.visits[0];
      assert.equal(visit.state, "completion-observed");
      assert.equal(visit.queueEvidence.length, 3);
      assert.equal(visit.service.connection, "observed");
      assert.equal(visit.service.memberCorrelation, "answered-channel-observed");
      assert.equal(visit.service.memberUniqueid, memberId);
      assert.equal(visit.service.memberChannelEnd, "observed");
      assert.equal(visit.service.completion, callerEnded ? "caller-ended-queue-service-observed" : "member-ended-queue-service-observed");
      assert.equal(visit.service.memberEvidence.length, 6);
      assert.equal(visit.service.queueEvidence.length, 2);
      for (const earlier of previousJourneys) assert.deepEqual(built.document.journeys.find((j) => j.id === earlier.id), earlier);
      assert.equal(built.document.quality.service, "not-classified");
      assert.equal(built.document.quality.completeness, "unverified");
      assert.equal(built.document.quality.queueCoverage, "not-collected");
      const published = projections.rebuild(history, scope);
      assert.ok(published.id > previous.id);
      assert.equal(published.algorithm, PROJECTION_ALGORITHM);
      assert.deepEqual(projections.read(scope, previous.id), previous);
      assert.equal(projections.rebuild(history, scope).id, published.id);
      const observed = JSON.parse(await cli(["read", database, join(directory, "projections.sqlite"), customer,
        scope.runtime, scope.epoch, "latest"], "Manage-HistoryProjection.ts"));
      assert.equal(observed.freshness.state, "inputs-match");
      assert.equal(observed.sha256, built.sha256);
      assert.deepEqual(observed.document, built.document);
      const offline = JSON.parse(await cli(["stored", database, join(directory, "projections.sqlite"), customer,
        scope.runtime, scope.epoch, String(published.id)], "Manage-HistoryProjection.ts"));
      assert.equal(offline.freshness.state, "not-checked");
      assert.deepEqual(offline.document, built.document);
      assert.throws(() => projections.read({ ...scope, customer: customer === "customer-a" ? "customer-b" : "customer-a" }, published.id), /not found/);
      await assert.rejects(cli(["stored", database, join(directory, "projections.sqlite"), customer,
        "foreign-runtime", scope.epoch, String(published.id)], "Manage-HistoryProjection.ts"));
      evidence.push({ customer, callerUniqueid: served[0].callId, memberUniqueid: memberId,
        queueEvents: served.map((e) => e.event), queueShapes: served.map((e) => ({ event: e.event, member: e.member, parameters: e.parameters })),
        memberChannelEvents: member.map((e) => e.event), celRecords: allCel.events.length, celBytes: cel.length,
        queueRecords: allQueue.events.length, queueBytes: queue.length, exactRawRoundTrip: true, replayInserted: 0,
        callerChannelEvents: names, callerAnswer: root.channel.answer, callerChannelEnd: root.channel.end,
        entryBeforeAnswer: true, visitBeforeQueue: true, trustedServiceMarkers: true,
        projectionRevision: published.id, algorithm: published.algorithm, service: visit.service,
        exactRebuildReusedRevision: true, priorTimeoutStable: true, priorRevisionPreserved: true,
        priorMemberEndedStable: callerEnded ? true : "not-applicable",
        persistedCliReopenMatches: true, offlineFreshness: offline.freshness.state, foreignReadDenied: true,
        humanAnswerProven: false, twoWayMediaProven: false });
      console.log(`PASS ${customer}: CONNECT member id correlated to exact answered/ended CEL channel; separate ${terminal}; persisted/replayed projection; no human/media claim`);
    } finally { projections.close(); history.close(); }
  }
}
