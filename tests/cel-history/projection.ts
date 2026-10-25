import assert from "node:assert/strict";
import { openCelHistory } from "../../src/cel-history.ts";
import { buildHistoryProjection } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";

export async function proveHistoryProjection(
  historyPath: string, projectionPath: string, generation: string,
  cli: (args: string[], script?: string) => Promise<string>,
  evidence: Record<string, unknown>[],
) {
  for (const customer of ["customer-a", "customer-b"]) {
    const scope = { customer, runtime: `${customer}-runtime`, epoch: `${generation}-boot-1` };
    const command = (action: string, ...args: string[]) => cli(
      [action, historyPath, projectionPath, customer, scope.runtime, scope.epoch, ...args], "Manage-HistoryProjection.ts");
    const initial = JSON.parse(await command("rebuild"));
    const replay = JSON.parse(await command("rebuild"));
    assert.equal(initial.reused, false);
    assert.equal(replay.reused, true);
    assert.equal(initial.id, replay.id);
    assert.equal(initial.sha256, replay.sha256);
    const history = openCelHistory(historyPath, { readOnly: true });
    const projections = openHistoryProjections(projectionPath, { readOnly: true });
    try {
      const built = buildHistoryProjection(history, scope);
      const read = projections.read(scope);
      assert.equal(read.id, initial.id);
      assert.equal(read.inputSha256, built.inputSha256);
      assert.equal(read.sha256, built.sha256);
      assert.deepEqual(read.document, built.document);
      assert.equal(built.document.journeys.length, 1);
      const journey = built.document.journeys[0];
      assert.equal(journey.state, "marked-caller-observed");
      assert.equal(journey.entryKind, "synthetic");
      assert.equal(journey.channel?.answer, "observed");
      assert.equal(journey.channel?.end, "observed");
      assert.equal(journey.channel.evidence.length, 8);
      assert.equal(journey.visits.length, 1);
      const visit = journey.visits[0];
      assert.equal(visit.state, "timeout-observed");
      assert.equal(visit.queueEvidence.length, 2);
      assert.equal(built.document.quality.completeness, "unverified");
      assert.equal(built.document.quality.service, "not-classified");
      assert.equal(built.document.quality.queueCoverage, "not-collected");
      assert.ok(built.document.issues.some((issue) => issue.reason === "unattributed-cel-evidence"));
      assert.ok(built.document.issues.some((issue) => issue.reason === "administrative-queue-evidence"));
      assert.equal("totals" in built.document, false);
      const fresh = JSON.parse(await command("read", "latest"));
      assert.equal(fresh.freshness.state, "inputs-match");
      assert.equal(fresh.document.journeys[0].id, journey.id);
      assert.equal(fresh.document.journeys[0].visits[0].id, visit.id);
      assert.throws(() => projections.read({ ...scope, customer: customer === "customer-a" ? "customer-b" : "customer-a" }),
        /not found/);
      evidence.push({ customer, runtime: scope.runtime, epoch: scope.epoch, revisionId: read.id,
        algorithm: read.algorithm, inputSha256: read.inputSha256, projectionSha256: read.sha256,
        journeyId: journey.journeyId, stableJourneyKey: journey.id,
        visitId: visit.visitId, stableVisitKey: visit.id, callerUniqueid: journey.channel.uniqueid,
        callerEvidenceRecords: journey.channel.evidence.length, answer: journey.channel.answer,
        callerChannelEnd: journey.channel.end, queueVisit: visit.state, queueEvidenceRecords: visit.queueEvidence.length,
        exactRebuildReusedRevision: true, persistedReopenMatches: true, freshness: fresh.freshness.state,
        completeness: built.document.quality.completeness, service: built.document.quality.service,
        queueCoverage: built.document.quality.queueCoverage, unattributedEvidenceRetained: true, foreignReadDenied: true });
      console.log(`PASS ${customer}: persisted/replayed conservative projection; explicit caller answer/end and queue timeout; no inferred service`);
    } finally { projections.close(); history.close(); }
  }
}
