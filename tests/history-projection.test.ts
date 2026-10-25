import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openCelHistory } from "../src/cel-history.ts";
import { buildHistoryProjection, PROJECTION_ALGORITHM, type ProjectionScope } from "../src/history-projection.ts";
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

const memberUid = "member-id";
const servedQueue = (event: string, params: string, member = "synthetic-member", uid = "same-id") =>
  Buffer.from(`1792890000|${uid}|proof-queue|${member}|${event}|${params}\n`);
const connect = () => servedQueue("CONNECT", `0|${memberUid}|0`);
const complete = () => servedQueue("COMPLETEAGENT", "0|2|1");
const memberRows = () => ["CHAN_START", "ANSWER", "HANGUP", "CHAN_END"].map((event) => cel(event, undefined, memberUid));
const projectedVisit = (history: ReturnType<typeof openCelHistory>) =>
  buildHistoryProjection(history, scope).document.journeys.find((j) => j.journeyId === journeyId)!.visits[0];

test("QS-02/03: independent queue CONNECT, exact member answer/end and COMPLETEAGENT observations; no human/media outcome", async () => {
  await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), complete()]);
    const built = buildHistoryProjection(history, scope);
    const root = built.document.journeys[0], visit = root.visits[0];
    assert.equal(built.document.algorithm, PROJECTION_ALGORITHM);
    assert.equal(built.document.journeys.length, 1);
    assert.equal(root.channel?.answer, "observed");
    assert.equal(root.channel.evidence.length, 6);
    assert.equal(visit.state, "completion-observed");
    assert.deepEqual(visit.service, { connection: "observed", memberCorrelation: "answered-channel-observed",
      memberUniqueid: memberUid, memberChannelEnd: "observed", completion: "member-ended-queue-service-observed",
      queueEvidence: visit.queueEvidence.slice(1),
      memberEvidence: history.read({ ...source, uniqueid: memberUid }).events.map((e) =>
        ({ kind: "cel", source: source.source, generation: source.generation, offset: e.offset, sha256: e.sha256 })) });
    assert.equal(built.document.quality.service, "not-classified");
    assert.equal(built.document.quality.completeness, "unverified");
    assert.equal(built.document.quality.attribution, "explicit-marked-caller-only");
    assert.equal("humanAnswer" in visit.service, false);
    assert.equal("duration" in visit.service, false);
    assert.equal("totals" in built.document, false);
    assert.deepEqual(buildHistoryProjection(history, scope), built);
  });
  await fixture((history) => {
    seed(history, [...call(), ...memberRows().slice(0, 2)], [entered, connect()]);
    assert.equal(projectedVisit(history).state, "connection-observed");
    assert.equal(projectedVisit(history).service.memberCorrelation, "answered-channel-observed");
    assert.equal(projectedVisit(history).service.memberChannelEnd, "not-observed");
    assert.equal(projectedVisit(history).service.completion, "not-observed");
  });
});

test("QS-03/05: missing, foreign-customer, runtime, epoch, generation and unassigned member evidence cannot supply an answer", async () => {
  for (const location of ["absent", "customer", "runtime", "epoch", "generation", "source", "unassigned"] as const) {
    await fixture((history) => {
      const { raw } = seed(history, call(), [entered, connect(), complete()]);
      if (location === "unassigned") history.ingest(source, Buffer.concat([raw, ...memberRows()]));
      else if (location !== "absent") {
        const selected = { ...scope, ...(location === "customer" ? { customer: "customer-b" } :
          location === "runtime" ? { runtime: "runtime-b" } : location === "epoch" ? { epoch: "boot-2" } : {}) };
        const separateSource = { ...source, customer: selected.customer,
          source: location === "generation" ? source.source : "member-cel",
          ...(location === "generation" ? { generation: "stream-2" } : {}) };
        seed(history, memberRows(), [], selected, separateSource);
      }
      const service = projectedVisit(history).service;
      assert.equal(service.connection, "observed", location);
      assert.equal(service.memberCorrelation, "unresolved", location);
      assert.equal(service.completion, "member-ended-queue-service-observed", location);
      assert.equal(service.memberChannelEnd, "not-observed", location);
    });
  }
  for (const rows of [[cel("ANSWER", undefined, memberUid)], [cel("CHAN_START", undefined, memberUid)],
    [cel("CHAN_START", undefined, memberUid), cel("CHAN_END", undefined, memberUid)]]) await fixture((history) => {
    seed(history, [...call(), ...rows], [entered, connect(), complete()]);
    assert.equal(projectedVisit(history).service.memberCorrelation, "unresolved");
  });
});

