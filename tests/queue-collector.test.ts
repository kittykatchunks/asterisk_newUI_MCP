import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openCelHistory } from "../src/cel-history.ts";
import { collectQueueOnce, QueueAttemptConflict } from "../src/queue-collector.ts";
import { HISTORY_SNAPSHOT_LIMIT, historySha256 } from "../src/history-evidence.ts";
import { buildHistoryProjection } from "../src/history-projection.ts";
import { openHistoryProjections } from "../src/history-projection-store.ts";

const execute = promisify(execFile);
const scope = { customer: "customer-a", source: "pbx-a", generation: "first" };
const projectionScope = { customer: scope.customer, runtime: "runtime-a", epoch: "boot-1" };
const record = (event = "ENTERQUEUE") => Buffer.from(`1792890000|same-id|proof-queue|NONE|${event}|${event === "ENTERQUEUE" ? "||1" : "1|1|2"}\n`);
const cel = Buffer.from('"CHAN_START","2026-10-25 01:30:00","Local/test;2","same-id","same-linked","proof","queue",""\n');
const config = (path: string) => ({ ...scope, path, staleAfterMs: 1000 });
async function fixture(action: (store: ReturnType<typeof openCelHistory>, database: string, path: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "queue-collector-"));
  const database = join(directory, "history.sqlite");
  const store = openCelHistory(database);
  try { await action(store, database, join(directory, "queue_log"), directory); }
  finally { store.close(); await rm(directory, { recursive: true }); }
}
function manifest(store: ReturnType<typeof openCelHistory>, end: number) {
  return store.manifests.register({ ...projectionScope, operator: "operator-test", reason: "Known isolated test stream",
    routes: [], ranges: [{ kind: "queue", source: scope.source, generation: scope.generation, start: 0, end }] });
}

test("QR-01: schema-4 migration preserves raw evidence, manifests and CEL collector/gaps without assigning queue health", async () => {
  await fixture((store, database, path) => {
    store.ingest({ ...scope, timeBasis: "UTC" }, cel);
    store.queue.ingest(scope, record());
    manifest(store, record().length);
    store.configureCollector({ ...config(path), timeBasis: "UTC" }, 1000);
    store.transitionCollector(scope.customer, scope.source, "second", "operator", "CEL gap", 2000);
    const before = { cel: store.read(scope), queue: store.queue.read(scope), manifests: store.manifests.list(scope.customer),
      collector: store.collectorStatus(scope.customer, scope.source, 3000), gaps: store.collectionGaps(scope.customer, scope.source) };
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE queue_collection_gaps; DROP TABLE queue_collectors; PRAGMA user_version=4");
    db.close();
    const legacy = openCelHistory(database, { readOnly: true });
    try {
      assert.equal(legacy.queue.collectors.supported, false);
      assert.throws(() => legacy.queue.collectors.status(scope.customer, scope.source), /schema 5/);
      assert.deepEqual(legacy.queue.read(scope), before.queue);
      assert.deepEqual(legacy.manifests.list(scope.customer), before.manifests);
      assert.equal(buildHistoryProjection(legacy, projectionScope).document.quality.queueCoverage, "unavailable-legacy-schema");
    } finally { legacy.close(); }
    const migrated = openCelHistory(database);
    try {
      assert.deepEqual(migrated.read(scope), before.cel);
      assert.deepEqual(migrated.queue.read(scope), before.queue);
      assert.deepEqual(migrated.manifests.list(scope.customer), before.manifests);
      assert.deepEqual(migrated.collectorStatus(scope.customer, scope.source, 3000), before.collector);
      assert.deepEqual(migrated.collectionGaps(scope.customer, scope.source), before.gaps);
      assert.deepEqual(migrated.queue.collectors.sources(scope.customer), []);
      assert.equal(migrated.queue.collectors.supported, true);
    } finally { migrated.close(); }
  });
});

test("QR-01: failed schema-5 migration rolls back completely and old queue evidence remains readable", async () => {
  await fixture((store, database) => {
    store.queue.ingest(scope, record());
    const before = store.queue.read(scope);
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE queue_collection_gaps; DROP TABLE queue_collectors; PRAGMA user_version=4; CREATE TABLE queue_collection_gaps(blocker TEXT)");
    db.close();
    assert.throws(() => openCelHistory(database), /already exists/);
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 4);
      assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='queue_collectors'").get()?.count, 0);
    } finally { check.close(); }
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.deepEqual(reader.queue.read(scope), before); }
    finally { reader.close(); }
  });
});

