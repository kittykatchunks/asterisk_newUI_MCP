import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openCelHistory, type CelEvent } from "../../src/cel-history.ts";
import type { QueueEvent } from "../../src/queue-history.ts";
import { buildHistoryProjection, type ProjectionScope } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";
import { createHistoryReader } from "../../src/history-reader.ts";

interface Boot {
  scope: ProjectionScope; celStart: number; queueStart: number; cel: Buffer; queue: Buffer;
  process: string; journey: ReturnType<typeof buildHistoryProjection>["document"]["journeys"][number];
}
export async function provePbxEpochRecovery(
  database: string, directory: string, generation: string,
  docker: (args: string[], timeout?: number) => Promise<string>,
  snapshot: (customer: string, kind?: "cel" | "queue") => Promise<Buffer>,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
) {
  const customers = ["customer-a", "customer-b"];
  const projectionPath = join(directory, "projections.sqlite");
  const boots = new Map<string, Boot[]>();
  const check = async (id: string, name: string, action: () => Promise<unknown>) => {
    const record: Record<string, unknown> = { id, name, status: "running" }; evidence.push(record);
    try { record.evidence = await action(); record.status = "passed"; console.log(`${id} PASS: ${name}`); }
    catch (error) { record.status = "failed"; throw error; }
  };
  const token = (customer: string) => docker(["exec", "-T", customer, "python3", "-B", "-c",
    "from pathlib import Path; print(Path('/proc/1/stat').read_text().split(') ',1)[1].split()[19])"]);
  const read = <T>(action: (h: ReturnType<typeof openCelHistory>) => T) => {
    const h = openCelHistory(database, { readOnly: true }); try { return action(h); } finally { h.close(); }
  };
  const projection = <T>(action: (p: ReturnType<typeof openHistoryProjections>) => T) => {
    const p = openHistoryProjections(projectionPath, { readOnly: true }); try { return action(p); } finally { p.close(); }
  };
  const source = (customer: string) => `pbx-${customer}`;
  const rebuild = async (scope: ProjectionScope) => JSON.parse(await cli(
    ["rebuild", database, projectionPath, scope.customer, scope.runtime, scope.epoch], "Manage-HistoryProjection.ts"));
  const importSnapshots = (customer: string, cel: Buffer, queue: Buffer) => {
    const h = openCelHistory(database);
    try {
      const scope = { customer, source: source(customer), generation };
      const importedCel = h.ingest({ ...scope, timeBasis: "UTC" }, cel), importedQueue = h.queue.ingest(scope, queue);
      assert.equal(importedCel.pendingBytes, 0); assert.equal(importedQueue.pendingBytes, 0);
      assert.equal(h.ingest({ ...scope, timeBasis: "UTC" }, cel).inserted, 0);
      assert.equal(h.queue.ingest(scope, queue).inserted, 0);
      return { cel: importedCel.inserted, queue: importedQueue.inserted };
    } finally { h.close(); }
  };
  const originate = async (customer: string) => {
    assert.match(await docker(["exec", "-T", customer, "python3", "-B", "/run/epoch_originate.py"]), /PASS bounded synthetic epoch call/);
    const deadline = performance.now() + 20000;
    while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
      if (performance.now() > deadline) throw new Error("Epoch fixture did not finish");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  };
  const assign = (customer: string, boot: number, cel: Buffer, queue: Buffer, celStart: number, queueStart: number) => {
    const scope = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-${boot}` };
    const h = openCelHistory(database);
    try {
      const manifest = h.manifests.register({ ...scope, operator: "isolated-pbx-epoch-proof",
        reason: `Observed owned Asterisk PID-1 process for boot ${boot}; quiescent exact byte boundaries, not log timestamp inference`,
        routes: [{ context: "history-epoch", extension: "entry", routeRevision: "epoch-v1", entryKind: "synthetic" }],
        ranges: [{ kind: "cel", source: source(customer), generation, start: celStart, end: cel.length },
          { kind: "queue", source: source(customer), generation, start: queueStart, end: queue.length }] });
      assert.equal(h.manifests.register({ customer: manifest.customer, runtime: manifest.runtime, epoch: manifest.epoch,
        operator: manifest.operator, reason: manifest.reason, routes: manifest.routes, ranges: manifest.ranges }).id, manifest.id);
      return scope;
    } finally { h.close(); }
  };
  const verify = (scope: ProjectionScope, celStart: number, queueStart: number) => read((h) => {
    const built = buildHistoryProjection(h, scope);
    assert.equal(built.document.journeys.length, 1);
    const j = built.document.journeys[0];
    assert.equal(j.state, "marked-caller-observed"); assert.equal(j.channel?.uniqueid, "epoch-reused-caller");
    assert.equal(j.channel.answer, "observed"); assert.equal(j.channel.end, "observed");
    assert.equal(j.journeyId, "11111111-1111-4111-8111-111111111111");
    assert.equal(j.visits.length, 1); assert.equal(j.visits[0].state, "timeout-observed");
    assert.equal(j.visits[0].queue, "proof-queue"); assert.equal(j.visits[0].queueEvidence.length, 2);
    assert.equal(j.visits[0].service.connection, "not-observed"); assert.equal(j.visits[0].service.completion, "not-observed");
    assert.equal(built.document.quality.completeness, "unverified"); assert.equal(built.document.quality.service, "not-classified");
    const celRefs = [...j.entryEvidence, ...j.channel.evidence, ...j.visits[0].markerEvidence];
    assert.ok(celRefs.every((r) => r.kind === "cel" && r.offset >= celStart));
    assert.ok(j.visits[0].queueEvidence.every((r) => r.kind === "queue" && r.offset >= queueStart));
    return j;
  });

  await check("BE-01", "Real deterministic synthetic caller/queue markers are recorded for both isolated boot-1 PBXs", async () => {
    for (const customer of customers) {
      const process = await token(customer); assert.match(process, /^[0-9]+$/);
      await originate(customer);
      const cel = await snapshot(customer), queue = await snapshot(customer, "queue");
      importSnapshots(customer, cel, queue);
      const scope = assign(customer, 1, cel, queue, 0, 0), journey = verify(scope, 0, 0);
      await rebuild(scope);
      boots.set(customer, [{ scope, cel, queue, celStart: 0, queueStart: 0, process, journey }]);
    }
    return customers.map((c) => ({ customer: c, process: boots.get(c)![0].process, scope: boots.get(c)![0].scope,
      uniqueid: boots.get(c)![0].journey.channel!.uniqueid, state: boots.get(c)![0].journey.visits[0].state }));
  });
  await check("BE-02", "Durable complete boot-1 CEL/queue snapshots round-trip and replays reuse revisions", async () => {
    for (const customer of customers) {
      const b = boots.get(customer)![0];
      read((h) => {
        const query = { customer, source: source(customer), generation, limit: 200 };
        assert.deepEqual(Buffer.from(h.read(query).events.map((e) => e.rawRecord).join("")), b.cel);
        assert.deepEqual(Buffer.from(h.queue.read(query).events.map((e) => e.rawRecord).join("")), b.queue);
      });
      const before = projection((p) => p.read(b.scope)); assert.equal((await rebuild(b.scope)).id, before.id);
    }
    return { boot1Snapshots: 4, duplicateReplayRows: 0, reusedProjectionRevisions: 2 };
  });
  await check("BE-03", "Stopping only customer A leaves B responsive and A stored evidence readable offline", async () => {
    const a = boots.get("customer-a")![0], b = boots.get("customer-b")![0];
    await docker(["stop", "--timeout", "5", "customer-a"], 30000);
    await assert.rejects(docker(["exec", "-T", "customer-a", "asterisk", "-rx", "core show uptime"]));
    assert.equal(await token("customer-b"), b.process);
    assert.match(await docker(["exec", "-T", "customer-b", "asterisk", "-rx", "core show uptime"]), /System uptime/);
    assert.deepEqual(await snapshot("customer-b"), b.cel);
    const reader = createHistoryReader(database, projectionPath);
    const stored = reader.read(a.scope, undefined, false);
    assert.equal(stored.freshness.state, "not-checked"); assert.deepEqual(stored.observation.journeys[0], a.journey);
    return { stoppedCustomer: "customer-a", otherCustomerProcessUnchanged: true, storedReadWhilePbxDown: "not-checked" };
  });
  const restart = async (customer: string, alreadyStopped: boolean) => {
    const old = boots.get(customer)![0];
    if (!alreadyStopped) await docker(["stop", "--timeout", "5", customer], 30000);
    // Graceful shutdown may append final administrative records; capture the volume
    // boundary before restarting using an owned one-off reader, not a timestamp guess.
    const stopped = async (kind: "cel" | "queue") => {
      const path = kind === "cel" ? "/var/log/asterisk/cel-custom/Master.csv" : "/var/log/asterisk/queue_log";
      const output = await docker(["run", "--rm", "--no-deps", "-T", "--entrypoint", "python3", customer, "-B", "-c",
        `import base64; from pathlib import Path; print(base64.b64encode(Path('${path}').read_bytes()).decode())`], 30000);
      return Buffer.from(output, "base64");
    };
    const preCel = await stopped("cel"), preQueue = await stopped("queue");
    assert.deepEqual(preCel.subarray(0, old.cel.length), old.cel); assert.deepEqual(preQueue.subarray(0, old.queue.length), old.queue);
    importSnapshots(customer, preCel, preQueue);
    await docker(["up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "90", customer], 120000);
    const process = await token(customer); assert.notEqual(process, old.process);
    const startCel = await snapshot(customer), startQueue = await snapshot(customer, "queue");
    assert.deepEqual(startCel.subarray(0, preCel.length), preCel); assert.deepEqual(startQueue.subarray(0, preQueue.length), preQueue);
    await originate(customer);
    const cel = await snapshot(customer), queue = await snapshot(customer, "queue");
    assert.deepEqual(cel.subarray(0, preCel.length), preCel); assert.deepEqual(queue.subarray(0, preQueue.length), preQueue);
    importSnapshots(customer, cel, queue);
    assert.deepEqual(read((h) => buildHistoryProjection(h, old.scope).document.journeys[0]), old.journey);
    assert.ok(read((h) => buildHistoryProjection(h, old.scope).document.issues.some((i) => i.reason === "unassigned-evidence")));
    return { old, cel, queue, process, celStart: preCel.length, queueStart: preQueue.length };
  };
  let restartedA: Awaited<ReturnType<typeof restart>>;
  await check("BE-04", "Restarted A has a changed process start and append-preserved logs; unassigned boot-2 evidence cannot contaminate boot-1", async () => {
    restartedA = await restart("customer-a", true);
    assert.equal(await token("customer-b"), boots.get("customer-b")![0].process);
    return { before: restartedA.old.process, after: restartedA.process, celBoundary: restartedA.celStart,
      queueBoundary: restartedA.queueStart, sameSourceGeneration: generation, oldObservationsUnchanged: true };
  });
  await check("BE-05", "Explicit disjoint A boot-2 manifest isolates deliberately reused real identities", async () => {
    const r = restartedA;
    const scope = assign("customer-a", 2, r.cel, r.queue, r.celStart, r.queueStart);
    const journey = verify(scope, r.celStart, r.queueStart);
    assert.notEqual(journey.id, r.old.journey.id); assert.notEqual(journey.visits[0].id, r.old.journey.visits[0].id);
    await rebuild(scope);
    boots.get("customer-a")!.push({ scope, ...r, journey });
    return { scope, sameCallerUniqueid: journey.channel!.uniqueid, sameMarkerId: journey.journeyId, distinctStableRoot: journey.id,
      delayedAssignmentRequired: true };
  });
  await check("BE-06", "Restarting B alone proves an independent second boot while A remains responsive", async () => {
    const aProcess = await token("customer-a"), r = await restart("customer-b", false);
    assert.equal(await token("customer-a"), aProcess);
    assert.match(await docker(["exec", "-T", "customer-a", "asterisk", "-rx", "core show uptime"]), /System uptime/);
    const scope = assign("customer-b", 2, r.cel, r.queue, r.celStart, r.queueStart);
    const journey = verify(scope, r.celStart, r.queueStart); await rebuild(scope);
    boots.get("customer-b")!.push({ scope, ...r, journey });
    return { scope, before: r.old.process, after: r.process, celBoundary: r.celStart, queueBoundary: r.queueStart,
      otherCustomerProcessUnchanged: true };
  });
  await check("BE-07", "All four customer/epoch roots and visits stay distinct despite equal real uniqueid/linkedid/marker/queue identities", async () => {
    const roots: string[] = [], visits: string[] = [], linkedids = new Set<string>();
    for (const customer of customers) for (const b of boots.get(customer)!) {
      const j = verify(b.scope, b.celStart, b.queueStart); roots.push(j.id); visits.push(j.visits[0].id);
      read((h) => {
        for (const ref of j.channel!.evidence) {
          const event = h.read({ customer, source: ref.source, generation: ref.generation,
            afterOffset: ref.offset - 1, limit: 1 }).events[0];
          assert.equal(event.offset, ref.offset); linkedids.add(event.linkedid);
          const assignment = h.manifests.resolve(customer, "cel", ref.source, ref.generation, ref.offset);
          assert.equal(assignment.assignment?.epoch, b.scope.epoch);
        }
        const queueRefs = j.visits[0].queueEvidence;
        assert.ok(queueRefs.every((ref) => h.manifests.resolve(customer, "queue", ref.source, ref.generation, ref.offset).assignment?.epoch === b.scope.epoch));
        if (b.celStart === 0) {
          const boundary = boots.get(customer)![1];
          assert.ok(j.channel!.evidence.every((r) => r.offset < boundary.celStart));
          assert.ok(queueRefs.every((r) => r.offset < boundary.queueStart));
        }
      });
    }
    assert.equal(new Set(roots).size, 4); assert.equal(new Set(visits).size, 4);
    assert.deepEqual([...linkedids], ["epoch-reused-originator"]);
    return { distinctRoots: roots, distinctVisits: visits, actualLinkedids: [...linkedids], uniqueid: "epoch-reused-caller",
      queue: "proof-queue", syntheticMarkerReuse: true, crossEpochJoins: 0 };
  });
  await check("BE-08", "Fresh-process full replay preserves all raw bytes and historical revisions; current rebuilds reuse exactly", async () => {
    for (const customer of customers) {
      const all = boots.get(customer)!, last = all[1];
      for (const kind of ["cel", "queue"] as const) {
        const input = join(directory, customer, kind === "cel" ? "epoch-cel.csv" : "epoch-queue.log");
        await writeFile(input, kind === "cel" ? last.cel : last.queue);
        const result = JSON.parse(await cli(["import", database, customer, source(customer), generation,
          ...(kind === "cel" ? ["UTC"] : []), input], kind === "cel" ? "Manage-CelHistory.ts" : "Manage-QueueHistory.ts"));
        assert.equal(result.inserted, 0); assert.equal(result.pendingBytes, 0);
      }
      for (const b of all) {
        const before = projection((p) => p.read(b.scope));
        const current = await rebuild(b.scope), again = await rebuild(b.scope);
        assert.equal(again.id, current.id); assert.equal(again.reused, true);
        assert.deepEqual(projection((p) => p.read(b.scope, before.id)), before);
        assert.deepEqual(projection((p) => p.read(b.scope)).document.journeys, [b.journey]);
      }
      read((h) => {
        const query = { customer, source: source(customer), generation, limit: 200 };
        assert.deepEqual(Buffer.from(h.read(query).events.map((e: CelEvent) => e.rawRecord).join("")), last.cel);
        assert.deepEqual(Buffer.from(h.queue.read(query).events.map((e: QueueEvent) => e.rawRecord).join("")), last.queue);
        assert.equal(h.sources(customer).sources.length, 1); assert.equal(h.queue.sources(customer).sources.length, 1);
      });
    }
    return { replayedStreams: 4, insertedRows: 0, currentScopes: 4, sourceGenerationsPerCustomerAndKind: 1, bootEpochsPerCustomer: 2 };
  });
  await check("BE-09", "Overlapping boot assignment, runtime rebinding and foreign raw/revision guesses fail without mutation", async () => {
    for (const customer of customers) {
      const b = boots.get(customer)![1], other = customer === "customer-a" ? "customer-b" : "customer-a";
      const h = openCelHistory(database);
      try {
        const before = h.manifests.list(customer);
        for (const runtime of [b.scope.runtime, "wrong-runtime"]) {
          assert.throws(() => h.manifests.register({ customer, runtime, epoch: "invented-boot", operator: "epoch-proof",
            reason: "Rejected contradictory provenance", routes: [],
            ranges: [{ kind: "cel", source: source(customer), generation, start: b.celStart, end: b.cel.length }] }));
        }
        assert.deepEqual(h.manifests.list(customer), before);
        assert.throws(() => h.read({ customer: other, source: source(customer), generation }), /not found/);
        assert.throws(() => h.queue.read({ customer: other, source: source(customer), generation }), /not found/);
      } finally { h.close(); }
      const old = projection((p) => p.read(boots.get(customer)![0].scope));
      assert.throws(() => projection((p) => p.read(b.scope, old.id)), /not found/);
      assert.throws(() => projection((p) => p.read({ ...b.scope, customer: other })), /not found/);
    }
    return { overlapAndRuntimeDenials: 4, foreignRawDenials: 4, scopedRevisionDenials: 4, inferredEpochs: 0 };
  });
  await check("BE-10", "Authenticated HTTP and Chromium expose only selected customer/boot revisions with honest freshness", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const execute = promisify(execFile);
    const result = await execute(process.execPath, ["--test", "--test-name-pattern=HR-10", join(root, "tests", "history-workspace.test.ts")],
      { cwd: root, timeout: 90000, maxBuffer: 1024 * 1024,
        env: { ...process.env, HR_PROOF_ROOT: "", HR_EPOCH_PROOF_DIRECTORY: directory } });
    assert.match(result.stdout, /pass 1/); assert.match(result.stdout, /fail 0/);
    return { customerEpochBrowserCases: 4, wrongEpochRevisionDenied: 4, customerSubstitutionDenied: 4,
      checkedFreshness: "inputs-match; only local committed evidence", rawAndProjectionBytesUnchanged: true };
  });
}
