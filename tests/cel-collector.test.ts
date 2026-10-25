import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { CelAttemptConflict, CelPrefixError, CEL_SNAPSHOT_LIMIT, openCelHistory } from "../src/cel-history.ts";
import { collectCelOnce, readCelSnapshot } from "../src/cel-collector.ts";

const execute = promisify(execFile);
const scope = { customer: "customer-a", source: "pbx-a", generation: "first", timeBasis: "UTC" };
const record = (event = "CHAN_START") => Buffer.from(
  `"${event}","2026-10-25 02:00:00.000000","PJSIP/test","same-id","same-linked","sip-proof","echo",""\n`);
async function fixture(action: (database: string, path: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "cel-collector-"));
  try { await action(join(directory, "history.sqlite"), join(directory, "Master.csv"), directory); }
  finally { await rm(directory, { recursive: true }); }
}
const config = (path: string) => ({ ...scope, path, staleAfterMs: 1000 });
const status = (store: ReturnType<typeof openCelHistory>, now: number) => store.collectorStatus(scope.customer, scope.source, now);

test("CR-01: schema-1 evidence migrates atomically; old read-only history still works", async () => {
  await fixture(async (database) => {
    const initial = openCelHistory(database);
    initial.ingest(scope, record());
    const before = initial.read(scope);
    initial.close();
    const legacy = new DatabaseSync(database);
    legacy.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; DROP TABLE queue_events; DROP TABLE queue_sources; DROP TABLE cel_collection_gaps; DROP TABLE cel_collectors; PRAGMA user_version=1");
    legacy.close();
    const oldReader = openCelHistory(database, { readOnly: true });
    try {
      assert.deepEqual(oldReader.read(scope), before);
      assert.throws(() => oldReader.collectorStatus(scope.customer, scope.source), /schema 2/);
    } finally { oldReader.close(); }
    const migrated = openCelHistory(database);
    try { assert.deepEqual(migrated.read(scope), before); }
    finally { migrated.close(); }
    const check = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 4); }
    finally { check.close(); }
  });
});

test("CR-01/03: immutable configuration, explicit freshness boundaries and backwards clocks", async () => {
  await fixture((database, path) => {
    const store = openCelHistory(database);
    try {
      const provisioned = store.configureCollector(config(path), 1000);
      assert.deepEqual(store.configureCollector(config(path), 1100), provisioned);
      assert.equal(status(store, 1000).status, "never-collected");
      assert.equal(status(store, 999).status, "clock-skew");
      assert.throws(() => store.beginCollection(scope.customer, scope.source, 999), /backwards/);
      for (const change of [{ customer: "customer-b" }, { generation: "second" },
        { timeBasis: "Europe/London" }, { path: path + ".other" }, { staleAfterMs: 2000 }]) {
        assert.throws(() => store.configureCollector({ ...config(path), ...change }, 1100), /immutable/);
      }
      const attempt = store.beginCollection(scope.customer, scope.source, 1100);
      assert.equal(status(store, 2099).status, "collecting");
      assert.equal(status(store, 2100).status, "stale");
      store.completeCollection(scope.customer, scope.source, attempt.revision, record(), 2100);
      assert.equal(status(store, 2100).attemptedAt, 1100);
      assert.equal(status(store, 2100).succeededAt, 2100);
      assert.equal(status(store, 3099).status, "healthy");
      assert.equal(status(store, 3100).status, "stale");
      assert.equal(status(store, 2099).status, "clock-skew");
      const pending = store.beginCollection(scope.customer, scope.source, 3100);
      store.completeCollection(scope.customer, scope.source, pending.revision, Buffer.concat([record(), Buffer.from('"partial')]), 3101);
      assert.equal(status(store, 3101).status, "pending");
      assert.equal(status(store, 4101).status, "stale");
      assert.equal(status(store, 3101).pendingBytes, 8);
      assert.equal(status(store, 3101).coverage, "unverified");
    } finally { store.close(); }
  });
});

test("CR-01: migration failure is atomic and leaves schema-1 evidence readable", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    store.ingest(scope, record());
    const before = store.read(scope);
    store.close();
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; DROP TABLE queue_events; DROP TABLE queue_sources; DROP TABLE cel_collection_gaps; DROP TABLE cel_collectors; PRAGMA user_version=1; CREATE TABLE cel_collection_gaps(blocker TEXT)");
    db.close();
    assert.throws(() => openCelHistory(database), /already exists/);
    const inspect = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(inspect.prepare("PRAGMA user_version").get()?.user_version, 1);
      assert.equal(inspect.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='cel_collectors'").get()?.count, 0);
    } finally { inspect.close(); }
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.deepEqual(reader.read(scope), before); }
    finally { reader.close(); }
  });
});