test("QR-02/03: immutable configuration, exact freshness, pending tails and clock skew are explicit", async () => {
  await fixture((store, _database, path) => {
    const collectors = store.queue.collectors;
    const initial = collectors.configure(config(path), 1000);
    assert.deepEqual(collectors.configure(config(path), 1001), initial);
    assert.equal(collectors.status(scope.customer, scope.source, 1000).status, "never-collected");
    for (const change of [{ generation: "other" }, { path: `${path}.other` }, { staleAfterMs: 1001 }]) {
      assert.throws(() => collectors.configure({ ...config(path), ...change }, 1002), /immutable/);
    }
    for (const change of [{ path: "relative" }, { staleAfterMs: 999 }, { staleAfterMs: 86400001 }]) {
      assert.throws(() => collectors.configure({ ...config(path), ...change }));
    }
    const attempt = collectors.begin(scope.customer, scope.source, 1001);
    assert.equal(collectors.status(scope.customer, scope.source, 2000).status, "collecting");
    assert.equal(collectors.status(scope.customer, scope.source, 2001).status, "stale");
    collectors.complete(scope.customer, scope.source, attempt.revision, Buffer.concat([record(), Buffer.from("partial")]), 2100);
    assert.equal(collectors.status(scope.customer, scope.source, 2100).status, "pending");
    assert.equal(collectors.status(scope.customer, scope.source, 3099).ageMs, 999);
    assert.equal(collectors.status(scope.customer, scope.source, 3100).status, "stale");
    assert.equal(collectors.status(scope.customer, scope.source, 2099).status, "clock-skew");
    assert.throws(() => collectors.begin(scope.customer, scope.source, 2099), /backwards/);
    const next = collectors.begin(scope.customer, scope.source, 3101);
    collectors.complete(scope.customer, scope.source, next.revision, Buffer.concat([record(), record("EXITWITHTIMEOUT")]), 3102);
    assert.equal(collectors.status(scope.customer, scope.source, 3102).status, "healthy");
    assert.equal(collectors.status(scope.customer, scope.source, 3102).checkpoint.records, 2);
  });
});

test("QR-02: missing/malformed/oversized/truncated files fail without advancing evidence; recovery replays exactly", async () => {
  await fixture(async (store, _database, path) => {
    const collectors = store.queue.collectors;
    collectors.configure(config(path));
    await assert.rejects(collectQueueOnce(store, scope.customer, scope.source), /ENOENT/);
    assert.equal(collectors.status(scope.customer, scope.source).failure, "source-unavailable");
    await writeFile(path, record());
    assert.equal((await collectQueueOnce(store, scope.customer, scope.source)).inserted, 1);
    const before = store.queue.read(scope);
    for (const bytes of [Buffer.concat([record(), Buffer.from("bad\n")]), Buffer.alloc(HISTORY_SNAPSHOT_LIMIT + 1), Buffer.alloc(0)]) {
      await writeFile(path, bytes);
      await assert.rejects(collectQueueOnce(store, scope.customer, scope.source));
      assert.deepEqual(store.queue.read(scope), before);
    }
    assert.equal(collectors.status(scope.customer, scope.source).failure, "prefix-discontinuity");
    await writeFile(path, Buffer.concat([record(), record("EXITWITHTIMEOUT")]));
    assert.equal((await collectQueueOnce(store, scope.customer, scope.source)).inserted, 1);
    assert.equal((await collectQueueOnce(store, scope.customer, scope.source)).inserted, 0);
    assert.equal(collectors.status(scope.customer, scope.source).status, "healthy");
  });
});

