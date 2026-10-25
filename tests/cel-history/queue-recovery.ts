import assert from "node:assert/strict";
import { join } from "node:path";
import { rm, writeFile } from "node:fs/promises";
import { openCelHistory } from "../../src/cel-history.ts";
import { buildHistoryProjection } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";

export async function proveQueueRecovery(
  database: string, directory: string, generation: string,
  docker: (args: string[], timeout?: number) => Promise<string>,
  snapshot: (customer: string, kind?: "cel" | "queue") => Promise<Buffer>,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
) {
  const customers = ["customer-a", "customer-b"];
  const queueCli = (args: string[]) => cli(args, "Manage-QueueCollector.ts");
  const celCli = (args: string[]) => cli(args, "Manage-CelCollector.ts");
  const proofStarted = Date.now();
  for (const customer of customers) {
    const source = `pbx-${customer}`;
    const queuePath = join(directory, customer, "queue_log");
    const celPath = join(directory, customer, "collector-cel.csv");
    await writeFile(queuePath, await snapshot(customer, "queue"));
    await writeFile(celPath, await snapshot(customer));
    await queueCli(["configure", database, customer, source, generation, queuePath, "1000"]);
    await celCli(["configure", database, customer, source, generation, "UTC", celPath, "60000"]);
    const queue = JSON.parse(await queueCli(["collect", database, customer, source]));
    const cel = JSON.parse(await celCli(["collect", database, customer, source]));
    assert.equal(queue.result.inserted, 0); assert.equal(cel.result.inserted, 0);
    assert.equal(queue.status.checkpoint.records, 3);
    assert.equal(queue.status.status, "healthy");
    await docker(["exec", "-T", customer, "asterisk", "-rx",
      "channel originate Local/entry@history-marker/n application Wait 4"]);
  }
  for (const customer of customers) {
    const deadline = performance.now() + 20000;
    while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
      if (performance.now() > deadline) throw new Error("Queue recovery fixture did not finish");
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  for (const customer of customers) {
    const source = `pbx-${customer}`;
    const queuePath = join(directory, customer, "queue_log");
    const before = JSON.parse(await queueCli(["status", database, customer, source]));
    assert.equal(before.status, "stale");
    assert.equal(before.checkpoint.records, 3);
    const raw = await snapshot(customer, "queue");
    await writeFile(queuePath, raw);
    const resumed = JSON.parse(await queueCli(["collect", database, customer, source]));
    assert.equal(resumed.result.inserted, 2);
    assert.equal(resumed.result.records, 5);
    assert.equal(resumed.status.status, "healthy");
    const replay = JSON.parse(await queueCli(["collect", database, customer, source]));
    assert.equal(replay.result.inserted, 0);
    const scope = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1` };
    const projectionPath = join(directory, "projections.sqlite");
    const history = openCelHistory(database, { readOnly: true });
    const projections = openHistoryProjections(projectionPath);
    let stableJourneyKey: string;
    let baselineCel;
    try {
      const events = history.queue.read({ customer, source, generation }).events;
      assert.deepEqual(Buffer.from(events.map((e) => e.rawRecord).join("")), raw);
      assert.equal(events.filter((e) => e.event === "ENTERQUEUE").length, 2);
      assert.equal(events.filter((e) => e.event === "EXITWITHTIMEOUT").length, 2);
      const built = buildHistoryProjection(history, scope);
      stableJourneyKey = built.document.journeys[0].id;
      assert.equal(built.document.journeys.length, 1);
      assert.equal(built.document.journeys[0].visits[0].state, "timeout-observed");
      assert.equal(built.document.issues.filter((i) => i.reason === "unassigned-evidence").length, 2);
      projections.rebuild(history, scope);
      const status = history.collectorStatus(customer, source);
      assert.equal(status.status, "healthy");
      baselineCel = { revision: status.revision, outcome: status.outcome, succeededAt: status.succeededAt,
        checkpoint: status.checkpoint, gapCount: status.gapCount };
    } finally { projections.close(); history.close(); }
    await rm(queuePath);
    await assert.rejects(queueCli(["collect", database, customer, source]));
    const missing = JSON.parse(await queueCli(["status", database, customer, source]));
    assert.equal(missing.failure, "source-unavailable");
    const replacement = raw.subarray(raw.indexOf(10) + 1);
    await writeFile(queuePath, replacement);
    await assert.rejects(queueCli(["collect", database, customer, source]));
    const discontinuity = JSON.parse(await queueCli(["status", database, customer, source]));
    assert.equal(discontinuity.failure, "prefix-discontinuity");
    assert.equal(discontinuity.checkpoint.records, 5);
    const replacementGeneration = `${generation}-replacement`;
    const transition = JSON.parse(await queueCli(["transition", database, customer, source, replacementGeneration,
      "synthetic-queue-recovery", "Synthetic replacement; retained source continuity not established"]));
    const recovered = JSON.parse(await queueCli(["collect", database, customer, source]));
    assert.equal(recovered.result.records, 4);
    assert.equal(recovered.status.status, "healthy");
    assert.equal(recovered.status.coverage, "unknown-gap-recorded");
    assert.equal(recovered.status.gapCount, 1);
    assert.equal(JSON.parse(await queueCli(["collect", database, customer, source])).result.inserted, 0);
    const reader = openCelHistory(database, { readOnly: true });
    const derived = openHistoryProjections(projectionPath);
    try {
      assert.deepEqual(Buffer.from(reader.queue.read({ customer, source, generation }).events.map((e) => e.rawRecord).join("")), raw);
      assert.deepEqual(Buffer.from(reader.queue.read({ customer, source, generation: replacementGeneration }).events.map((e) => e.rawRecord).join("")), replacement);
      assert.equal(reader.manifests.resolve(customer, "queue", source, replacementGeneration, 0).status, "unassigned");
      const built = buildHistoryProjection(reader, scope);
      const queueCoverage = built.document.input.coverage.find((c) => c.kind === "queue" && c.source === source)!;
      assert.equal(queueCoverage.association, "possibly-applicable");
      assert.equal(queueCoverage.gaps.length, 1);
      assert.equal(queueCoverage.gaps[0].id, transition.gapId);
      assert.equal(built.document.input.coverage.find((c) => c.kind === "cel" && c.source === source)!.gaps.length, 0);
      assert.equal(built.document.quality.completeness, "unverified");
      assert.equal(built.document.quality.queueCoverage, "unverified");
      assert.equal(built.document.journeys[0].id, stableJourneyKey);
      assert.equal(built.document.journeys[0].visits[0].state, "timeout-observed");
      const currentCel = reader.collectorStatus(customer, source);
      assert.deepEqual({ revision: currentCel.revision, outcome: currentCel.outcome, succeededAt: currentCel.succeededAt,
        checkpoint: currentCel.checkpoint, gapCount: currentCel.gapCount }, baselineCel);
      const published = derived.rebuild(reader, scope);
      assert.equal(derived.rebuild(reader, scope).id, published.id);
      assert.equal(derived.rebuild(reader, scope).reused, true);
      const observed = JSON.parse(await cli(["read", database, projectionPath, customer, scope.runtime, scope.epoch, "latest"],
        "Manage-HistoryProjection.ts"));
      assert.equal(observed.freshness.state, "inputs-match");
      assert.equal(observed.collectorHealth.find((c: { kind: string }) => c.kind === "queue").coverage, "unknown-gap-recorded");
      assert.equal(observed.document.journeys[0].id, stableJourneyKey);
      assert.throws(() => reader.queue.collectors.gaps(customer === "customer-a" ? "customer-b" : "customer-a", source), /not found/);
      evidence.push({ customer, source, generation, replacementGeneration,
        staleBeforeReplay: before.status, lastSuccessAgeMs: before.ageMs, staleThresholdMs: 1000,
        retainedRecordsBefore: 3, resumedInserted: resumed.result.inserted, retainedRecordsAfter: 5,
        retainedBytes: raw.length, duplicateReplayInserted: 0,
        missingSourceFailure: missing.failure, discontinuityFailure: discontinuity.failure,
        replacementRecords: recovered.result.records, replacementBytes: replacement.length, replacementStatus: recovered.status.status,
        persistentCoverage: recovered.status.coverage, gapId: transition.gapId, gapAssociation: queueCoverage.association,
        celCollectionUnchanged: true, exactOldAndNewRawRoundTrip: true, replacementUnassigned: true,
        projectionRevision: published.id, projectionAlgorithm: published.algorithm, stableJourneyKeyPreserved: true,
        projectionCompleteness: built.document.quality.completeness, projectionQueueCoverage: built.document.quality.queueCoverage,
        readOnlyCliFreshness: observed.freshness.state, foreignGapReadDenied: true });
      console.log(`PASS ${customer}: stale queue collector replayed 2 records once; explicit replacement retained unknown gap and independent CEL evidence`);
    } finally { derived.close(); reader.close(); }
  }
  if (Date.now() - proofStarted > 60000) throw new Error("Queue recovery proof exceeded independent CEL freshness window");
}
