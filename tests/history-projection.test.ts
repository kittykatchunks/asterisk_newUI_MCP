import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openCelHistory } from "../src/cel-history.ts";
import { buildHistoryProjection, type ProjectionScope } from "../src/history-projection.ts";
import { distinctProjectionPaths, openHistoryProjections } from "../src/history-projection-store.ts";
import type { HistoryManifest } from "../src/history-manifest.ts";
import { historySha256 } from "../src/history-evidence.ts";

const execute = promisify(execFile);
const scope: ProjectionScope = { customer: "customer-a", runtime: "runtime-a", epoch: "boot-1" };
const source = { customer: scope.customer, source: "cel-a", generation: "stream-1", timeBasis: "UTC" };
const route = { context: "history-marker", extension: "entry", routeRevision: "marker-v1", entryKind: "synthetic" as const };
const journeyId = "11111111-1111-4111-8111-111111111111";
const visitId = "22222222-2222-4222-8222-222222222222";
const otherJourney = "33333333-3333-4333-8333-333333333333";
const otherVisit = "44444444-4444-4444-8444-444444444444";
const entryPayload = (id = journeyId) => ({ v: 1, journeyId: id, entryKind: "synthetic", routeRevision: route.routeRevision });
const visitPayload = (id = visitId, root = journeyId) =>
  ({ v: 1, journeyId: root, visitId: id, queue: "proof-queue", routeRevision: route.routeRevision });
function cel(event: string, payload?: unknown, uid = "same-id", linkedid = "same-linked", context = route.context) {
  return Buffer.from([event, "2026-10-25 01:30:00", `Local/test-${uid};2`, uid, linkedid, context, route.extension,
    payload === undefined ? "" : JSON.stringify({ extra: JSON.stringify(payload) })]
    .map((s) => `"${s.replaceAll('"', '""')}"`).join(",") + "\n");
}
const entry = (id = journeyId, uid = "same-id") => cel("HISTORY_ENTRY", entryPayload(id), uid);
const visit = (id = visitId, root = journeyId) => cel("HISTORY_QUEUE_VISIT", visitPayload(id, root));
const queue = (event: string, params: string, uid = "same-id") =>
  Buffer.from(`1792890000|${uid}|proof-queue|NONE|${event}|${params}\n`);
const entered = queue("ENTERQUEUE", "||1");
const timeout = queue("EXITWITHTIMEOUT", "1|1|2");
const call = () => [cel("CHAN_START"), entry(), cel("ANSWER"), visit(), cel("HANGUP"), cel("CHAN_END")];
async function fixture(action: (history: ReturnType<typeof openCelHistory>, historyPath: string,
  projectionPath: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "history-projection-"));
  const historyPath = join(directory, "history.sqlite");
  const history = openCelHistory(historyPath);
  try { await action(history, historyPath, join(directory, "projections.sqlite"), directory); }
  finally { history.close(); await rm(directory, { recursive: true }); }
}
function seed(history: ReturnType<typeof openCelHistory>, rows = call(), queued = [entered, timeout],
  selected = scope, celSource = source) {
  const raw = Buffer.concat(rows);
  const queueRaw = Buffer.concat(queued);
  history.ingest(celSource, raw);
  const ranges: HistoryManifest["ranges"] = [];
  if (raw.length) ranges.push({ kind: "cel", source: celSource.source, generation: celSource.generation, start: 0, end: raw.length });
  if (queueRaw.length) {
    history.queue.ingest({ customer: selected.customer, source: celSource.source, generation: celSource.generation }, queueRaw);
    ranges.push({ kind: "queue", source: celSource.source, generation: celSource.generation, start: 0, end: queueRaw.length });
  }
  history.manifests.register({ ...selected, operator: "projection-test", reason: "Bounded test fixture", routes: [route], ranges });
  return { raw, queueRaw };
}