test("QS-05: identical complete caller/member IDs in separate customer/runtime/epoch scopes do not compete or join", async () => {
  await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), complete()]);
    const original = buildHistoryProjection(history, scope).document.journeys[0];
    for (const selected of [{ ...scope, customer: "customer-b" }, { ...scope, runtime: "runtime-b" }]) {
      const otherSource = { ...source, customer: selected.customer, source: `cel-${selected.customer}-${selected.runtime}` };
      seed(history, [...call(), ...memberRows()], [entered, connect(), complete()], selected, otherSource);
      const root = buildHistoryProjection(history, selected).document.journeys[0];
      assert.notEqual(root.id, original.id);
      assert.equal(root.visits[0].service.memberCorrelation, "answered-channel-observed");
      assert.ok(root.visits[0].service.memberEvidence.every((r) => r.source === otherSource.source));
      assert.equal(projectedVisit(history).service.memberCorrelation, "answered-channel-observed");
    }
  });
  await fixture((history) => {
    const { raw, queueRaw } = seed(history, [...call(), ...memberRows()], [entered, connect(), complete()]);
    history.ingest(source, Buffer.concat([raw, raw]));
    history.queue.ingest(source, Buffer.concat([queueRaw, queueRaw]));
    const second = { ...scope, epoch: "boot-2" };
    history.manifests.register({ ...second, operator: "test", reason: "Second explicit epoch with identical synthetic IDs",
      routes: [route], ranges: [
        { kind: "cel", source: source.source, generation: source.generation, start: raw.length, end: raw.length * 2 },
        { kind: "queue", source: source.source, generation: source.generation, start: queueRaw.length, end: queueRaw.length * 2 },
      ] });
    const original = buildHistoryProjection(history, scope).document.journeys[0];
    const next = buildHistoryProjection(history, second).document.journeys[0];
    assert.notEqual(original.id, next.id);
    assert.equal(original.visits[0].service.memberCorrelation, "answered-channel-observed");
    assert.equal(next.visits[0].service.memberCorrelation, "answered-channel-observed");
    assert.ok(original.visits[0].service.memberEvidence.every((r) => r.offset < raw.length));
    assert.ok(next.visits[0].service.memberEvidence.every((r) => r.offset >= raw.length));
  });
});

test("QS-03/05: ambiguous/reused/root/caller member IDs and contradictory member lifecycle stay conflicting", async () => {
  for (const problem of ["duplicate-start", "duplicate-answer", "duplicate-end", "two-streams", "reused-connect", "root", "caller",
    "answer-before-start", "end-before-answer", "changed-channel"] as const) {
    await fixture((history) => {
      let member = memberRows();
      let queued = [entered, connect(), complete()];
      if (problem === "duplicate-start") member.push(cel("CHAN_START", undefined, memberUid));
      if (problem === "duplicate-answer") member.push(cel("ANSWER", undefined, memberUid));
      if (problem === "duplicate-end") member.push(cel("CHAN_END", undefined, memberUid));
      if (problem === "root") member.splice(1, 0, entry(otherJourney, memberUid));
      if (problem === "caller") queued = [entered, servedQueue("CONNECT", "0|same-id|0"), complete()];
      if (problem === "answer-before-start") member = [member[1], member[0], member[3]];
      if (problem === "end-before-answer") member = [member[0], member[3], member[1]];
      if (problem === "changed-channel") member.push(Buffer.from(cel("BRIDGE_ENTER", undefined, memberUid).toString().replace("Local/test-", "PJSIP/")));
      if (problem === "reused-connect") queued.push(servedQueue("CONNECT", `1|${memberUid}|1`, "another-member", "another-caller"));
      seed(history, [...call(), ...member], queued);
      if (problem === "two-streams") seed(history, memberRows(), [], scope, { ...source, generation: "stream-2" });
      const visit = projectedVisit(history);
      assert.equal(visit.service.connection, "observed", problem);
      assert.equal(visit.service.memberCorrelation, "conflicting", problem);
      assert.equal(visit.state, "conflicting", problem);
      assert.equal(visit.service.completion, "member-ended-queue-service-observed", problem);
    });
  }
});

