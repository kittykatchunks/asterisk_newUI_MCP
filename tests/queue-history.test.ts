import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openCelHistory } from "../src/cel-history.ts";
import { HISTORY_SNAPSHOT_LIMIT, HISTORY_RECORD_LIMIT } from "../src/history-evidence.ts";
import { QueuePrefixError } from "../src/queue-history.ts";

const execute = promisify(execFile);
const source = { customer: "customer-a", source: "pbx-a", generation: "first" };
const cel = Buffer.from('"CHAN_START","2026-10-25 02:00:00","Local/test;1","same-id","same-linked","proof","queue",""\n');
const record = (event = "ENTERQUEUE", parameters = ["", "synthetic-caller", "1"], ending = "\n") =>
  ["1792890000", "same-id", "proof-queue", "NONE", event, ...parameters].join("|") + ending;
const bytes = (...records: string[]) => Buffer.from(records.join(""));
async function fixture(action: (database: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "queue-history-"));
  try { await action(join(directory, "history.sqlite"), directory); }
  finally { await rm(directory, { recursive: true }); }
}
const importArgs = (database: string, input: string) =>
  ["scripts\\Manage-QueueHistory.ts", "import", database, source.customer, source.source, source.generation, input];

test("QF-01: schema 2 migrates atomically without changing CEL, collector or gaps; schema 2 read compatibility", async () => {
  await fixture((database, directory) => {
    const initial = openCelHistory(database);
    initial.ingest({ ...source, timeBasis: "UTC" }, cel);
    initial.configureCollector({ ...source, timeBasis: "UTC", path: join(directory, "cel.csv"), staleAfterMs: 1000 }, 1000);
    const attempt = initial.beginCollection(source.customer, source.source, 1001);
    initial.completeCollection(source.customer, source.source, attempt.revision, cel, 1002);
    initial.transitionCollector(source.customer, source.source, "second", "operator", "source replaced", 1003);
    const before = { events: initial.read(source), status: initial.collectorStatus(source.customer, source.source, 1004),
      gaps: initial.collectionGaps(source.customer, source.source) };
    initial.close();
    const legacy = new DatabaseSync(database);
    legacy.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; DROP TABLE queue_events; DROP TABLE queue_sources; PRAGMA user_version=2");
    legacy.close();
    const old = openCelHistory(database, { readOnly: true });
    try {
      assert.deepEqual(old.read(source), before.events);
      assert.deepEqual(old.collectorStatus(source.customer, source.source, 1004), before.status);
      assert.throws(() => old.queue.sources(source.customer), /schema 3/);
    } finally { old.close(); }
    const migrated = openCelHistory(database);
    try {
      assert.deepEqual(migrated.read(source), before.events);
      assert.deepEqual(migrated.collectorStatus(source.customer, source.source, 1004), before.status);
      assert.deepEqual(migrated.collectionGaps(source.customer, source.source), before.gaps);
      assert.equal(migrated.queue.ingest(source, bytes(record())).inserted, 1);
      assert.deepEqual(migrated.read(source), before.events);
    } finally { migrated.close(); }
    const check = new DatabaseSync(database, { readOnly: true });
    try { assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 4); }
    finally { check.close(); }
  });
});

test("QF-01: failed queue migration rolls back schema, retaining old CEL reads", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    store.ingest({ ...source, timeBasis: "UTC" }, cel);
    const before = store.read(source);
    store.close();
    const db = new DatabaseSync(database);
    db.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; DROP TABLE queue_events; DROP TABLE queue_sources; PRAGMA user_version=2; CREATE TABLE queue_events(blocker TEXT)");
    db.close();
    assert.throws(() => openCelHistory(database), /already exists/);
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 2);
      assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='queue_sources'").get()?.count, 0);
    } finally { check.close(); }
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.deepEqual(reader.read(source), before); }
    finally { reader.close(); }
  });
});