test("JP-01/02/04: deterministic marked caller and timeout observations; no linkedid joins, totals or service inference", async () => {
  await fixture((history) => {
    seed(history, [...call(), cel("CHAN_START", undefined, "consultation"), cel("ANSWER", undefined, "consultation")]);
    const first = buildHistoryProjection(history, scope);
    assert.deepEqual(buildHistoryProjection(history, scope), first);
    assert.equal(first.document.journeys.length, 1);
    const root = first.document.journeys[0];
    assert.equal(root.entryKind, "synthetic");
    assert.equal(root.channel?.uniqueid, "same-id");
    assert.equal(root.channel?.answer, "observed");
    assert.equal(root.channel?.end, "observed");
    assert.equal(root.channel?.evidence.length, 6);
    assert.equal(root.visits[0].state, "timeout-observed");
    assert.equal(first.document.quality.service, "not-classified");
    assert.equal(first.document.quality.completeness, "unverified");
    assert.equal("totals" in first.document, false);
    assert.equal(first.document.issues.filter((i) => i.reason === "unattributed-cel-evidence").length, 2);
  });
  await fixture((history) => {
    const raw = Buffer.concat([cel("CHAN_START"),
      cel("HISTORY_ENTRY", { ...entryPayload(), entryKind: "external" }), cel("CHAN_END")]);
    history.ingest(source, raw);
    history.manifests.register({ ...scope, operator: "operator", reason: "Explicit external route assertion",
      routes: [{ ...route, entryKind: "external" }],
      ranges: [{ kind: "cel", source: source.source, generation: source.generation, start: 0, end: raw.length }] });
    assert.equal(buildHistoryProjection(history, scope).document.journeys[0].entryKind, "external");
  });
});

test("JP-02: equivalent duplicate markers retain every reference without multiplying roots or visits", async () => {
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), entry(), entry(), cel("ANSWER"), visit(), visit(), cel("CHAN_END")]);
    const { journeys } = buildHistoryProjection(history, scope).document;
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].state, "marked-caller-observed");
    assert.equal(journeys[0].entryEvidence.length, 2);
    assert.equal(journeys[0].visits.length, 1);
    assert.equal(journeys[0].visits[0].markerEvidence.length, 2);
    assert.equal(journeys[0].visits[0].state, "timeout-observed");
  });
});

test("JP-02: contradictory roots, two roots on one channel and cross-generation IDs never silently merge", async () => {
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), entry(), entry(otherJourney), entry(journeyId, "other-channel")]);
    const { journeys } = buildHistoryProjection(history, scope).document;
    assert.equal(journeys.length, 2);
    assert.ok(journeys.every((j) => j.state === "conflicting" && j.channel === null));
  });
  await fixture((history) => {
    seed(history);
    seed(history, call(), [], scope, { ...source, generation: "stream-2" });
    const { journeys } = buildHistoryProjection(history, scope).document;
    assert.equal(journeys.length, 1);
    assert.equal(journeys[0].state, "conflicting");
    assert.equal(journeys[0].channel, null);
  });
});

test("JP-03: repeated visit/entry candidates remain ambiguous instead of timestamp matched", async () => {
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), entry(), visit(), visit(otherVisit), cel("CHAN_END")], [entered, timeout, entered, timeout]);
    const { journeys, issues } = buildHistoryProjection(history, scope).document;
    assert.equal(journeys[0].visits.length, 2);
    assert.ok(journeys[0].visits.every((v) => v.state === "unresolved"));
    assert.equal(issues.filter((i) => i.reason === "ambiguous-or-missing-queue-entry").length, 2);
  });
  await fixture((history) => {
    seed(history, call(), [entered, entered, timeout]);
    assert.equal(buildHistoryProjection(history, scope).document.journeys[0].visits[0].state, "unresolved");
  });
});

test("JP-03/04: orphan, pre-root and post-end visits cannot acquire queue entries", async () => {
  for (const rows of [
    [cel("CHAN_START"), visit(), entry(), cel("CHAN_END")],
    [cel("CHAN_START"), entry(), cel("CHAN_END"), visit()],
    [cel("CHAN_START"), visit(), cel("CHAN_END")],
  ]) await fixture((history) => {
    seed(history, rows);
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys.flatMap((j) => j.visits).length, 0);
    assert.ok(built.issues.some((i) => i.reason === "unresolved-visit-root"));
  });
});