test("QR-02: success/failure storage errors roll back evidence and surface failed failure-recording", async () => {
  await fixture(async (store, database, path) => {
    store.queue.collectors.configure(config(path));
    await writeFile(path, record());
    const db = new DatabaseSync(database);
    try {
      db.exec(`CREATE TRIGGER fail_success BEFORE UPDATE ON queue_collectors WHEN NEW.outcome='success'
        BEGIN SELECT RAISE(ABORT,'injected success failure'); END;`);
      await assert.rejects(collectQueueOnce(store, scope.customer, scope.source), /injected success/);
      assert.equal(store.queue.collectors.status(scope.customer, scope.source).failure, "collection-failed");
      assert.equal(store.queue.read(scope).events.length, 0);
      db.exec(`CREATE TRIGGER fail_failure BEFORE UPDATE ON queue_collectors WHEN NEW.outcome='failure'
        BEGIN SELECT RAISE(ABORT,'injected failure failure'); END;`);
      await assert.rejects(collectQueueOnce(store, scope.customer, scope.source), AggregateError);
      assert.equal(store.queue.collectors.status(scope.customer, scope.source).outcome, "collecting");
      assert.equal(store.queue.collectors.status(scope.customer, scope.source).checkpoint.consumedBytes, 0);
    } finally { db.close(); }
  });
});

test("QR-03: superseded attempts/failures cannot overwrite newer success or replacement generation", async () => {
  await fixture((store, database, path) => {
    const peer = openCelHistory(database);
    try {
      const collectors = store.queue.collectors;
      collectors.configure(config(path), 1000);
      const old = collectors.begin(scope.customer, scope.source, 1000);
      const next = peer.queue.collectors.begin(scope.customer, scope.source, 1001);
      peer.queue.collectors.complete(scope.customer, scope.source, next.revision, record(), 1002);
      const before = collectors.status(scope.customer, scope.source, 1002);
      assert.throws(() => collectors.complete(scope.customer, scope.source, old.revision, record(), 1003), QueueAttemptConflict);
      assert.throws(() => collectors.fail(scope.customer, scope.source, old.revision, "source-unavailable", 1003), QueueAttemptConflict);
      assert.deepEqual(collectors.status(scope.customer, scope.source, 1002), before);
      const abandoned = collectors.begin(scope.customer, scope.source, 1003);
      collectors.transition(scope.customer, scope.source, "second", "operator", "Unknown continuity", 1004);
      assert.throws(() => peer.queue.collectors.complete(scope.customer, scope.source, abandoned.revision, record(), 1005), QueueAttemptConflict);
      assert.throws(() => peer.queue.collectors.fail(scope.customer, scope.source, abandoned.revision, "collection-failed", 1005), QueueAttemptConflict);
      assert.equal(collectors.status(scope.customer, scope.source, 1005).checkpoint.records, 0);
      assert.equal(store.queue.read(scope).events.length, 1);
    } finally { peer.close(); }
  });
});

test("QR-04: explicit transitions retain old raw evidence and permanent gaps after healthy replacement", async () => {
  await fixture((store, _database, path) => {
    const collectors = store.queue.collectors;
    collectors.configure(config(path), 1000);
    const first = collectors.begin(scope.customer, scope.source, 1100);
    collectors.complete(scope.customer, scope.source, first.revision, record(), 1200);
    const before = store.queue.read(scope);
    for (const [gen, operator, reason] of [["first", "operator", "reason"], ["second", "", "reason"], ["second", "operator", "bad\nreason"]]) {
      assert.throws(() => collectors.transition(scope.customer, scope.source, gen, operator, reason, 1300));
    }
    const transition = collectors.transition(scope.customer, scope.source, "second", "operator", "Unverified replacement", 1300);
    const next = collectors.begin(scope.customer, scope.source, 1301);
    collectors.complete(scope.customer, scope.source, next.revision, record("EXITWITHTIMEOUT"), 1302);
    const status = collectors.status(scope.customer, scope.source, 1302);
    assert.equal(status.status, "healthy");
    assert.equal(status.coverage, "unknown-gap-recorded");
    const gap = collectors.gaps(scope.customer, scope.source).gaps[0];
    assert.equal(gap.id, transition.gapId);
    assert.equal(gap.lastSuccessAt, 1200);
    assert.equal(gap.observedAt, 1300);
    assert.equal(gap.coverage, "unknown");
    assert.deepEqual(store.queue.read(scope), before);
    collectors.transition(scope.customer, scope.source, "third", "operator", "Second unknown replacement", 1400);
    const page = collectors.gaps(scope.customer, scope.source, 0, 1);
    assert.equal(page.nextAfterId, transition.gapId);
    assert.equal(collectors.gaps(scope.customer, scope.source, page.nextAfterId!, 1).gaps.length, 1);
  });
});