test("CR-02/05: missing, malformed, oversized and truncated files fail explicitly; retained evidence recovers", async () => {
  await fixture(async (database, path) => {
    const store = openCelHistory(database);
    try {
      store.configureCollector(config(path));
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), /ENOENT/);
      assert.equal(store.collectorStatus(scope.customer, scope.source).failure, "source-unavailable");
      await writeFile(path, record());
      assert.equal((await collectCelOnce(store, scope.customer, scope.source)).inserted, 1);
      const original = store.read(scope);
      await writeFile(path, Buffer.concat([record(), Buffer.from("malformed\n")]));
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), /eight-field/);
      assert.deepEqual(store.read(scope), original);
      assert.equal(store.collectorStatus(scope.customer, scope.source).status, "unhealthy");
      await writeFile(path, Buffer.alloc(CEL_SNAPSHOT_LIMIT + 1));
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), /8 MiB/);
      assert.deepEqual(store.read(scope), original);
      await writeFile(path, Buffer.alloc(0));
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), CelPrefixError);
      assert.equal(store.collectorStatus(scope.customer, scope.source).failure, "prefix-discontinuity");
      assert.deepEqual(store.read(scope), original);
      await writeFile(path, Buffer.concat([record(), record("ANSWER")]));
      assert.equal((await collectCelOnce(store, scope.customer, scope.source)).inserted, 1);
      assert.equal((await collectCelOnce(store, scope.customer, scope.source)).inserted, 0);
      assert.equal(store.collectorStatus(scope.customer, scope.source).status, "healthy");
      assert.equal(store.read(scope).events.length, 2);
    } finally { store.close(); }
  });
});

test("CR-02/04: actual collection status write failures are surfaced and leave the checkpoint unchanged", async () => {
  await fixture(async (database, path) => {
    const store = openCelHistory(database);
    const db = new DatabaseSync(database);
    try {
      store.configureCollector(config(path));
      await writeFile(path, record());
      db.exec(`CREATE TRIGGER fail_complete BEFORE UPDATE ON cel_collectors WHEN NEW.outcome='success'
        BEGIN SELECT RAISE(ABORT,'status write failed'); END;`);
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), /status write/);
      const current = store.collectorStatus(scope.customer, scope.source);
      assert.equal(current.status, "unhealthy");
      assert.equal(current.failure, "collection-failed");
      assert.equal(current.checkpoint.records, 0);
      assert.equal(current.checkpoint.consumedBytes, 0);
      db.exec(`CREATE TRIGGER fail_failure BEFORE UPDATE ON cel_collectors WHEN NEW.outcome='failure'
        BEGIN SELECT RAISE(ABORT,'failure write failed'); END;`);
      await assert.rejects(collectCelOnce(store, scope.customer, scope.source), AggregateError);
      assert.equal(store.collectorStatus(scope.customer, scope.source).outcome, "collecting");
      assert.equal(store.read(scope).events.length, 0);
    } finally { db.close(); store.close(); }
  });
});

test("CR-04: superseded workers and late failures cannot overwrite current or transitioned state", async () => {
  await fixture((database, path) => {
    const store = openCelHistory(database);
    const peer = openCelHistory(database);
    try {
      store.configureCollector(config(path), 1000);
      const old = store.beginCollection(scope.customer, scope.source, 1000);
      const fresh = peer.beginCollection(scope.customer, scope.source, 1001);
      peer.completeCollection(scope.customer, scope.source, fresh.revision, record(), 1002);
      const current = status(store, 1002);
      assert.throws(() => store.completeCollection(scope.customer, scope.source, old.revision, Buffer.alloc(0), 1003), CelAttemptConflict);
      assert.throws(() => store.failCollection(scope.customer, scope.source, old.revision, "source-unavailable", 1003), CelAttemptConflict);
      assert.deepEqual(status(store, 1002), current);
      const abandoned = store.beginCollection(scope.customer, scope.source, 1003);
      store.transitionCollector(scope.customer, scope.source, "second", "operator-test", "source replaced", 1004);
      assert.throws(() => peer.completeCollection(scope.customer, scope.source, abandoned.revision, record(), 1005), CelAttemptConflict);
      assert.equal(status(store, 1005).checkpoint.records, 0);
      assert.equal(store.read(scope).events.length, 1);
    } finally { peer.close(); store.close(); }
  });
});