test("JP-04: unsupported, malformed, duplicate and out-of-order queue terminals stay explicit", async () => {
  for (const [queued, state] of [
    [[entered], "entry-observed"], [[entered, timeout, timeout], "conflicting"],
    [[entered, queue("CONNECT", "1|member-id|0")], "unresolved"],
    [[entered, queue("EXITWITHTIMEOUT", "bad|1|2")], "unresolved"],
    [[timeout, entered], "unresolved"], [[queue("ENTERQUEUE", "||bad"), timeout], "unresolved"],
  ] as const) await fixture((history) => {
    seed(history, call(), [...queued]);
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys[0].visits[0].state, state);
    assert.equal(built.quality.service, "not-classified");
  });
});

test("JP-01/04: unassigned and invalid markers stay unresolved; answer and end absence is not a negative outcome", async () => {
  await fixture((history) => {
    const { raw } = seed(history, [cel("CHAN_START"), entry(), visit()], []);
    history.ingest(source, Buffer.concat([raw, cel("CHAN_END"), cel("HISTORY_ENTRY", { ...entryPayload(), v: 2 })]));
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys[0].channel?.answer, "not-observed");
    assert.equal(built.journeys[0].channel?.end, "not-observed");
    assert.equal(built.issues.filter((i) => i.reason === "unassigned-evidence").length, 2);
    assert.equal(built.journeys[0].visits[0].state, "unresolved");
  });
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), cel("HISTORY_ENTRY", { ...entryPayload(), v: 2 }), cel("CHAN_END")], []);
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys.length, 0);
    assert.ok(built.issues.some((i) => i.reason === "marker-invalid-marker"));
    assert.equal(built.quality.noMarkedRoots, true);
  });
});

test("JP-01/04: source gaps survive projection and local collector recovery never proves queue coverage", async () => {
  await fixture((history, _historyPath, _projectionPath, directory) => {
    seed(history);
    history.configureCollector({ ...source, path: join(directory, "Master.csv"), staleAfterMs: 1000 }, 1000);
    history.transitionCollector(scope.customer, source.source, "replacement", "operator", "Unknown coverage", 2000);
    const built = buildHistoryProjection(history, scope);
    assert.equal(built.document.input.coverage[0].gaps.length, 1);
    assert.equal(built.document.input.coverage[0].association, "possibly-applicable");
    assert.equal(built.document.quality.queueCoverage, "not-collected");
    assert.deepEqual(buildHistoryProjection(history, scope), built);
    const attempt = history.beginCollection(scope.customer, source.source, 3000);
    history.completeCollection(scope.customer, source.source, attempt.revision, Buffer.alloc(0), 3001);
    assert.equal(history.collectorStatus(scope.customer, source.source, 3002).status, "healthy");
    const recovered = buildHistoryProjection(history, scope);
    assert.equal(recovered.document.input.coverage[0].gaps.length, 1);
    assert.equal(recovered.document.input.coverage[0].outcome, "success");
    assert.equal(recovered.document.quality.queueCoverage, "not-collected");
    history.configureCollector({ ...source, source: "unknown-source", path: join(directory, "other.csv"), staleAfterMs: 1000 }, 1000);
    history.transitionCollector(scope.customer, "unknown-source", "replacement", "operator", "Unknown source gap", 2000);
    assert.equal(buildHistoryProjection(history, scope).document.input.coverage.find((c) => c.source === "unknown-source")?.association,
      "association-unknown");
  });
});

