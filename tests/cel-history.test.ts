import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { CEL_SNAPSHOT_LIMIT, openCelHistory } from "../src/cel-history.ts";

const execute = promisify(execFile);
const source = { customer: "customer-a", source: "pbx-a", generation: "first", timeBasis: "UTC" };
const query = { customer: source.customer, source: source.source, generation: source.generation };
function record(event = "CHAN_START", uniqueid = "same-id", extra = "", ending = "\n") {
  return ["CHAN_START", "2026-10-25 01:30:00.123456", "PJSIP/1001-0000", uniqueid,
    "shared-linked-id", "sip-proof", "echo", extra].map((value, index) =>
      `"${(index === 0 ? event : value).replaceAll('"', '""')}"`).join(",") + ending;
}
async function fixture(action: (path: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "cel-history-"));
  try { await action(join(directory, "history.sqlite"), directory); }
  finally { await rm(directory, { recursive: true }); }
}
const importArgs = (db: string, input: string) => ["scripts\\Manage-CelHistory.ts", "import", db,
  source.customer, source.source, source.generation, source.timeBasis, input];

test("HF-01/02: exact quoted UTF-8 evidence, CRLF and embedded newlines round trip", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const raw = record("PROOF_SIP_DIALOG", "same-id", '{"extra":"quote \\" and café\\n"}\nnext', "\r\n");
      const bytes = Buffer.from(raw);
      const result = store.ingest(source, bytes);
      assert.equal(result.inserted, 1);
      assert.equal(result.consumedBytes, bytes.length);
      const event = store.read(query).events[0];
      assert.equal(event.rawRecord, raw);
      assert.equal(event.endOffset, bytes.length);
      assert.equal(event.sourceTimestamp, "2026-10-25 01:30:00.123456");
      assert.equal(event.extra, '{"extra":"quote \\" and café\\n"}\nnext');
      assert.equal(store.read(query).source.timeBasis, "UTC");
      assert.equal("outcome" in event, false);
      assert.equal("journeyId" in event, false);
    } finally { store.close(); }
  });
});

test("HF-02/03: partial quoted/multibyte tails wait for completion; replay and restart preserve offsets", async () => {
  await fixture((path) => {
    const first = record();
    const second = record("ANSWER", "same-id", "café\nquoted");
    const complete = Buffer.from(first + second);
    let store = openCelHistory(path);
    try {
      const cut = Buffer.from(first + second.slice(0, second.indexOf("é"))).length + 1;
      const pending = store.ingest(source, complete.subarray(0, cut));
      assert.equal(pending.inserted, 1);
      assert.equal(pending.consumedBytes, Buffer.byteLength(first));
      assert.ok(pending.pendingBytes > 0);
      const before = store.read(query).events;
      store.close();
      store = openCelHistory(path);
      assert.deepEqual(store.read(query).events, before);
      assert.equal(store.ingest(source, complete).inserted, 1);
      assert.equal(store.ingest(source, complete).inserted, 0);
      const events = store.read(query).events;
      assert.equal(events.length, 2);
      assert.deepEqual(events[0], before[0]);
      assert.equal(events[1].offset, Buffer.byteLength(first));
      assert.equal(events[1].endOffset, complete.length);
    } finally { store.close(); }
  });
});

test("HF-03: identical source rows at distinct positions are separate evidence", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      assert.equal(store.ingest(source, Buffer.from(record().repeat(2))).inserted, 2);
      const events = store.read(query).events;
      assert.equal(events[0].sha256, events[1].sha256);
      assert.notEqual(events[0].offset, events[1].offset);
    } finally { store.close(); }
  });
});

test("HF-02/03: malformed complete input fails without partially advancing the checkpoint", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const first = record();
      store.ingest(source, Buffer.from(first));
      const before = store.sources(source.customer);
      for (const suffix of ['a,b,c\n', 'unquoted"field\n', '"closed"x\n', '"closed"\rwrong\n',
        record().replace('"CHAN_START"', '"CHAN_START"x'),
        record().replace('"CHAN_START"', 'CHAN"START"'), record().replace('"CHAN_START"', '""')]) {
        assert.throws(() => store.ingest(source, Buffer.from(first + record("ANSWER") + suffix)));
        assert.deepEqual(store.sources(source.customer), before);
        assert.equal(store.read(query).events.length, 1);
      }
      assert.throws(() => store.ingest(source, Buffer.concat([Buffer.from(first), Buffer.from([0xff, 10])])));
      assert.throws(() => store.ingest({ ...source, generation: "bom" },
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(first)])), /quoting/);
      assert.deepEqual(store.sources(source.customer), before);
      assert.throws(() => store.ingest({ ...source, generation: "bad" }, Buffer.from("bad\n")));
      assert.equal(store.sources(source.customer).sources.length, 1);
    } finally { store.close(); }
  });
});