test("QF-02: exact UTF-8 records, CRLF, empty parameters and unknown/admin events stay raw evidence", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    try {
      const raw = record("ENTERQUEUE", ["", "Synthetic café", "1", 'literal "name"', ""], "\r\n") +
        "1792890000.125|NONE|NONE|NONE|QUEUESTART\n" +
        "1792890001|REALTIME|proof-queue|NONE|FUTURE_EVENT|a||b|\n";
      const result = store.queue.ingest(source, Buffer.from(raw));
      assert.equal(result.inserted, 3);
      assert.equal(result.kind, "queue");
      assert.equal(result.timeBasis, "unix");
      const page = store.queue.read(source);
      assert.equal(page.kind, "queue");
      assert.equal(page.source.timeBasis, "unix");
      assert.equal(page.events.map((event) => event.rawRecord).join(""), raw);
      assert.deepEqual(page.events[0].parameters, ["", "Synthetic café", "1", 'literal "name"', ""]);
      assert.equal(page.events[1].sourceTimestamp, "1792890000.125");
      assert.equal(page.events[1].callId, "NONE");
      assert.deepEqual(page.events[1].parameters, []);
      assert.deepEqual(page.events[2].parameters, ["a", "", "b", ""]);
      assert.equal("journeyId" in page.events[0], false);
      assert.equal("outcome" in page.events[0], false);
      page.events[0].parameters.push("mutated");
      assert.equal(store.queue.read(source).events[0].parameters.length, 5);
    } finally { store.close(); }
  });
});

test("QF-03/04: split multibyte/CRLF tails remain pending and resume after reopen without duplicates", async () => {
  await fixture((database) => {
    let store = openCelHistory(database);
    try {
      const first = record();
      const second = record("UNKNOWN", ["café"], "\r\n");
      const complete = bytes(first, second);
      const cut = Buffer.byteLength(first + second.slice(0, second.indexOf("é"))) + 1;
      const pending = store.queue.ingest(source, complete.subarray(0, cut));
      assert.equal(pending.inserted, 1);
      assert.equal(pending.consumedBytes, Buffer.byteLength(first));
      assert.equal(pending.pendingBytes, cut - Buffer.byteLength(first));
      const before = store.queue.read(source).events;
      store.close();
      store = openCelHistory(database);
      assert.equal(store.queue.ingest(source, complete.subarray(0, complete.length - 1)).inserted, 0);
      assert.equal(store.queue.ingest(source, complete).inserted, 1);
      assert.equal(store.queue.ingest(source, complete).inserted, 0);
      const events = store.queue.read(source).events;
      assert.deepEqual(events[0], before[0]);
      assert.equal(events[1].offset, Buffer.byteLength(first));
      assert.equal(events[1].endOffset, complete.length);
    } finally { store.close(); }
  });
});

test("QF-03: malformed complete records roll back an entire import, including prior valid new rows", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    try {
      const first = record();
      store.queue.ingest(source, bytes(first));
      const before = store.queue.read(source);
      for (const invalid of ["a|b|c\n", "1||q|m|EVENT\n", "-1|id|q|m|EVENT\n", "nan|id|q|m|EVENT\n",
        "1|id|q|m|bad-event\n", "\ufeff1|id|q|m|EVENT\n", "1|id|q|m|EVENT|embedded\rvalue\n",
        "1|id|q|m|EVENT|\u0000\n", "1|id|q|m|EVENT|\t\n", record("EVENT", Array(257).fill(""))]) {
        assert.throws(() => store.queue.ingest(source, bytes(first, record("CONNECT"), invalid)));
        assert.deepEqual(store.queue.read(source), before);
      }
      assert.throws(() => store.queue.ingest(source, Buffer.concat([bytes(first), Buffer.from([0xff, 10])])));
      assert.deepEqual(store.queue.read(source), before);
      assert.throws(() => store.queue.ingest({ ...source, generation: "bad" }, bytes("bad\n")));
      assert.equal(store.queue.sources(source.customer).sources.length, 1);
    } finally { store.close(); }
  });
});

test("QF-03: exact snapshot/record/parameter/count bounds pass and exceeding them fails atomically", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    try {
      const base = record("UNKNOWN", [""]);
      const largest = record("UNKNOWN", ["x".repeat(HISTORY_RECORD_LIMIT - Buffer.byteLength(base))]);
      assert.equal(Buffer.byteLength(largest), HISTORY_RECORD_LIMIT);
      const full = bytes(largest.repeat(128));
      assert.equal(full.length, HISTORY_SNAPSHOT_LIMIT);
      assert.equal(store.queue.ingest(source, full).inserted, 128);
      assert.equal(store.queue.ingest(source, full).inserted, 0);
      assert.throws(() => store.queue.ingest(source, Buffer.alloc(HISTORY_SNAPSHOT_LIMIT + 1)), /8 MiB/);
      assert.throws(() => store.queue.ingest({ ...source, generation: "oversized" }, bytes(largest.slice(0, -1) + "x\n")), /64 KiB/);
      assert.throws(() => store.queue.ingest({ ...source, generation: "pending" }, Buffer.alloc(65537, 120)), /64 KiB/);
      assert.equal(store.queue.ingest({ ...source, generation: "parameters" }, bytes(record("EVENT", Array(256).fill("")))).inserted, 1);
      const tiny = "1|i|q|m|E\n";
      assert.throws(() => store.queue.ingest({ ...source, generation: "too-many" }, bytes(tiny.repeat(50001))), /50,000/);
      assert.equal(store.queue.ingest({ ...source, generation: "count-limit" }, bytes(tiny.repeat(50000))).inserted, 50000);
      assert.equal(store.queue.sources(source.customer).sources.length, 3);
    } finally { store.close(); }
  });
});

