import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { openAgentStore } from "../src/agent-store.ts";
import { createHash } from "node:crypto";

const alice = { issuer: "https://identity.example", subject: "alice", customer: "customer-a",
  extension: "1001", displayName: "Alice \u00e9" };
const context = { operator: "operator-test", reason: "Synthetic provisioning \u00e9" };

test("agent assignments persist exactly, provision atomically and refuse implicit reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-store-"));
  const path = join(directory, "agents.sqlite");
  let store = openAgentStore(path);
  let closed = false;
  try {
    const first = store.provision([alice], context);
    assert.equal(first.inserted, 1);
    assert.equal(first.unchanged, 0);
    const repeat = store.provision([alice], context);
    assert.equal(repeat.inserted, 0);
    assert.equal(repeat.unchanged, 1);
    assert.notEqual(first.id, repeat.id);
    assert.equal(first.sha256, repeat.sha256);
    store.close();
    closed = true;
    store = openAgentStore(path);
    closed = false;
    assert.deepEqual(store.profile(alice.issuer, "alice", "customer-a"), { extension: "1001", displayName: "Alice \u00e9" });
    assert.equal(store.profile("https://foreign.example", "alice", "customer-a"), undefined);
    assert.equal(store.profile(alice.issuer, "bob", "customer-a"), undefined);
    assert.equal(store.profile(alice.issuer, "alice", "customer-b"), undefined);
    const bob = { ...alice, subject: "bob", extension: "1002" };
    assert.throws(() => store.provision([bob, { ...alice, extension: "9999" }], context), /different provisioned/);
    assert.equal(store.profile(alice.issuer, "bob", "customer-a"), undefined, "A late conflict must roll back earlier inserts");
    assert.throws(() => store.provision([{ ...alice, displayName: "Changed name" }], context), /different provisioned/);
    assert.throws(() => store.provision([bob, bob], context), /duplicate/);
    assert.throws(() => store.provision([bob, { ...alice, extension: "invalid" }], context), /Invalid/);
    assert.equal(store.provision([{ ...alice, customer: "customer-b", extension: "2001" }, bob], context).inserted, 2);
    const profile = store.profile(alice.issuer, "alice", "customer-a");
    assert.ok(profile);
    profile.extension = "9999";
    assert.equal(store.profile(alice.issuer, "alice", "customer-a")?.extension, "1001");
    const writer = new DatabaseSync(path);
    try {
      writer.exec("BEGIN IMMEDIATE");
      try { assert.throws(() => store.provision([{ ...alice, subject: "blocked" }], context), /locked/); }
      finally { writer.exec("ROLLBACK"); }
      assert.equal(store.profile(alice.issuer, "blocked", "customer-a"), undefined);
      writer.prepare("UPDATE agent_assignments SET extension = ? WHERE subject = ? AND customer = ?")
        .run("private-invalid", "alice", "customer-a");
      assert.throws(() => store.profile(alice.issuer, "alice", "customer-a"), /Invalid/);
      assert.throws(() => store.provision([alice], context), /Invalid/);
      assert.equal(writer.prepare("SELECT count(*) AS total FROM agent_provision_receipts").get()?.total, 3);
      const receipt = writer.prepare("SELECT * FROM agent_provision_receipts WHERE id = ?").get(first.id);
      assert.ok(receipt);
      assert.equal(receipt.operator, context.operator);
      assert.equal(receipt.reason, context.reason);
      assert.equal(receipt.timestamp, first.timestamp);
      assert.equal(receipt.assignments, JSON.stringify([alice]));
      assert.equal(receipt.sha256, createHash("sha256").update(JSON.stringify([alice])).digest("hex"));
    } finally { writer.close(); }
    store.close();
    closed = true;
    assert.throws(() => store.profile(alice.issuer, "bob", "customer-a"));
    assert.throws(() => store.provision([bob], context));
  } finally {
    if (!closed) store.close();
    await rm(directory, { recursive: true });
  }
});

test("agent store rejects relative paths, foreign schemas and corrupt files", async () => {
  assert.throws(() => openAgentStore("relative.sqlite"), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-invalid-"));
  try {
    for (const [name, sql] of [
      ["foreign", "CREATE TABLE unrelated (value TEXT)"],
      ["version", "PRAGMA user_version = 99"],
      ["incomplete", "PRAGMA user_version = 1"],
    ]) {
      const path = join(directory, `${name}.sqlite`);
      const db = new DatabaseSync(path);
      db.exec(sql);
      db.close();
      assert.throws(() => openAgentStore(path), /nonempty|Unsupported|no such table/);
    }
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, "not SQLite");
    assert.throws(() => openAgentStore(corrupt), /not a database/);
  } finally { await rm(directory, { recursive: true }); }
});