test("HF-02/06: byte, record, page and scope boundaries fail explicitly", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      assert.throws(() => store.ingest(source, Buffer.alloc(CEL_SNAPSHOT_LIMIT + 1)), /8 MiB/);
      assert.throws(() => store.ingest(source, Buffer.from(record("ANSWER", "id", "x".repeat(65536)))), /64 KiB/);
      assert.throws(() => store.ingest(source, Buffer.from('"' + "x".repeat(65536))), /64 KiB/);
      assert.throws(() => store.ingest({ ...source, customer: "../other" }, Buffer.from(record())), /scope/);
      assert.throws(() => store.ingest({ ...source, timeBasis: "" }, Buffer.from(record())), /time basis/);
      assert.throws(() => store.ingest({ ...source, timeBasis: "Invented/Zone" }, Buffer.from(record())));
      store.ingest(source, Buffer.from(record()));
      for (const limit of [0, 201, 1.5, NaN]) assert.throws(() => store.read({ ...query, limit }), /page/);
      for (const afterOffset of [-2, 1.2, Infinity]) assert.throws(() => store.read({ ...query, afterOffset }), /page/);
      assert.throws(() => store.read({ ...query, uniqueid: "" }), /query/);
      assert.throws(() => store.sources("customer-a", undefined, 201), /limit/);
    } finally { store.close(); }
  });
});

test("HF-02: exact snapshot/record limits pass; excessive record count fails atomically", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const overhead = Buffer.byteLength(record("ANSWER", "id"));
      const largest = record("ANSWER", "id", "x".repeat(65536 - overhead));
      assert.equal(Buffer.byteLength(largest), 65536);
      const full = Buffer.from(largest.repeat(128));
      assert.equal(full.length, CEL_SNAPSHOT_LIMIT);
      assert.equal(store.ingest(source, full).inserted, 128);
      assert.equal(store.ingest(source, full).inserted, 0);
      const minimal = "e,t,c,u,l,,,\n";
      assert.throws(() => store.ingest({ ...source, generation: "too-many" }, Buffer.from(minimal.repeat(50001))), /50,000/);
      assert.equal(store.sources(source.customer).sources.length, 1);
      assert.equal(store.ingest({ ...source, generation: "maximum-count" }, Buffer.from(minimal.repeat(50000))).inserted, 50000);
    } finally { store.close(); }
  });
});

test("HF-04: changed/truncated prefixes and rebinding fail; explicit generations stay separate", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const original = Buffer.from(record());
      store.ingest(source, original);
      assert.throws(() => store.ingest(source, original.subarray(0, original.length - 1)), /truncated/);
      assert.throws(() => store.ingest(source, Buffer.from(record("OTHER"))), /changed/);
      assert.throws(() => store.ingest({ ...source, customer: "customer-b" }, original), /bound/);
      assert.throws(() => store.ingest({ ...source, timeBasis: "Europe/London" }, original), /bound/);
      store.ingest({ ...source, generation: "replacement" }, original);
      const first = store.sources(source.customer, undefined, 1);
      assert.equal(first.sources.length, 1);
      assert.ok(first.next);
      assert.equal(store.sources(source.customer, first.next!, 1).sources[0].generation, "replacement");
      assert.equal(store.read(query).events.length, 1);
    } finally { store.close(); }
  });
});

test("HF-05: customer/source/generation/channel-scoped pages isolate colliding identifiers", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const bytes = Buffer.from(record() + record("ANSWER") + record("HANGUP", "different-id"));
      store.ingest(source, bytes);
      store.ingest({ ...source, source: "pbx-b", customer: "customer-b" }, bytes);
      const first = store.read({ ...query, limit: 1 });
      const second = store.read({ ...query, afterOffset: first.nextAfterOffset!, limit: 1 });
      assert.equal(first.events[0].event, "CHAN_START");
      assert.equal(second.events[0].event, "ANSWER");
      const last = store.read({ ...query, afterOffset: second.nextAfterOffset!, limit: 1 });
      assert.equal(last.events[0].event, "HANGUP");
      assert.equal(last.nextAfterOffset, null);
      assert.equal(store.read({ ...query, uniqueid: "same-id" }).events.length, 2);
      assert.equal(store.read({ ...query, uniqueid: "absent" }).events.length, 0);
      assert.equal(store.sources("customer-b").sources[0].source, "pbx-b");
      assert.deepEqual(store.sources("customer-c").sources, []);
      assert.throws(() => store.read({ ...query, customer: "customer-b" }), /not found/);
      assert.throws(() => store.read({ ...query, source: "pbx-b" }), /not found/);
      assert.throws(() => store.read({ ...query, generation: "missing" }), /not found/);
    } finally { store.close(); }
  });
});

