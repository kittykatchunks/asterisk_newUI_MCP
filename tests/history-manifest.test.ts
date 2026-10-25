import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openCelHistory } from "../src/cel-history.ts";
import type { HistoryManifest } from "../src/history-manifest.ts";
import { inspectHistoryMarker } from "../src/history-markers.ts";

const execute = promisify(execFile);
const scope = { customer: "customer-a", source: "pbx-a", generation: "stream-1" };
const journeyId = "11111111-1111-4111-8111-111111111111";
const visitId = "22222222-2222-4222-8222-222222222222";
const route = { context: "history-marker", extension: "entry", routeRevision: "marker-v1", entryKind: "synthetic" as const };
const entry = { v: 1, journeyId, entryKind: "synthetic", routeRevision: "marker-v1" };
const visit = { v: 1, journeyId, visitId, queue: "proof-queue", routeRevision: "marker-v1" };
function record(event = "HISTORY_ENTRY", payload: unknown = entry, context = route.context,
  extra = JSON.stringify({ extra: JSON.stringify(payload) })) {
  return Buffer.from([event, "2026-10-25 02:00:00", "Local/entry;2", "same-id", "same-linked",
    context, route.extension, extra].map((value) => `"${value.replaceAll('"', '""')}"`).join(",") + "\n");
}
const queue = Buffer.from("1792890000|same-id|proof-queue|NONE|ENTERQUEUE|||1\n");
function manifest(end: number): HistoryManifest {
  return { customer: scope.customer, runtime: "pbx-runtime-a", epoch: "boot-1", operator: "test-operator",
    reason: "Controlled synthetic source", routes: [route],
    ranges: [{ kind: "cel", source: scope.source, generation: scope.generation, start: 0, end }] };
}
async function fixture(action: (path: string, directory: string) => unknown | Promise<unknown>) {
  const directory = await mkdtemp(join(tmpdir(), "history-manifest-"));
  try { await action(join(directory, "history.sqlite"), directory); }
  finally { await rm(directory, { recursive: true }); }
}

test("MM-01: schema 3 migrates preserving raw evidence and leaving it unassigned; legacy reads still work", async () => {
  await fixture((path, directory) => {
    const store = openCelHistory(path);
    const raw = record();
    store.ingest({ ...scope, timeBasis: "UTC" }, raw);
    store.queue.ingest(scope, queue);
    store.configureCollector({ ...scope, timeBasis: "UTC", path: join(directory, "Master.csv"), staleAfterMs: 1000 }, 1000);
    store.transitionCollector(scope.customer, scope.source, "stream-2", "operator-test", "Explicit unknown coverage", 2000);
    const before = { cel: store.read(scope), queue: store.queue.read(scope),
      collector: store.collectorStatus(scope.customer, scope.source, 3000),
      gaps: store.collectionGaps(scope.customer, scope.source) };
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; PRAGMA user_version=3");
    legacy.close();
    const reader = openCelHistory(path, { readOnly: true });
    try {
      assert.deepEqual(reader.read(scope), before.cel);
      assert.deepEqual(reader.queue.read(scope), before.queue);
      assert.deepEqual(reader.collectorStatus(scope.customer, scope.source, 3000), before.collector);
      assert.deepEqual(reader.collectionGaps(scope.customer, scope.source), before.gaps);
      assert.throws(() => reader.manifests.list(scope.customer), /schema 4/);
    } finally { reader.close(); }
    const migrated = openCelHistory(path);
    try {
      assert.deepEqual(migrated.read(scope), before.cel);
      assert.deepEqual(migrated.queue.read(scope), before.queue);
      assert.deepEqual(migrated.manifests.list(scope.customer).manifests, []);
      assert.equal(migrated.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, 0).status, "unassigned");
      migrated.manifests.register(manifest(raw.length));
      assert.deepEqual(migrated.collectorStatus(scope.customer, scope.source, 3000), before.collector);
      assert.deepEqual(migrated.collectionGaps(scope.customer, scope.source), before.gaps);
    } finally { migrated.close(); }
  });
});

test("MM-01: migration failure rolls back schema and preserves original raw reads", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    store.ingest({ ...scope, timeBasis: "UTC" }, record());
    const before = store.read(scope);
    store.close();
    const db = new DatabaseSync(path);
    db.exec("DROP TABLE history_ranges; DROP TABLE history_manifests; PRAGMA user_version=3; CREATE TABLE history_ranges(blocker TEXT)");
    db.close();
    assert.throws(() => openCelHistory(path), /already exists/);
    const check = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA user_version").get()?.user_version, 3);
      assert.equal(check.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='history_manifests'").get()?.count, 0);
    } finally { check.close(); }
    const reader = openCelHistory(path, { readOnly: true });
    try { assert.deepEqual(reader.read(scope), before); }
    finally { reader.close(); }
  });
});