test("operator CLI persists assignments, reports counts and refuses changed input", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-cli-"));
  const path = join(directory, "agents.sqlite");
  const input = join(directory, "assignments.json");
  const script = fileURLToPath(new URL("../scripts/Provision-AgentAssignments.ts", import.meta.url));
  const execute = promisify(execFile);
  const run = () => execute(process.execPath, [script, path, input, context.operator, context.reason], { timeout: 10000 });
  try {
    await writeFile(input, JSON.stringify([alice]));
    const first = JSON.parse((await run()).stdout);
    assert.equal(first.inserted, 1);
    assert.equal(first.unchanged, 0);
    assert.match(first.id, /^[0-9a-f-]{36}$/);
    assert.ok(Number.isFinite(Date.parse(first.timestamp)));
    assert.equal(first.sha256, createHash("sha256").update(JSON.stringify([alice])).digest("hex"));
    const repeat = JSON.parse((await run()).stdout);
    assert.equal(repeat.inserted, 0);
    assert.equal(repeat.unchanged, 1);
    assert.notEqual(first.id, repeat.id);
    await writeFile(input, JSON.stringify([{ ...alice, extension: "2002" }]));
    await assert.rejects(run(), /different provisioned/);
    const store = openAgentStore(path);
    try { assert.equal(store.profile(alice.issuer, "alice", "customer-a")?.extension, "1001"); }
    finally { store.close(); }
    await writeFile(input, '{"invalid":"not an array"}');
    await assert.rejects(run(), /JSON array/);
    await assert.rejects(execute(process.execPath, [script, "relative.sqlite", input]), /Usage:/);
  } finally { await rm(directory, { recursive: true }); }
});

test("provision receipt failure rolls back assignments and migration preserves legacy rows without invented receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-receipts-"));
  const path = join(directory, "legacy.sqlite");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE agent_assignments (
    issuer TEXT NOT NULL, subject TEXT NOT NULL, customer TEXT NOT NULL,
    extension TEXT NOT NULL, display_name TEXT NOT NULL,
    PRIMARY KEY (issuer, subject, customer)) STRICT;
    PRAGMA user_version = 1;`);
  legacy.prepare("INSERT INTO agent_assignments VALUES (?, ?, ?, ?, ?)")
    .run(alice.issuer, alice.subject, alice.customer, alice.extension, alice.displayName);
  legacy.close();
  const store = openAgentStore(path);
  const observer = new DatabaseSync(path);
  try {
    assert.equal(observer.prepare("PRAGMA user_version").get()?.user_version, 2);
    assert.equal(store.profile(alice.issuer, alice.subject, alice.customer)?.extension, "1001");
    assert.equal(observer.prepare("SELECT count(*) AS total FROM agent_provision_receipts").get()?.total, 0);
    for (const invalid of [{ operator: "", reason: "Test" }, { operator: "Test", reason: "\n" },
      { operator: "x".repeat(201), reason: "Test" }, { operator: "Test", reason: "x".repeat(2001) }]) {
      assert.throws(() => store.provision([alice], invalid), /bounded operator and reason/);
    }
    observer.exec(`CREATE TRIGGER refuse_receipt BEFORE INSERT ON agent_provision_receipts
      BEGIN SELECT RAISE(ABORT, 'Synthetic provisioning receipt failure'); END;`);
    const bob = { ...alice, subject: "bob", extension: "1002" };
    assert.throws(() => store.provision([bob], context), /Synthetic provisioning receipt failure/);
    assert.equal(store.profile(alice.issuer, "bob", alice.customer), undefined);
    assert.equal(observer.prepare("SELECT count(*) AS total FROM agent_provision_receipts").get()?.total, 0);
    observer.exec("DROP TRIGGER refuse_receipt");
    const receipt = store.provision([alice, bob], { operator: "x".repeat(200), reason: "x".repeat(2000) });
    assert.equal(receipt.inserted, 1);
    assert.equal(receipt.unchanged, 1);
    assert.equal(observer.prepare("SELECT count(*) AS total FROM agent_provision_receipts").get()?.total, 1);
    const empty = store.provision([], { operator: " operator ", reason: " reason \u00e9 " });
    assert.equal(empty.inserted, 0);
    assert.equal(empty.unchanged, 0);
    assert.equal(empty.sha256, createHash("sha256").update("[]").digest("hex"));
    const exact = observer.prepare("SELECT operator, reason, assignments FROM agent_provision_receipts WHERE id = ?").get(empty.id);
    assert.deepEqual({ ...exact }, { operator: " operator ", reason: " reason \u00e9 ", assignments: "[]" });
  } finally { observer.close(); store.close(); await rm(directory, { recursive: true }); }
});