test("JP-05: atomic immutable revisions, replay reuse, late input and stable entity IDs", async () => {
  await fixture((history, _historyPath, projectionPath) => {
    const { raw } = seed(history, [cel("CHAN_START"), entry(), cel("ANSWER"), visit()]);
    const store = openHistoryProjections(projectionPath);
    try {
      const first = store.rebuild(history, scope);
      assert.equal(first.reused, false);
      assert.equal(store.rebuild(history, scope).id, first.id);
      assert.equal(store.rebuild(history, scope).reused, true);
      const before = buildHistoryProjection(history, scope);
      const appended = cel("CHAN_END");
      history.ingest(source, Buffer.concat([raw, appended]));
      history.manifests.register({ ...scope, operator: "operator", reason: "Late channel evidence", routes: [route],
        ranges: [{ kind: "cel", source: source.source, generation: source.generation, start: raw.length, end: raw.length + appended.length }] });
      const next = store.rebuild(history, scope);
      assert.notEqual(next.id, first.id);
      assert.notEqual(next.inputSha256, first.inputSha256);
      const after = buildHistoryProjection(history, scope);
      assert.equal(before.document.journeys[0].id, after.document.journeys[0].id);
      assert.equal(before.document.journeys[0].visits[0].id, after.document.journeys[0].visits[0].id);
      assert.equal(after.document.journeys[0].channel?.end, "observed");
      assert.deepEqual(store.read(scope, first.id).document, before.document);
      const page = store.revisions(scope, 0, 1);
      assert.equal(page.nextAfterId, first.id);
      assert.equal(store.revisions(scope, first.id, 1).revisions[0].id, next.id);
    } finally { store.close(); }
    const reader = openHistoryProjections(projectionPath, { readOnly: true });
    try {
      assert.equal(reader.revisions(scope).revisions.length, 2);
      assert.throws(() => reader.rebuild(history, scope), /writable/);
      assert.throws(() => reader.read({ ...scope, customer: "customer-b" }), /not found/);
    } finally { reader.close(); }
  });
});

test("JP-05/06: failed publication and corrupt history never replace last good projection", async () => {
  await fixture((history, historyPath, projectionPath) => {
    const { raw } = seed(history);
    const projections = openHistoryProjections(projectionPath);
    const db = new DatabaseSync(projectionPath);
    const rawDb = new DatabaseSync(historyPath);
    try {
      const first = projections.rebuild(history, scope);
      history.ingest(source, Buffer.concat([raw, cel("LINKEDID_END")]));
      db.exec("CREATE TRIGGER fail_publish BEFORE INSERT ON projection_revisions BEGIN SELECT RAISE(ABORT,'injected publish failure'); END;");
      assert.throws(() => projections.rebuild(history, scope), /injected publish/);
      assert.equal(projections.read(scope).id, first.id);
      assert.equal(projections.revisions(scope).revisions.length, 1);
      db.exec("DROP TRIGGER fail_publish");
      rawDb.exec("UPDATE cel_sources SET prefix_sha256='" + "0".repeat(64) + "'");
      assert.throws(() => projections.rebuild(history, scope), /checkpoint/);
      assert.equal(projections.read(scope).id, first.id);
      db.exec("UPDATE projection_revisions SET document='{}'");
      assert.throws(() => projections.read(scope), /Corrupt/);
      assert.throws(() => projections.revisions(scope), /Corrupt/);
    } finally { rawDb.close(); db.close(); projections.close(); }
  });
});

test("JP-01/06: a consistent read snapshot survives concurrent append; nested/async callbacks fail explicitly", async () => {
  await fixture((history, historyPath) => {
    const { raw } = seed(history);
    const writer = new DatabaseSync(historyPath);
    // WAL is used only in this owned fixture to allow a second writer while a
    // reader is open; production history retains its existing DELETE journal.
    writer.exec("PRAGMA journal_mode=WAL");
    const reader = openCelHistory(historyPath, { readOnly: true });
    try {
      reader.readSnapshot(() => {
        const before = reader.read(source);
        writer.exec("BEGIN IMMEDIATE");
        writer.prepare("INSERT INTO cel_events SELECT source,generation,?, ?,uniqueid,raw,sha256,ingested_at FROM cel_events WHERE offset=0")
          .run(raw.length, raw.length + cel("CHAN_START").length);
        writer.prepare("UPDATE cel_sources SET consumed_bytes=?,prefix_sha256=?").run(
          raw.length + cel("CHAN_START").length, historySha256(Buffer.concat([raw, cel("CHAN_START")])));
        writer.exec("COMMIT");
        assert.deepEqual(reader.read(source), before);
        assert.throws(() => reader.readSnapshot(() => undefined), /nested/);
      });
      assert.throws(() => reader.readSnapshot(() => Promise.resolve()), /synchronous/);
      assert.equal(reader.read(source).events.length, call().length + 1);
    } finally { reader.close(); writer.close(); }
  });
});