test("QR-04: failed gap transaction preserves generation, status and sources atomically", async () => {
  await fixture((store, database, path) => {
    const collectors = store.queue.collectors;
    collectors.configure(config(path), 1000);
    const before = collectors.status(scope.customer, scope.source, 1000);
    const db = new DatabaseSync(database);
    try {
      db.exec("CREATE TRIGGER fail_gap BEFORE INSERT ON queue_collection_gaps BEGIN SELECT RAISE(ABORT,'injected gap failure'); END;");
      assert.throws(() => collectors.transition(scope.customer, scope.source, "second", "operator", "reason", 1001), /injected gap/);
      assert.deepEqual(collectors.status(scope.customer, scope.source, 1000), before);
      assert.equal(store.queue.sources(scope.customer).sources.length, 1);
      assert.equal(collectors.gaps(scope.customer, scope.source).gaps.length, 0);
    } finally { db.close(); }
  });
});

test("QR-05: kind-qualified queue gaps change projection inputs without claiming completeness or changing stable identities", async () => {
  await fixture((store, _database, path, directory) => {
    store.queue.ingest(scope, record()); manifest(store, record().length);
    store.configureCollector({ ...config(path), timeBasis: "UTC" }, 1000);
    const celAttempt = store.beginCollection(scope.customer, scope.source, 1001);
    store.completeCollection(scope.customer, scope.source, celAttempt.revision, cel, 1002);
    const before = buildHistoryProjection(store, projectionScope);
    const projections = openHistoryProjections(join(directory, "projections.sqlite"));
    try {
      const revision = projections.rebuild(store, projectionScope);
      const collectors = store.queue.collectors;
      collectors.configure(config(path), 1000);
      const attempt = collectors.begin(scope.customer, scope.source, 1001);
      collectors.complete(scope.customer, scope.source, attempt.revision, record(), 1002);
      const originalCel = store.collectorStatus(scope.customer, scope.source, 1002);
      collectors.transition(scope.customer, scope.source, "second", "operator", "Queue source replacement", 1100);
      const second = collectors.begin(scope.customer, scope.source, 1101);
      collectors.complete(scope.customer, scope.source, second.revision, record("EXITWITHTIMEOUT"), 1102);
      const after = buildHistoryProjection(store, projectionScope);
      assert.notEqual(before.inputSha256, after.inputSha256);
      assert.equal(after.document.quality.queueCoverage, "unverified");
      const queue = after.document.input.coverage.find((c) => c.kind === "queue")!;
      assert.equal(queue.gaps.length, 1);
      assert.equal(queue.association, "possibly-applicable");
      assert.equal(queue.outcome, "success");
      assert.equal(after.document.input.coverage.find((c) => c.kind === "cel")!.gaps.length, 0);
      assert.deepEqual(store.collectorStatus(scope.customer, scope.source, 1002), originalCel);
      assert.notEqual(projections.rebuild(store, projectionScope).id, revision.id);
      assert.equal(projections.read(projectionScope, revision.id).inputSha256, before.inputSha256);
      assert.equal(after.document.issues.filter((i) => i.reason === "unassigned-evidence").length, 2);
    } finally { projections.close(); }
  });
});