test("CR-02/04: injected status failure rolls back evidence and checkpoint in the same transaction", async () => {
  await fixture((database, path) => {
    const store = openCelHistory(database);
    const db = new DatabaseSync(database);
    try {
      store.configureCollector(config(path), 1000);
      const attempt = store.beginCollection(scope.customer, scope.source, 1000);
      db.exec(`CREATE TRIGGER fail_status BEFORE UPDATE ON cel_collectors WHEN NEW.outcome='success'
        BEGIN SELECT RAISE(ABORT,'injected status failure'); END;`);
      assert.throws(() => store.completeCollection(scope.customer, scope.source, attempt.revision, record(), 1001), /injected/);
      assert.equal(status(store, 1001).checkpoint.consumedBytes, 0);
      assert.equal(store.read(scope).events.length, 0);
      assert.equal(status(store, 1001).outcome, "collecting");
      db.exec("DROP TRIGGER fail_status");
      assert.equal(store.completeCollection(scope.customer, scope.source, attempt.revision, record(), 1002).inserted, 1);
    } finally { db.close(); store.close(); }
  });
});

test("CR-06: operator transitions preserve unknown coverage and old evidence, even after healthy recovery", async () => {
  await fixture((database, path) => {
    const store = openCelHistory(database);
    try {
      store.configureCollector(config(path), 1000);
      const first = store.beginCollection(scope.customer, scope.source, 1100);
      store.completeCollection(scope.customer, scope.source, first.revision, record(), 1200);
      const old = store.read(scope);
      for (const args of [["first", "operator", "reason"], ["second", "", "reason"],
        ["second", "operator", ""], ["second", "operator", "bad\nreason"]]) {
        assert.throws(() => store.transitionCollector(scope.customer, scope.source, args[0], args[1], args[2], 1300));
      }
      const transition = store.transitionCollector(scope.customer, scope.source, "second", "operator", "retained file unavailable", 1300);
      assert.equal(transition.coverage, "unknown-gap-recorded");
      assert.equal(status(store, 1299).status, "clock-skew");
      assert.throws(() => store.beginCollection(scope.customer, scope.source, 1299), /backwards/);
      const second = store.beginCollection(scope.customer, scope.source, 1301);
      store.completeCollection(scope.customer, scope.source, second.revision, record("ANSWER"), 1302);
      assert.equal(status(store, 1302).status, "healthy");
      assert.equal(status(store, 1302).gapCount, 1);
      assert.equal(status(store, 1302).coverage, "unknown-gap-recorded");
      const gap = store.collectionGaps(scope.customer, scope.source).gaps[0];
      assert.deepEqual(gap, { id: transition.gapId, customer: scope.customer, source: scope.source,
        previousGeneration: "first", generation: "second", lastSuccessAt: 1200,
        observedAt: 1300, operator: "operator", reason: "retained file unavailable", coverage: "unknown" });
      assert.deepEqual(store.read(scope), old);
      store.transitionCollector(scope.customer, scope.source, "third", "operator", "second replacement", 1400);
      const page = store.collectionGaps(scope.customer, scope.source, 0, 1);
      assert.ok(page.nextAfterId);
      assert.equal(store.collectionGaps(scope.customer, scope.source, page.nextAfterId!, 1).gaps.length, 1);
      assert.equal(store.collectionGaps(scope.customer, scope.source, 100).gaps.length, 0);
      for (const fn of [
        () => store.collectorStatus("customer-b", scope.source, 1400),
        () => store.collectionGaps("customer-b", scope.source),
        () => store.transitionCollector("customer-b", scope.source, "fourth", "operator", "reason", 1500),
      ]) assert.throws(fn, /not found/);
    } finally { store.close(); }
  });
});

test("CR-06: failed gap transaction never switches generation or loses prior status", async () => {
  await fixture((database, path) => {
    const store = openCelHistory(database);
    const db = new DatabaseSync(database);
    try {
      store.configureCollector(config(path), 1000);
      const before = status(store, 1000);
      db.exec(`CREATE TRIGGER fail_gap BEFORE INSERT ON cel_collection_gaps
        BEGIN SELECT RAISE(ABORT,'gap storage failed'); END;`);
      assert.throws(() => store.transitionCollector(scope.customer, scope.source, "second", "operator", "replacement", 1001), /gap storage/);
      assert.deepEqual(status(store, 1000), before);
      assert.equal(store.collectionGaps(scope.customer, scope.source).gaps.length, 0);
      assert.throws(() => store.read({ ...scope, generation: "second" }), /not found/);
    } finally { db.close(); store.close(); }
  });
});