test("MM-02/03: exact boundaries, immutable overlap rejection, epoch splits and unassigned append", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const first = record();
      const second = record("HISTORY_QUEUE_VISIT", visit);
      store.ingest({ ...scope, timeBasis: "UTC" }, Buffer.concat([first, second]));
      const registered = store.manifests.register(manifest(first.length));
      assert.deepEqual(store.manifests.register(manifest(first.length)), registered);
      assert.equal(store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, first.length).status, "unassigned");
      for (const range of [{ start: 1, end: first.length }, { start: 0, end: first.length - 1 },
        { start: 0, end: first.length + second.length + 1 }]) {
        const value = manifest(first.length);
        value.ranges[0] = { ...value.ranges[0], ...range };
        assert.throws(() => store.manifests.register(value));
      }
      assert.throws(() => store.manifests.register({ ...manifest(first.length), reason: "reassign", epoch: "other" }), /overlap/);
      const next = manifest(first.length + second.length);
      next.epoch = "boot-2"; next.ranges[0].start = first.length;
      store.manifests.register(next);
      assert.equal(store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, first.length).assignment?.epoch, "boot-2");
      const third = record("CHAN_END", {});
      store.ingest({ ...scope, timeBasis: "UTC" }, Buffer.concat([first, second, third]));
      assert.equal(store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, first.length + second.length).status, "unassigned");
      const wrongRuntime = manifest(first.length + second.length + third.length);
      wrongRuntime.runtime = "wrong-runtime"; wrongRuntime.ranges[0].start = first.length + second.length;
      assert.throws(() => store.manifests.register(wrongRuntime), /runtime/);
      assert.equal(store.manifests.list(scope.customer).manifests.length, 2);
      const page = store.manifests.list(scope.customer, 0, 1);
      assert.equal(page.manifests.length, 1);
      assert.equal(page.nextAfterId, registered.id);
      assert.equal(store.manifests.list(scope.customer, page.nextAfterId!, 1).manifests[0].epoch, "boot-2");
    } finally { store.close(); }
  });
});

test("MM-02/03: source-kind/customer collisions and multiple generations stay explicitly scoped", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const raw = record();
      store.ingest({ ...scope, timeBasis: "UTC" }, raw);
      store.ingest({ ...scope, generation: "stream-2", timeBasis: "UTC" }, raw);
      store.queue.ingest({ ...scope, customer: "customer-b" }, queue);
      const value = manifest(raw.length);
      value.ranges.push({ ...value.ranges[0], generation: "stream-2" });
      store.manifests.register(value);
      assert.equal(store.manifests.resolve(scope.customer, "cel", scope.source, "stream-2", 0).assignment?.epoch, "boot-1");
      assert.equal(store.manifests.resolve("customer-b", "queue", scope.source, scope.generation, 0).status, "unassigned");
      assert.throws(() => store.manifests.resolve("customer-b", "cel", scope.source, scope.generation, 0), /not found/);
      assert.throws(() => store.manifests.resolve(scope.customer, "queue", scope.source, scope.generation, 0), /not found/);
      assert.deepEqual(store.manifests.list("customer-b").manifests, []);
      const foreignRange = manifest(raw.length);
      foreignRange.ranges = [{ kind: "queue", source: scope.source, generation: scope.generation, start: 0, end: queue.length }];
      assert.throws(() => store.manifests.register(foreignRange), /not found/);
    } finally { store.close(); }
  });
});

test("MM-03: failed batch and duplicate intra-batch ranges roll back all assignments", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    const db = new DatabaseSync(path);
    try {
      store.ingest({ ...scope, timeBasis: "UTC" }, record());
      const value = manifest(record().length);
      value.ranges.push({ ...value.ranges[0] });
      assert.throws(() => store.manifests.register(value), /overlap/);
      assert.equal(store.manifests.list(scope.customer).manifests.length, 0);
      db.exec("CREATE TRIGGER fail_range BEFORE INSERT ON history_ranges BEGIN SELECT RAISE(ABORT,'injected range failure'); END;");
      assert.throws(() => store.manifests.register(manifest(record().length)), /injected/);
      assert.equal(store.manifests.list(scope.customer).manifests.length, 0);
    } finally { db.close(); store.close(); }
  });
});