test("JP-06: bounds, database identity, foreign runtime and customer scopes fail explicitly", async () => {
  await fixture((history, historyPath, projectionPath) => {
    seed(history);
    assert.throws(() => buildHistoryProjection(history, { ...scope, customer: "customer-b" }), /scope not found/);
    assert.throws(() => buildHistoryProjection(history, { ...scope, runtime: "other" }), /scope not found/);
    assert.throws(() => openHistoryProjections(historyPath), /Not a supported/);
    assert.throws(() => distinctProjectionPaths(historyPath, historyPath), /distinct/);
    assert.throws(() => openHistoryProjections("relative.sqlite"), /absolute/);
    const store = openHistoryProjections(projectionPath);
    try {
      store.rebuild(history, scope);
      assert.throws(() => store.revisions(scope, 0, 201), /page/);
      assert.throws(() => store.read(scope, 0), /revision ID/);
    } finally { store.close(); }
    history.ingest(source, Buffer.concat([Buffer.concat(call()), ...Array.from({ length: 2001 }, () => cel("ANSWER"))]));
    assert.throws(() => buildHistoryProjection(history, scope), /input limit/);
  });
});

test("JP-05/06: competing CLI rebuilds persist one revision and read commands disclose stale inputs", async () => {
  await fixture(async (history, historyPath, projectionPath, directory) => {
    const { raw } = seed(history);
    const command = (action: string, ...args: string[]) => execute(process.execPath,
      ["scripts\\Manage-HistoryProjection.ts", action, historyPath, projectionPath, scope.customer, scope.runtime, scope.epoch, ...args]);
    const results = await Promise.allSettled([command("rebuild"), command("rebuild")]);
    const successes = results.map((result) => { if (result.status === "rejected") throw result.reason; return result.value; });
    const first = JSON.parse(successes[0].stdout);
    assert.equal(first.id, JSON.parse(successes[1].stdout).id);
    assert.equal(JSON.parse((await command("read", "latest")).stdout).freshness.state, "inputs-match");
    history.ingest(source, Buffer.concat([raw, cel("LINKEDID_END")]));
    const stale = JSON.parse((await command("read", String(first.id))).stdout);
    assert.equal(stale.freshness.state, "inputs-changed");
    const next = JSON.parse((await command("rebuild")).stdout);
    assert.notEqual(next.id, first.id);
    assert.equal(JSON.parse((await command("revisions", "0", "1")).stdout).nextAfterId, first.id);
    const offline = (action: string, ...args: string[]) => execute(process.execPath,
      ["scripts\\Manage-HistoryProjection.ts", action, join(directory, "unavailable-history.sqlite"), projectionPath,
        scope.customer, scope.runtime, scope.epoch, ...args]);
    const stored = JSON.parse((await offline("stored", String(first.id))).stdout);
    assert.equal(stored.id, first.id);
    assert.equal(stored.freshness.state, "not-checked");
    assert.equal(JSON.parse((await offline("revisions", "0", "100")).stdout).revisions.length, 2);
    await assert.rejects(offline("read", "latest"));
    await assert.rejects(command("read", "0"));
    await assert.rejects(command("revisions", "0", "201"));
  });
});