test("QF-04: duplicate rows remain separate, prefixes/rebinding fail, explicit generations remain scoped", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    try {
      const snapshot = bytes(record().repeat(2));
      store.queue.ingest(source, snapshot);
      const events = store.queue.read(source).events;
      assert.equal(events[0].sha256, events[1].sha256);
      assert.notEqual(events[0].offset, events[1].offset);
      assert.throws(() => store.queue.ingest(source, snapshot.subarray(0, snapshot.length - 1)), QueuePrefixError);
      assert.throws(() => store.queue.ingest(source, bytes(record("DIFFERENT").repeat(2))), QueuePrefixError);
      assert.throws(() => store.queue.ingest({ ...source, customer: "customer-b" }, snapshot), /bound/);
      store.queue.ingest({ ...source, generation: "second" }, snapshot);
      assert.equal(store.queue.read(source).events.length, 2);
      const page = store.queue.sources(source.customer, undefined, 1);
      assert.ok(page.next);
      assert.equal(store.queue.sources(source.customer, page.next!, 1).sources[0].generation, "second");
    } finally { store.close(); }
  });
});

test("QF-05: colliding CEL/queue/customer IDs and bounded call/source pages never cross scopes", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    try {
      store.ingest({ ...source, customer: "customer-b", timeBasis: "UTC" }, cel);
      const snapshot = bytes(record(), record("CONNECT"), "1|different-id|q|m|EVENT\n");
      store.queue.ingest(source, snapshot);
      store.queue.ingest({ ...source, source: "pbx-b", customer: "customer-b" }, snapshot);
      assert.equal(store.read({ ...source, customer: "customer-b" }).events.length, 1);
      assert.throws(() => store.read(source), /not found/);
      assert.equal(store.queue.read({ ...source, callId: "same-id" }).events.length, 2);
      assert.equal(store.queue.read({ ...source, callId: "missing" }).events.length, 0);
      const first = store.queue.read({ ...source, limit: 1 });
      const second = store.queue.read({ ...source, afterOffset: first.nextAfterOffset!, limit: 1 });
      const last = store.queue.read({ ...source, afterOffset: second.nextAfterOffset!, limit: 1 });
      assert.equal(last.events[0].callId, "different-id");
      assert.equal(last.nextAfterOffset, null);
      assert.throws(() => store.queue.read({ ...source, customer: "customer-b" }), /not found/);
      assert.throws(() => store.queue.read({ ...source, source: "pbx-b" }), /not found/);
      assert.throws(() => store.queue.read({ ...source, generation: "missing" }), /not found/);
      assert.deepEqual(store.queue.sources("customer-c").sources, []);
      for (const limit of [0, 201, 1.5, NaN]) {
        assert.throws(() => store.queue.read({ ...source, limit }), /page/);
        assert.throws(() => store.queue.sources(source.customer, undefined, limit), /page/);
      }
      for (const afterOffset of [-2, 1.5, Infinity]) assert.throws(() => store.queue.read({ ...source, afterOffset }), /page/);
      assert.throws(() => store.queue.read({ ...source, callId: "" }), /query/);
      assert.throws(() => store.queue.ingest({ ...source, customer: "../foreign" }, snapshot), /scope/);
    } finally { store.close(); }
  });
});

test("QF-04/06: injected write failure rolls back queue events and prefix checkpoint", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    const db = new DatabaseSync(database);
    try {
      store.queue.ingest(source, bytes(record()));
      const before = store.queue.read(source);
      db.exec(`CREATE TRIGGER fail_queue BEFORE UPDATE ON queue_sources BEGIN SELECT RAISE(ABORT,'checkpoint write failed'); END;`);
      assert.throws(() => store.queue.ingest(source, bytes(record(), record("CONNECT"))), /checkpoint write/);
      assert.deepEqual(store.queue.read(source), before);
      db.exec("DROP TRIGGER fail_queue");
      assert.equal(store.queue.ingest(source, bytes(record(), record("CONNECT"))).inserted, 1);
    } finally { db.close(); store.close(); }
  });
});