test("MM-04: marker inspection requires assigned trusted route, exact schemas/revision/kind and valid UUIDs", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    try {
      const rows = [record(), record("HISTORY_QUEUE_VISIT", visit), record("ANSWER", {}),
        record("HISTORY_ENTRY", entry, "spoofed-context"), record("HISTORY_ENTRY", { ...entry, journeyId: "caller-supplied" }),
        record("HISTORY_ENTRY", { ...entry, routeRevision: "different" }), record("HISTORY_ENTRY", { ...entry, entryKind: "external" }),
        record("HISTORY_QUEUE_VISIT", { ...visit, visitId: journeyId }), record("HISTORY_ENTRY", { ...entry, extra: true }),
        record("HISTORY_QUEUE_VISIT", { ...visit, queue: "../wrong" }), record("HISTORY_ENTRY", null)];
      rows.push(record("HISTORY_ENTRY", entry, route.context, "{"),
        record("HISTORY_ENTRY", entry, route.context, JSON.stringify({ extra: "{" })));
      const bytes = Buffer.concat(rows);
      store.ingest({ ...scope, timeBasis: "UTC" }, bytes);
      assert.equal(inspectHistoryMarker(store, scope.customer, scope.source, scope.generation, 0).markerStatus, "unassigned");
      store.manifests.register(manifest(bytes.length));
      let offset = 0;
      const statuses = [];
      for (const row of rows) {
        statuses.push(inspectHistoryMarker(store, scope.customer, scope.source, scope.generation, offset).markerStatus);
        offset += row.length;
      }
      assert.deepEqual(statuses, ["validated-marker", "validated-marker", "not-marker", "untrusted-route",
        ...Array(9).fill("invalid-marker")]);
      const observed = inspectHistoryMarker(store, scope.customer, scope.source, scope.generation, 0);
      assert.ok(observed.assignment?.manifestSha256);
      assert.equal("journeyCount" in observed, false);
    } finally { store.close(); }
  });
});

test("MM-02/06: bounded input/read-only pages, malformed manifests and corrupt assignments fail explicitly", async () => {
  await fixture((path) => {
    const store = openCelHistory(path);
    const db = new DatabaseSync(path);
    try {
      store.ingest({ ...scope, timeBasis: "UTC" }, record());
      for (const change of [{ ranges: [] }, { runtime: "../bad" }, { reason: "" }, { routes: [route, route] },
        { ranges: Array(101).fill(manifest(record().length).ranges[0]) }, { extra: true },
        { routes: [{ ...route, entryKind: "unknown" }] }]) {
        assert.throws(() => store.manifests.register({ ...manifest(record().length), ...change }));
      }
      assert.throws(() => store.manifests.list(scope.customer, 0, 201), /page/);
      assert.throws(() => store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, 1), /not found/);
      db.prepare("UPDATE cel_events SET raw=?").run(Buffer.alloc(record().length, 120));
      assert.throws(() => store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, 0), /Corrupt/);
      assert.throws(() => store.manifests.register(manifest(record().length)), /intact/);
      assert.equal(store.manifests.list(scope.customer).manifests.length, 0);
      db.prepare("UPDATE cel_events SET raw=?").run(record());
      store.manifests.register(manifest(record().length));
      db.prepare("UPDATE history_ranges SET evidence_sha256=?").run("0".repeat(64));
      assert.throws(() => store.manifests.resolve(scope.customer, "cel", scope.source, scope.generation, 0), /Corrupt/);
      assert.throws(() => store.manifests.register(manifest(record().length)), /Corrupt/);
      db.exec("UPDATE history_manifests SET runtime='wrong'");
      assert.throws(() => store.manifests.list(scope.customer), /Corrupt/);
    } finally { db.close(); store.close(); }
  });
});

test("MM-03/06: competing operator registrations are idempotent and persisted CLI reads remain scoped", async () => {
  await fixture(async (path, directory) => {
    const store = openCelHistory(path);
    store.ingest({ ...scope, timeBasis: "UTC" }, record());
    store.close();
    const file = join(directory, "manifest.json");
    await writeFile(file, JSON.stringify(manifest(record().length)));
    const cli = (...args: string[]) => execute(process.execPath, ["scripts\\Manage-HistoryManifest.ts", ...args]);
    const results = await Promise.all([1, 2].map(() => cli("register", path, scope.customer, file)));
    assert.equal(JSON.parse(results[0].stdout).id, JSON.parse(results[1].stdout).id);
    const list = JSON.parse((await cli("list", path, scope.customer, "0", "1")).stdout);
    assert.equal(list.manifests.length, 1);
    assert.equal(JSON.parse((await cli("resolve", path, scope.customer, "cel", scope.source, scope.generation, "0")).stdout).status, "assigned");
    assert.equal(JSON.parse((await cli("marker", path, scope.customer, scope.source, scope.generation, "0")).stdout).markerStatus, "validated-marker");
    await assert.rejects(cli("register", path, "customer-b", file));
    await assert.rejects(cli("resolve", path, "customer-b", "cel", scope.source, scope.generation, "0"));
    await assert.rejects(cli("list", path, scope.customer, "0", "201"));
    await writeFile(file, " ".repeat(65537));
    await assert.rejects(cli("register", path, scope.customer, file), /64 KiB/);
    const reader = openCelHistory(path, { readOnly: true });
    try { assert.throws(() => reader.manifests.register(manifest(record().length))); }
    finally { reader.close(); }
  });
});