test("JP-02/03/06: conflicting visit IDs, unsupported caller relationships and contradictory lifecycle remain explicit", async () => {
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), entry(), visit(),
      cel("HISTORY_QUEUE_VISIT", { ...visitPayload(), queue: "other-queue" }), cel("BLINDTRANSFER"), cel("CHAN_END")]);
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys[0].visits[0].state, "conflicting");
    assert.ok(built.issues.some((i) => i.reason === "unsupported-caller-cel-evidence"));
  });
  await fixture((history) => {
    seed(history, [cel("CHAN_START"), entry(), cel("CHAN_END"), cel("ANSWER"), visit()]);
    const built = buildHistoryProjection(history, scope).document;
    assert.equal(built.journeys[0].state, "conflicting");
    assert.equal(built.journeys[0].visits.length, 0);
  });
});

test("JP-06: equal UUID/channel IDs across runtime, epoch and customer scopes remain separate", async () => {
  await fixture((history) => {
    seed(history);
    for (const [suffix, selected] of [
      ["other-runtime", { ...scope, runtime: "runtime-b" }],
      ["other-epoch", { ...scope, epoch: "boot-2" }],
      ["other-customer", { ...scope, customer: "customer-b" }],
    ] as const) {
      seed(history, call(), [entered, timeout], selected, { ...source, customer: selected.customer, source: suffix });
      const root = buildHistoryProjection(history, selected).document.journeys[0];
      assert.equal(root.state, "marked-caller-observed");
      assert.notEqual(root.id, buildHistoryProjection(history, scope).document.journeys[0].id);
      assert.equal(root.visits[0].state, "timeout-observed");
    }
  });
  await fixture((history) => {
    const { raw, queueRaw } = seed(history);
    history.ingest(source, Buffer.concat([raw, raw]));
    history.queue.ingest(source, Buffer.concat([queueRaw, queueRaw]));
    const second = { ...scope, epoch: "boot-2" };
    history.manifests.register({ ...second, operator: "operator", reason: "Explicit second boot in the same generation",
      routes: [route], ranges: [
        { kind: "cel", source: source.source, generation: source.generation, start: raw.length, end: raw.length * 2 },
        { kind: "queue", source: source.source, generation: source.generation, start: queueRaw.length, end: queueRaw.length * 2 },
      ] });
    const first = buildHistoryProjection(history, scope).document.journeys[0];
    const next = buildHistoryProjection(history, second).document.journeys[0];
    assert.equal(first.state, "marked-caller-observed");
    assert.equal(next.state, "marked-caller-observed");
    assert.notEqual(first.id, next.id);
    assert.equal(first.visits[0].state, "timeout-observed");
    assert.equal(next.visits[0].state, "timeout-observed");
  });
});

test("JP-06: exact source/record bounds pass and excessive fanout or source count fails without partial publication", async () => {
  await fixture((history) => {
    seed(history);
    for (let i = 1; i < 20; i++) history.ingest({ ...source, source: `source-${i}` }, Buffer.alloc(0));
    assert.equal(buildHistoryProjection(history, scope).document.input.checkpoints.length, 21);
    history.ingest({ ...source, source: "source-20" }, Buffer.alloc(0));
    assert.throws(() => buildHistoryProjection(history, scope), /source limit/);
  });
  await fixture((history) => {
    seed(history, [...call(), ...Array.from({ length: 1992 }, () => cel("LINKEDID_END", undefined, "other-id"))]);
    assert.ok(buildHistoryProjection(history, scope).document);
    const extra = cel("LINKEDID_END", undefined, "other-id");
    const previous = Buffer.concat([...call(), ...Array.from({ length: 1992 }, () => extra)]);
    history.ingest(source, Buffer.concat([previous, extra]));
    assert.throws(() => buildHistoryProjection(history, scope), /input limit/);
  });
  await fixture((history) => {
    const visits = Array.from({ length: 200 }, (_, i) => visit(`${i.toString(16).padStart(8, "0")}-2222-4222-8222-222222222222`));
    seed(history, [cel("CHAN_START"), entry(), ...visits, cel("CHAN_END")], Array(200).fill(entered));
    assert.throws(() => buildHistoryProjection(history, scope), /output reference limit/);
  });
});