test("QS-03/05: CONNECT exact shapes/order/uniqueness are required; timestamps and linkedid cannot rescue malformed identity", async () => {
  const invalid = [
    [entered, servedQueue("CONNECT", `0|${memberUid}`)],
    [entered, servedQueue("CONNECT", `0|${memberUid}|0|extra`)],
    [entered, servedQueue("CONNECT", `-1|${memberUid}|0`)],
    [entered, servedQueue("CONNECT", `1.5|${memberUid}|0`)],
    [entered, servedQueue("CONNECT", `0|${memberUid}|9007199254740992`)],
    [entered, servedQueue("CONNECT", `0|${memberUid}|01`)],
    [entered, servedQueue("CONNECT", "0||0")],
    [entered, servedQueue("CONNECT", "0| |0")],
    [entered, servedQueue("CONNECT", "0|NONE|0")],
    [entered, servedQueue("CONNECT", `0|${memberUid}|0`, "NONE")],
    [connect(), entered],
    [entered, complete()],
  ];
  for (const queued of invalid) await fixture((history) => {
    seed(history, [...call(), ...memberRows()], queued);
    const visit = projectedVisit(history);
    assert.equal(visit.state, "unresolved");
    assert.equal(visit.service.connection, "unresolved");
    assert.notEqual(visit.service.memberCorrelation, "answered-channel-observed");
    assert.notEqual(visit.service.completion, "member-ended-queue-service-observed");
  });
  await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), connect(), complete()]);
    assert.equal(projectedVisit(history).service.connection, "conflicting");
    assert.equal(projectedVisit(history).state, "conflicting");
  });
  await fixture((history) => {
    assert.throws(() => seed(history, [...call(), ...memberRows()],
      [entered, servedQueue("CONNECT", `0|${memberUid}|0`, "")]), /Invalid queue record/);
  });
});

test("QS-03/05: completion is independent and requires ordered same-stream same-member exact supported shape", async () => {
  for (const end of [
    servedQueue("COMPLETEAGENT", "0|2|1", "wrong-member"), servedQueue("COMPLETEAGENT", "0|2"),
    servedQueue("COMPLETEAGENT", "0|2|0"), servedQueue("COMPLETEAGENT", "0|2|-1"),
    servedQueue("COMPLETEAGENT", "0|2|1|extra"), servedQueue("COMPLETEAGENT", "0|9007199254740992|1"),
    servedQueue("COMPLETECALLER", "0|2|1"), servedQueue("ABANDON", "1|1|2"), timeout,
  ]) await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), end]);
    const service = projectedVisit(history).service;
    assert.equal(service.connection, "observed");
    assert.equal(service.memberCorrelation, "answered-channel-observed");
    assert.equal(service.completion, "unresolved");
  });
  await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, complete(), connect()]);
    assert.equal(projectedVisit(history).service.completion, "unresolved");
  });
  await fixture((history) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), complete(), complete()]);
    assert.equal(projectedVisit(history).service.completion, "conflicting");
    assert.equal(projectedVisit(history).state, "conflicting");
  });
});

test("QS-03/05: cross-stream queue CONNECT/completion do not acquire same-ID visit evidence", async () => {
  for (const split of ["CONNECT", "COMPLETEAGENT"] as const) await fixture((history) => {
    seed(history, [...call(), ...memberRows()], split === "CONNECT" ? [entered] : [entered, connect()]);
    seed(history, [], split === "CONNECT" ? [connect(), complete()] : [complete()], scope, { ...source, source: "queue-b" });
    const service = projectedVisit(history).service;
    if (split === "CONNECT") assert.equal(service.connection, "unresolved");
    else {
      assert.equal(service.connection, "observed");
      assert.equal(service.completion, "unresolved");
    }
  });
});