test("QR-05: old projection algorithm revisions remain readable and rebuild under the current version without changing entity keys", async () => {
  await fixture(async (store, _database, _path, directory) => {
    const id = "11111111-1111-4111-8111-111111111111";
    const entry = Buffer.from(['HISTORY_ENTRY', '2026-10-25 01:30:00', 'Local/test;2', 'same-id', 'same-linked',
      'marker', 'entry', JSON.stringify({ extra: JSON.stringify({ v: 1, journeyId: id, entryKind: "synthetic", routeRevision: "v1" }) })]
      .map((v) => `"${v.replaceAll('"', '""')}"`).join(",") + "\n");
    store.ingest({ ...scope, timeBasis: "UTC" }, Buffer.concat([cel, entry]));
    store.manifests.register({ ...projectionScope, operator: "test", reason: "Version compatibility",
      routes: [{ context: "marker", extension: "entry", routeRevision: "v1", entryKind: "synthetic" }],
      ranges: [{ kind: "cel", source: scope.source, generation: scope.generation, start: 0, end: cel.length + entry.length }] });
    const path = join(directory, "projections.sqlite");
    const projections = openHistoryProjections(path);
    const db = new DatabaseSync(path);
    try {
      const first = projections.rebuild(store, projectionScope);
      const built = buildHistoryProjection(store, projectionScope);
      const v1 = JSON.parse(JSON.stringify(built.document));
      v1.algorithm = "marked-caller-v1"; v1.input.algorithm = "marked-caller-v1";
      delete v1.input.queueCollectionCapability;
      for (const coverage of v1.input.coverage) delete coverage.kind;
      db.prepare("UPDATE projection_revisions SET algorithm=?,document=?,sha256=?,input_sha256=?")
        .run(v1.algorithm, JSON.stringify(v1), historySha256(Buffer.from(JSON.stringify(v1))), historySha256(Buffer.from(JSON.stringify(v1.input))));
      assert.equal(projections.read(projectionScope).algorithm, "marked-caller-v1");
      const next = projections.rebuild(store, projectionScope);
      assert.notEqual(next.id, first.id);
      assert.equal(next.algorithm, "marked-caller-v5");
      assert.equal(buildHistoryProjection(store, projectionScope).document.journeys[0].id, v1.journeys[0].id);
      assert.equal(projections.read(projectionScope, first.id).algorithm, "marked-caller-v1");
    } finally { db.close(); projections.close(); }
  });
});

test("QR-06: source scope, read-only writes, bad cursors and corrupt persisted collector/gap states fail closed", async () => {
  await fixture((store, database, path) => {
    const collectors = store.queue.collectors;
    collectors.configure(config(path), 1000);
    for (const action of [() => collectors.status("customer-b", scope.source), () => collectors.gaps("customer-b", scope.source),
      () => collectors.begin("customer-b", scope.source), () => collectors.configure({ ...config(path), customer: "customer-b" }),
      () => collectors.gaps(scope.customer, scope.source, 0, 201), () => collectors.status(scope.customer, scope.source, NaN)]) assert.throws(action);
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.throws(() => reader.queue.collectors.configure(config(path)), /writable/); }
    finally { reader.close(); }
    const db = new DatabaseSync(database);
    try {
      db.exec("UPDATE queue_collectors SET outcome='success'");
      assert.throws(() => collectors.status(scope.customer, scope.source), /Inconsistent/);
      db.exec("UPDATE queue_collectors SET outcome='never'");
      collectors.transition(scope.customer, scope.source, "second", "operator", "reason", 1001);
      db.exec("UPDATE queue_collection_gaps SET last_success_at=9999");
      assert.throws(() => collectors.gaps(scope.customer, scope.source), /interval/);
      db.exec("PRAGMA foreign_keys=OFF; UPDATE queue_collectors SET generation='missing'");
      assert.throws(() => collectors.sources(scope.customer), /not found/);
    } finally { db.close(); }
  });
});

test("QR-03/06: process death leaves a stale fenced attempt; separate CLI replay/run/status/gaps persist", async () => {
  await fixture(async (store, database, path) => {
    const cli = (...args: string[]) => execute(process.execPath, ["scripts\\Manage-QueueCollector.ts", ...args]);
    await cli("configure", database, scope.customer, scope.source, scope.generation, path, "1000");
    const module = new URL("../src/cel-history.ts", import.meta.url).href;
    const code = `import {openCelHistory} from ${JSON.stringify(module)}; const store=openCelHistory(${JSON.stringify(database)});
      store.queue.collectors.begin(${JSON.stringify(scope.customer)},${JSON.stringify(scope.source)}); process.exit(23);`;
    await assert.rejects(execute(process.execPath, ["--input-type=module", "-e", code]), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === 23);
    const abandoned = store.queue.collectors.status(scope.customer, scope.source);
    assert.equal(store.queue.collectors.status(scope.customer, scope.source, abandoned.updatedAt + 1000).status, "stale");
    await writeFile(path, record());
    const collected = JSON.parse((await cli("collect", database, scope.customer, scope.source)).stdout);
    assert.equal(collected.result.inserted, 1);
    const passes = (await cli("run", database, scope.customer, scope.source, "100", "2")).stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.ok(passes.every((pass) => pass.result.inserted === 0 && pass.status.status === "healthy"));
    await assert.rejects(cli("run", database, scope.customer, scope.source, "99", "2"));
    await writeFile(path, record("EXITWITHTIMEOUT"));
    await assert.rejects(cli("collect", database, scope.customer, scope.source), /prefix changed/);
    assert.equal(JSON.parse((await cli("status", database, scope.customer, scope.source)).stdout).failure, "prefix-discontinuity");
    await cli("transition", database, scope.customer, scope.source, "second", "operator", "Explicit replacement");
    await cli("collect", database, scope.customer, scope.source);
    const gaps = JSON.parse((await cli("gaps", database, scope.customer, scope.source, "0", "100")).stdout);
    assert.equal(gaps.gaps.length, 1);
    assert.equal((await readFile(path)).toString(), record("EXITWITHTIMEOUT").toString());
    await assert.rejects(cli("status", database, "customer-b", scope.source));
    await assert.rejects(cli("configure", resolve("relative.sqlite"), scope.customer, scope.source));
  });
});

