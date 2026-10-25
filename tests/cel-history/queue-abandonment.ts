import assert from "node:assert/strict";
import { join } from "node:path";
import { openCelHistory } from "../../src/cel-history.ts";
import { buildHistoryProjection, PROJECTION_ALGORITHM } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";
import { inspectHistoryMarker } from "../../src/history-markers.ts";

export async function proveQueueAbandonment(
  database: string, directory: string, generation: string,
  docker: (args: string[], timeout?: number) => Promise<string>,
  snapshot: (customer: string, kind?: "cel" | "queue") => Promise<Buffer>,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
) {
  for (const customer of ["customer-a", "customer-b"]) {
    await docker(["exec", "-T", customer, "asterisk", "-rx",
      "channel originate Local/entry@history-abandon/n application Wait 3"]);
  }
  for (const customer of ["customer-a", "customer-b"]) {
    const deadline = performance.now() + 20000;
    while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
      if (performance.now() > deadline) throw new Error("Pre-connection hangup fixture did not finish");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    const source = `pbx-${customer}`;
    const cel = await snapshot(customer);
    const queue = await snapshot(customer, "queue");
    const history = openCelHistory(database);
    const projections = openHistoryProjections(join(directory, "projections.sqlite"));
    try {
      const scope = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1` };
      const previous = projections.read(scope);
      const previousJourneys = buildHistoryProjection(history, scope).document.journeys;
      const previousCel = history.sources(customer).sources[0].consumedBytes;
      const previousQueue = history.queue.sources(customer).sources[0].consumedBytes;
      history.ingest({ customer, source, generation, timeBasis: "UTC" }, cel);
      history.queue.ingest({ customer, source, generation }, queue);
      assert.equal(history.ingest({ customer, source, generation, timeBasis: "UTC" }, cel).inserted, 0);
      assert.equal(history.queue.ingest({ customer, source, generation }, queue).inserted, 0);
      history.manifests.register({ ...scope, operator: "synthetic-abandonment",
        reason: "Isolated no-member queue; caller-side bounded hangup in the same observed PBX boot",
        routes: [{ context: "history-abandon", extension: "entry", routeRevision: "abandon-v1", entryKind: "synthetic" }],
        ranges: [{ kind: "cel", source, generation, start: previousCel, end: cel.length },
          { kind: "queue", source, generation, start: previousQueue, end: queue.length }] });
      const allCel = history.read({ customer, source, generation, limit: 200 });
      const allQueue = history.queue.read({ customer, source, generation, limit: 200 });
      assert.equal(allCel.nextAfterOffset, null); assert.equal(allQueue.nextAfterOffset, null);
      assert.deepEqual(Buffer.from(allCel.events.map((e) => e.rawRecord).join("")), cel);
      assert.deepEqual(Buffer.from(allQueue.events.map((e) => e.rawRecord).join("")), queue);
      const abandoned = allQueue.events.filter((e) => e.queue === "abandon-queue");
      assert.deepEqual(abandoned.map((e) => e.event), ["ENTERQUEUE", "ABANDON"]);
      assert.equal(new Set(abandoned.map((e) => e.callId)).size, 1);
      assert.ok(abandoned.every((e) => e.member === "NONE"));
      assert.equal(abandoned[1].parameters.length, 3);
      assert.ok(abandoned[1].parameters.every((p) => /^(?:0|[1-9][0-9]*)$/.test(p) && Number.isSafeInteger(Number(p))));
      assert.ok(Number(abandoned[1].parameters[0]) > 0 && Number(abandoned[1].parameters[1]) > 0);
      const caller = history.read({ customer, source, generation, uniqueid: abandoned[0].callId }).events;
      const names = caller.map((e) => e.event);
      assert.deepEqual(names.filter((name) => name !== "LINKEDID_END"), ["CHAN_START", "HISTORY_ENTRY", "ANSWER", "HISTORY_QUEUE_VISIT",
        "APP_START", "APP_END", "HANGUP", "CHAN_END"]);
      assert.ok(names.filter((name) => name === "LINKEDID_END").length <= 1);
      if (names.includes("LINKEDID_END")) assert.equal(names.at(-1), "LINKEDID_END");
      for (const name of ["HISTORY_ENTRY", "HISTORY_QUEUE_VISIT"]) {
        assert.equal(inspectHistoryMarker(history, customer, source, generation, caller[names.indexOf(name)].offset).markerStatus,
          "validated-marker");
      }
      assert.ok(names.indexOf("HISTORY_ENTRY") < names.indexOf("ANSWER"));
      assert.ok(names.indexOf("HISTORY_QUEUE_VISIT") < names.indexOf("APP_START"));
      const built = buildHistoryProjection(history, scope);
      assert.equal(built.document.journeys.length, 4);
      for (const earlier of previousJourneys) assert.deepEqual(built.document.journeys.find((j) => j.id === earlier.id), earlier);
      const roots = built.document.journeys.filter((j) => j.visits.some((v) => v.queue === "abandon-queue"));
      assert.equal(roots.length, 1);
      const root = roots[0], visit = root.visits[0];
      assert.equal(root.channel?.uniqueid, abandoned[0].callId);
      assert.equal(root.channel.answer, "observed"); assert.equal(root.channel.end, "observed");
      assert.equal(visit.state, "abandonment-observed");
      assert.equal(visit.abandonment, "observed");
      assert.equal(visit.queueEvidence.length, 2);
      assert.equal(visit.service.connection, "not-observed");
      assert.equal(visit.service.completion, "not-observed");
      assert.equal(visit.service.memberUniqueid, null);
      assert.equal(visit.service.memberEvidence.length, 0);
      assert.equal(built.document.quality.service, "not-classified");
      assert.equal(built.document.quality.completeness, "unverified");
      const published = projections.rebuild(history, scope);
      assert.ok(published.id > previous.id);
      assert.equal(published.algorithm, PROJECTION_ALGORITHM);
      assert.equal(projections.rebuild(history, scope).id, published.id);
      assert.deepEqual(projections.read(scope, previous.id), previous);
      for (const action of ["read", "stored"]) {
        const read = JSON.parse(await cli([action, database, join(directory, "projections.sqlite"),
          customer, scope.runtime, scope.epoch, String(published.id)], "Manage-HistoryProjection.ts"));
        assert.deepEqual(read.document, built.document);
        assert.equal(read.freshness.state, action === "read" ? "inputs-match" : "not-checked");
      }
      assert.throws(() => projections.read({ ...scope, customer: customer === "customer-a" ? "customer-b" : "customer-a" }, published.id),
        /not found/);
      await assert.rejects(cli(["stored", database, join(directory, "projections.sqlite"), customer, scope.runtime,
        "foreign-epoch", String(published.id)], "Manage-HistoryProjection.ts"));
      evidence.push({ customer, callerUniqueid: abandoned[0].callId,
        queueShapes: abandoned.map((e) => ({ event: e.event, member: e.member, parameters: e.parameters })),
        callerChannelEvents: names, trustedMarkerOrder: true, connectObserved: false,
        callerAnswer: root.channel.answer, callerEnd: root.channel.end, visitState: visit.state, abandonment: visit.abandonment,
        celRecords: allCel.events.length, celBytes: cel.length, queueRecords: allQueue.events.length, queueBytes: queue.length,
        projectionRevision: published.id, algorithm: published.algorithm, exactRawRoundTrip: true, replayInserted: 0,
        previousJourneysPreserved: true, previousRevisionPreserved: true, persistedCliReadsMatch: true,
        foreignReadDenied: true, humanIntentProven: false, wholeJourneyOutcomeProven: false });
      console.log(`PASS ${customer}: exact ENTERQUEUE/ABANDON, trusted markers, caller lifecycle; persisted/replayed v5 and prior journeys retained`);
    } finally { projections.close(); history.close(); }
  }
}