test("HF-03/06: SQL failure rolls back records and checkpoint together", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    const db = new DatabaseSync(path);
    try {
      const first = record();
      store.ingest(source, Buffer.from(first));
      db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON cel_events WHEN NEW.offset > ${Buffer.byteLength(first)}
        BEGIN SELECT RAISE(ABORT, 'injected storage failure'); END;`);
      assert.throws(() => store.ingest(source, Buffer.from(first + record("ANSWER") + record("HANGUP"))), /injected/);
      assert.equal(store.read(query).events.length, 1);
      assert.equal(store.read(query).source.consumedBytes, Buffer.byteLength(first));
      db.exec("DROP TRIGGER fail_insert");
      assert.equal(store.ingest(source, Buffer.from(first + record("ANSWER"))).inserted, 1);
    } finally { db.close(); store.close(); }
  });
});

test("HF-06: dedicated database, schema identity, read-only use and corrupt evidence fail closed", async () => {
  await fixture((path, directory) => {
    assert.throws(() => openCelHistory("relative.sqlite"), /absolute/);
    const alien = join(directory, "alien.sqlite");
    const wrong = new DatabaseSync(alien);
    wrong.exec("CREATE TABLE other (value TEXT); PRAGMA user_version=1");
    wrong.close();
    assert.throws(() => openCelHistory(alien), /supported/);
    const store = openCelHistory(path);
    store.ingest(source, Buffer.from(record()));
    store.close();
    const read = openCelHistory(path, { readOnly: true });
    try {
      assert.equal(read.read(query).events.length, 1);
      assert.throws(() => read.ingest(source, Buffer.from(record() + record("ANSWER"))));
    } finally { read.close(); }
    const db = new DatabaseSync(path);
    db.prepare("UPDATE cel_events SET raw=?").run(Buffer.from(record("DIFFERENT")));
    db.close();
    const corrupt = openCelHistory(path, { readOnly: true });
    try { assert.throws(() => corrupt.read(query), /Corrupt/); }
    finally { corrupt.close(); }
  });
});

test("HF-03/07: separate importer processes serialize replay and restart without duplicates", async () => {
  await fixture(async (path, directory) => {
    const input = join(directory, "snapshot.csv");
    const bytes = Buffer.from(record().repeat(500));
    await writeFile(input, bytes);
    const results = await Promise.all([1, 2].map(() => execute(process.execPath, importArgs(path, input))));
    const imports = results.map((result) => JSON.parse(result.stdout));
    assert.equal(imports.reduce((sum, result) => sum + result.inserted, 0), 500);
    assert.equal(JSON.parse((await execute(process.execPath, importArgs(path, input))).stdout).inserted, 0);
    const read = openCelHistory(path, { readOnly: true });
    try { assert.equal(read.sources(source.customer).sources[0].records, 500); }
    finally { read.close(); }
  });
});

test("HF-03/07: process death inside an uncommitted transaction leaves prior evidence intact", async () => {
  await fixture(async (path) => {
    const store = openCelHistory(path);
    store.ingest(source, Buffer.from(record()));
    const before = store.read(query);
    store.close();
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec("BEGIN IMMEDIATE; DELETE FROM cel_events; UPDATE cel_sources SET consumed_bytes=0");
      console.log("uncommitted");
      setInterval(() => {}, 1000);
    `, path], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => resolve());
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Crash fixture readiness timed out")), 10000);
        child.stdout!.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Crash fixture exited before readiness")); });
      });
    } finally { child.kill(); await exit; }
    const read = openCelHistory(path, { readOnly: true });
    try { assert.deepEqual(read.read(query), before); }
    finally { read.close(); }
  });
});

test("HF-05/07: operator CLI reads are explicit, bounded, read-only and customer scoped", async () => {
  await fixture(async (path, directory) => {
    const input = join(directory, "snapshot.csv");
    await writeFile(input, record() + record("ANSWER"));
    await execute(process.execPath, importArgs(path, input));
    const cli = (...args: string[]) => execute(process.execPath, ["scripts\\Manage-CelHistory.ts", ...args]);
    const page = JSON.parse((await cli("events", path, source.customer, source.source, source.generation, "-1", "1")).stdout);
    assert.equal(page.events.length, 1);
    assert.notEqual(page.nextAfterOffset, null);
    const channels = JSON.parse((await cli("channel", path, source.customer, source.source, source.generation, "same-id", "-1", "200")).stdout);
    assert.equal(channels.events.length, 2);
    const sources = JSON.parse((await cli("sources", path, source.customer, "-", "-", "100")).stdout);
    assert.equal(sources.sources.length, 1);
    await assert.rejects(cli("events", path, "customer-b", source.source, source.generation, "-1", "100"));
    await assert.rejects(cli("events", path, source.customer, source.source, source.generation, "", "100"));
    await assert.rejects(cli("events", path, source.customer, source.source, source.generation, "-1", "201"));
    await assert.rejects(cli("sources", join(directory, "missing.sqlite"), source.customer, "-", "-", "100"));
  });
});