test("CR-07: source/read/status boundaries and corrupt collector/gap states fail closed", async () => {
  await fixture(async (database, path, directory) => {
    await assert.rejects(readCelSnapshot("relative.csv"), /absolute/);
    await assert.rejects(readCelSnapshot(directory), /regular/);
    const store = openCelHistory(database);
    try {
      for (const staleAfterMs of [0, 999, 86400001, NaN, 1.5]) assert.throws(() => store.configureCollector({ ...config(path), staleAfterMs }));
      assert.throws(() => store.configureCollector({ ...config(path), path: "relative.csv" }));
      store.configureCollector(config(path), 1000);
      for (const now of [-1, NaN, Infinity]) assert.throws(() => status(store, now), /timestamp/);
      for (const limit of [0, 201, NaN]) assert.throws(() => store.collectionGaps(scope.customer, scope.source, 0, limit), /page/);
      store.transitionCollector(scope.customer, scope.source, "second", "operator", "reason", 1001);
      const db = new DatabaseSync(database);
      try {
        db.exec("UPDATE cel_collection_gaps SET observed_at=-1");
        assert.throws(() => store.collectionGaps(scope.customer, scope.source), /Invalid stored/);
        db.exec("UPDATE cel_collectors SET outcome='success', succeeded_at=NULL");
        assert.throws(() => status(store, 1002), /Inconsistent/);
      } finally { db.close(); }
    } finally { store.close(); }
  });
});

test("CR-04/07: collector process death leaves durable stale attempt and restart replays exactly once", async () => {
  await fixture(async (database, path) => {
    const store = openCelHistory(database);
    store.configureCollector(config(path));
    await writeFile(path, record());
    await collectCelOnce(store, scope.customer, scope.source);
    store.close();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { openCelHistory } from './src/cel-history.ts';
      const store = openCelHistory(process.argv[1]);
      store.beginCollection('customer-a', 'pbx-a');
      console.log('attempt-committed');
      setInterval(() => {}, 1000);
    `, database], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("exit", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Collector fixture readiness timed out")), 10000);
        child.stdout!.once("data", () => { clearTimeout(timeout); resolve(); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Collector fixture exited too early")); });
      });
    } finally { child.kill(); await exited; }
    const reopened = openCelHistory(database);
    try {
      const attempt = reopened.collectorStatus(scope.customer, scope.source);
      assert.equal(reopened.collectorStatus(scope.customer, scope.source, attempt.attemptedAt! + 1000).status, "stale");
      await writeFile(path, Buffer.concat([record(), record("ANSWER")]));
      assert.equal((await collectCelOnce(reopened, scope.customer, scope.source)).inserted, 1);
      assert.equal((await collectCelOnce(reopened, scope.customer, scope.source)).inserted, 0);
      assert.equal(reopened.read(scope).events.length, 2);
    } finally { reopened.close(); }
  });
});

test("CR-02/07: CLI configuration, bounded foreground passes, status, gaps and nonzero failures persist", async () => {
  await fixture(async (database, path) => {
    const cli = (...args: string[]) => execute(process.execPath, ["scripts\\Manage-CelCollector.ts", ...args]);
    const args = [database, scope.customer, scope.source];
    await cli("configure", ...args, scope.generation, scope.timeBasis, path, "1000");
    await assert.rejects(cli("collect", ...args));
    const failed = JSON.parse((await cli("status", ...args)).stdout);
    assert.equal(failed.status, "unhealthy");
    await writeFile(path, record());
    const passes = (await cli("run", ...args, "100", "2")).stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(passes[0].result.inserted, 1);
    assert.equal(passes[1].result.inserted, 0);
    await cli("transition", ...args, "second", "operator-cli", "explicit source replacement");
    const gap = JSON.parse((await cli("gaps", ...args, "0", "100")).stdout);
    assert.equal(gap.gaps.length, 1);
    for (const runArgs of [["0", "2"], ["100", "0"], ["100", "1001"], ["60001", "1"], ["100", "1.5"]]) {
      await assert.rejects(cli("run", ...args, ...runArgs));
    }
    await assert.rejects(cli("status", database, "customer-b", scope.source));
    const backup = path + ".moved";
    await rename(path, backup);
    await assert.rejects(cli("collect", ...args));
    assert.equal(JSON.parse((await cli("status", ...args)).stdout).failure, "source-unavailable");
    assert.equal((await readFile(backup)).toString(), record().toString());
  });
});