test("QF-06: stored raw/index/checkpoint corruption and read-only writes fail explicitly", async () => {
  await fixture((database) => {
    const store = openCelHistory(database);
    store.queue.ingest(source, bytes(record()));
    store.close();
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.throws(() => reader.queue.ingest(source, bytes(record(), record("CONNECT")))); }
    finally { reader.close(); }
    const db = new DatabaseSync(database);
    const original = db.prepare("SELECT raw FROM queue_events").get()?.raw;
    db.exec("UPDATE queue_events SET call_id='wrong'");
    const corrupt = openCelHistory(database, { readOnly: true });
    try {
      assert.throws(() => corrupt.queue.read(source), /index/);
      db.exec("UPDATE queue_events SET call_id='same-id'");
      db.prepare("UPDATE queue_events SET raw=?").run(bytes(record("CHANGED")));
      assert.throws(() => corrupt.queue.read(source), /Corrupt/);
      assert.ok(original instanceof Uint8Array);
      db.prepare("UPDATE queue_events SET raw=?").run(original);
      db.exec("UPDATE queue_sources SET consumed_bytes=-1");
      assert.throws(() => corrupt.queue.sources(source.customer), /checkpoint/);
    } finally { corrupt.close(); db.close(); }
  });
});

test("QF-04/06: competing importer processes and restart replay insert each position exactly once", async () => {
  await fixture(async (database, directory) => {
    const input = join(directory, "queue_log");
    await writeFile(input, record().repeat(500));
    const results = await Promise.all([1, 2].map(() => execute(process.execPath, importArgs(database, input))));
    assert.equal(results.map((result) => JSON.parse(result.stdout).inserted).reduce((a, b) => a + b), 500);
    assert.equal(JSON.parse((await execute(process.execPath, importArgs(database, input))).stdout).inserted, 0);
    const read = openCelHistory(database, { readOnly: true });
    try {
      assert.equal(read.queue.sources(source.customer).sources[0].records, 500);
      const page = read.queue.read({ ...source, limit: 200 });
      assert.equal(page.events.length, 200);
      assert.equal(page.nextAfterOffset, page.events[199].offset);
    }
    finally { read.close(); }
  });
});

test("QF-06: killed uncommitted process leaves persisted queue evidence/checkpoint unchanged", async () => {
  await fixture(async (database) => {
    const initial = openCelHistory(database);
    initial.queue.ingest(source, bytes(record()));
    const before = initial.queue.read(source);
    initial.close();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE; DELETE FROM queue_events; UPDATE queue_sources SET consumed_bytes=0");
      console.log('uncommitted');
      setInterval(() => {}, 1000);
    `, database], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => {
      child.once("error", reject); child.once("exit", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Queue crash fixture readiness timed out")), 10000);
        child.stdout!.once("data", () => { clearTimeout(timeout); resolve(); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Queue crash fixture exited too early")); });
      });
    } finally { child.kill(); await exited; }
    const reader = openCelHistory(database, { readOnly: true });
    try { assert.deepEqual(reader.queue.read(source), before); }
    finally { reader.close(); }
  });
});

test("QF-06: operator CLI imports and explicit scoped read-only cursors work; invalid commands fail nonzero", async () => {
  await fixture(async (database, directory) => {
    const input = join(directory, "queue_log");
    await writeFile(input, record() + record("CONNECT"));
    await execute(process.execPath, importArgs(database, input));
    const cli = (...args: string[]) => execute(process.execPath, ["scripts\\Manage-QueueHistory.ts", ...args]);
    const prefix = [database, source.customer, source.source, source.generation];
    const first = JSON.parse((await cli("events", ...prefix, "-1", "1")).stdout);
    assert.equal(first.kind, "queue");
    assert.equal(first.events.length, 1);
    const next = JSON.parse((await cli("events", ...prefix, String(first.nextAfterOffset), "1")).stdout);
    assert.equal(next.events[0].event, "CONNECT");
    assert.equal(next.nextAfterOffset, null);
    assert.equal(JSON.parse((await cli("call", ...prefix, "same-id", "-1", "100")).stdout).events.length, 2);
    assert.equal(JSON.parse((await cli("sources", database, source.customer, "-", "-", "100")).stdout).sources.length, 1);
    await assert.rejects(cli("events", database, "customer-b", source.source, source.generation, "-1", "100"));
    await assert.rejects(cli("events", ...prefix, "", "100"));
    await assert.rejects(cli("events", ...prefix, "-1", "201"));
    await assert.rejects(cli("sources", join(directory, "missing.sqlite"), source.customer, "-", "-", "100"));
    await assert.rejects(cli("import", ...prefix, "relative.log"));
  });
});
