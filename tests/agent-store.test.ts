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

const alice = { issuer: "https://identity.example", subject: "alice", customer: "customer-a",
  extension: "1001", displayName: "Alice \u00e9" };

test("agent assignments persist exactly, provision atomically and refuse implicit reassignment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-store-"));
  const path = join(directory, "agents.sqlite");
  let store = openAgentStore(path);
  let closed = false;
  try {
    assert.deepEqual(store.provision([alice]), { inserted: 1, unchanged: 0 });
    assert.deepEqual(store.provision([alice]), { inserted: 0, unchanged: 1 });
    store.close();
    closed = true;
    store = openAgentStore(path);
    closed = false;
    assert.deepEqual(store.profile(alice.issuer, "alice", "customer-a"), { extension: "1001", displayName: "Alice \u00e9" });
    assert.equal(store.profile("https://foreign.example", "alice", "customer-a"), undefined);
    assert.equal(store.profile(alice.issuer, "bob", "customer-a"), undefined);
    assert.equal(store.profile(alice.issuer, "alice", "customer-b"), undefined);
    const bob = { ...alice, subject: "bob", extension: "1002" };
    assert.throws(() => store.provision([bob, { ...alice, extension: "9999" }]), /different provisioned/);
    assert.equal(store.profile(alice.issuer, "bob", "customer-a"), undefined, "A late conflict must roll back earlier inserts");
    assert.throws(() => store.provision([{ ...alice, displayName: "Changed name" }]), /different provisioned/);
    assert.throws(() => store.provision([bob, bob]), /duplicate/);
    assert.throws(() => store.provision([bob, { ...alice, extension: "invalid" }]), /Invalid/);
    assert.deepEqual(store.provision([{ ...alice, customer: "customer-b", extension: "2001" }, bob]), { inserted: 2, unchanged: 0 });
    const profile = store.profile(alice.issuer, "alice", "customer-a");
    assert.ok(profile);
    profile.extension = "9999";
    assert.equal(store.profile(alice.issuer, "alice", "customer-a")?.extension, "1001");
    const writer = new DatabaseSync(path);
    try {
      writer.exec("BEGIN IMMEDIATE");
      try { assert.throws(() => store.provision([{ ...alice, subject: "blocked" }]), /locked/); }
      finally { writer.exec("ROLLBACK"); }
      assert.equal(store.profile(alice.issuer, "blocked", "customer-a"), undefined);
      writer.prepare("UPDATE agent_assignments SET extension = ? WHERE subject = ? AND customer = ?")
        .run("private-invalid", "alice", "customer-a");
      assert.throws(() => store.profile(alice.issuer, "alice", "customer-a"), /Invalid/);
      assert.throws(() => store.provision([alice]), /Invalid/);
    } finally { writer.close(); }
    store.close();
    closed = true;
    assert.throws(() => store.profile(alice.issuer, "bob", "customer-a"));
    assert.throws(() => store.provision([bob]));
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
  const run = () => execute(process.execPath, [script, path, input], { timeout: 10000 });
  try {
    await writeFile(input, JSON.stringify([alice]));
    assert.deepEqual(JSON.parse((await run()).stdout), { inserted: 1, unchanged: 0 });
    assert.deepEqual(JSON.parse((await run()).stdout), { inserted: 0, unchanged: 1 });
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