test("QR-02/03: process death during atomic completion rolls back evidence/checkpoint/status together", async () => {
  await fixture(async (store, database, path) => {
    const collectors = store.queue.collectors;
    collectors.configure(config(path), 1000);
    const attempt = collectors.begin(scope.customer, scope.source, 1001);
    const crash = `import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(database)}); db.exec('BEGIN IMMEDIATE');
      db.prepare("INSERT INTO queue_events VALUES(?,?,?,?,?,?,?,?)").run(${JSON.stringify(scope.source)},${JSON.stringify(scope.generation)},
        0,${record().length},'same-id',Buffer.from(${JSON.stringify(record().toString())}),${JSON.stringify(historySha256(record()))},new Date().toISOString());
      db.prepare("UPDATE queue_sources SET consumed_bytes=?,prefix_sha256=?").run(${record().length},${JSON.stringify(historySha256(record()))});
      db.prepare("UPDATE queue_collectors SET outcome='success',succeeded_at=1002,updated_at=1002").run();
      process.exit(24);`;
    await assert.rejects(execute(process.execPath, ["--input-type=module", "-e", crash]), (error: unknown) =>
      error instanceof Error && "code" in error && error.code === 24);
    const after = collectors.status(scope.customer, scope.source, 2001);
    assert.equal(after.outcome, "collecting");
    assert.equal(after.status, "stale");
    assert.equal(after.checkpoint.records, 0);
    assert.equal(after.checkpoint.consumedBytes, 0);
    assert.equal(collectors.complete(scope.customer, scope.source, attempt.revision, record(), 2002).inserted, 1);
    assert.equal(collectors.status(scope.customer, scope.source, 2002).status, "healthy");
  });
});

test("QR-05/06: queue source/gap bounds fail explicitly and unassociated gaps remain unknown", async () => {
  await fixture((store, database, path) => {
    store.queue.ingest(scope, record()); manifest(store, record().length);
    store.queue.collectors.configure({ ...config(path), source: "unassociated" }, 1000);
    store.queue.collectors.transition(scope.customer, "unassociated", "second", "operator", "No epoch association", 1001);
    const first = buildHistoryProjection(store, projectionScope);
    assert.equal(first.document.input.coverage[0].kind, "queue");
    assert.equal(first.document.input.coverage[0].association, "association-unknown");
    const db = new DatabaseSync(database);
    try {
      db.exec("BEGIN IMMEDIATE");
      const insert = db.prepare(`INSERT INTO queue_collection_gaps
        (customer,source,from_generation,to_generation,last_success_at,observed_at,operator,reason) VALUES(?,?,?,?,NULL,1002,'operator','Unknown gap')`);
      for (let i = 0; i < 200; i++) insert.run(scope.customer, "unassociated", `generation-${i}`, `generation-${i + 1}`);
      db.exec("COMMIT");
      const page = store.queue.collectors.gaps(scope.customer, "unassociated", 0, 200);
      assert.equal(page.gaps.length, 200); assert.notEqual(page.nextAfterId, null);
      assert.throws(() => buildHistoryProjection(store, projectionScope), /gap limit/);
    } finally { db.close(); }
    for (let i = 0; i < 20; i++) store.queue.collectors.configure({ ...config(path), source: `source-${i}` }, 1000);
    assert.throws(() => store.queue.collectors.sources(scope.customer), /source limit/);
  });
});