test("QS-04/05: late member evidence appends immutable service revision, stable IDs, replay and retained independent gaps", async () => {
  await fixture((history, _historyPath, projectionPath, directory) => {
    const { raw } = seed(history, call(), [entered, connect(), complete()]);
    history.queue.collectors.configure({ customer: scope.customer, source: source.source, generation: source.generation,
      path: join(directory, "queue_log"), staleAfterMs: 1000 }, 1000);
    history.queue.collectors.transition(scope.customer, source.source, "replacement", "operator", "Unknown queue coverage", 2000);
    const projections = openHistoryProjections(projectionPath);
    let before: ReturnType<typeof buildHistoryProjection>["document"];
    let after: ReturnType<typeof buildHistoryProjection>["document"];
    let oldId: number;
    try {
      const first = projections.rebuild(history, scope);
      oldId = first.id;
      before = buildHistoryProjection(history, scope).document;
      assert.equal(before.journeys[0].visits[0].service.memberCorrelation, "unresolved");
      assert.equal(projections.rebuild(history, scope).id, oldId);
      const appended = Buffer.concat([raw, ...memberRows()]);
      history.ingest(source, appended);
      history.manifests.register({ ...scope, operator: "operator", reason: "Explicit late member evidence",
        routes: [], ranges: [{ kind: "cel", source: source.source, generation: source.generation, start: raw.length, end: appended.length }] });
      const next = projections.rebuild(history, scope);
      after = buildHistoryProjection(history, scope).document;
      assert.ok(next.id > oldId);
      assert.notEqual(next.inputSha256, first.inputSha256);
      assert.equal(after.journeys[0].visits[0].service.memberCorrelation, "answered-channel-observed");
      assert.equal(after.journeys[0].id, before.journeys[0].id);
      assert.equal(after.journeys[0].visits[0].id, before.journeys[0].visits[0].id);
      assert.equal(after.input.coverage[0].gaps.length, 1);
      assert.equal(after.input.coverage[0].association, "possibly-applicable");
      assert.equal(after.quality.queueCoverage, "unverified");
      assert.equal(projections.rebuild(history, scope).id, next.id);
      assert.deepEqual(projections.read(scope, oldId).document, before);
    } finally { projections.close(); }
    const reopened = openHistoryProjections(projectionPath, { readOnly: true });
    try {
      assert.deepEqual(reopened.read(scope, oldId!).document, before!);
      assert.deepEqual(reopened.read(scope).document, after!);
    } finally { reopened.close(); }
  });
});

test("QS-04/05: v1/v2 documents without service fields remain readable byte-for-byte; v3 rebuild preserves entity keys", async () => {
  for (const algorithm of ["marked-caller-v1", "marked-caller-v2"]) await fixture((history, _historyPath, path) => {
    seed(history, [...call(), ...memberRows()], [entered, connect(), complete()]);
    const projections = openHistoryProjections(path);
    const built = buildHistoryProjection(history, scope);
    const legacy = JSON.parse(JSON.stringify(built.document));
    legacy.algorithm = algorithm; legacy.input.algorithm = algorithm;
    for (const root of legacy.journeys) for (const visit of root.visits) {
      delete visit.service;
      visit.state = "unresolved";
    }
    if (algorithm === "marked-caller-v1") {
      delete legacy.input.queueCollectionCapability;
      for (const coverage of legacy.input.coverage) delete coverage.kind;
    }
    const text = JSON.stringify(legacy);
    const db = new DatabaseSync(path);
    try {
      const inserted = db.prepare(`INSERT INTO projection_revisions
        (customer,runtime,epoch,algorithm,input_sha256,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)`)
        .run(scope.customer, scope.runtime, scope.epoch, algorithm, historySha256(Buffer.from(JSON.stringify(legacy.input))),
          text, historySha256(Buffer.from(text)), "2026-10-25T00:00:00.000Z");
      const oldId = Number(inserted.lastInsertRowid);
      assert.equal(projections.read(scope).algorithm, algorithm);
      assert.deepEqual(projections.read(scope).document, legacy);
      const next = projections.rebuild(history, scope);
      assert.ok(next.id > oldId);
      assert.equal(next.algorithm, "marked-caller-v3");
      assert.equal(built.document.journeys[0].id, legacy.journeys[0].id);
      assert.equal(built.document.journeys[0].visits[0].id, legacy.journeys[0].visits[0].id);
      assert.deepEqual(projections.read(scope, oldId).document, legacy);
      assert.equal(db.prepare("SELECT document FROM projection_revisions WHERE id=?").get(oldId)?.document, text);
      assert.equal(projections.rebuild(history, scope).id, next.id);
    } finally { db.close(); projections.close(); }
  });
});

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
