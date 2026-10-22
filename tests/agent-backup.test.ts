import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { backupAgentStore, restoreAgentStore } from "../src/agent-backup.ts";
import { openAgentStore } from "../src/agent-store.ts";

const alice = { issuer: "https://identity.example", subject: "alice", customer: "customer-a",
  extension: "1001", displayName: "Alice \u00e9" };
const context = { operator: "recovery-operator", reason: "Synthetic recovery \u00e9" };

test("live agent backup restores exact scoped profiles and receipts after source loss, including CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-recovery-"));
  const path = join(directory, "source.sqlite");
  const store = openAgentStore(path);
  let closed = false;
  try {
    const assignments = [alice, { ...alice, customer: "customer-b", extension: "2001" }];
    const receipt = store.provision(assignments, context);
    const repeated = store.provision(assignments, context);
    const expected = store.receipt(receipt.id);
    const expectedRepeated = store.receipt(repeated.id);
    const backup = await backupAgentStore(path, directory);
    const manifest = JSON.parse(await readFile(join(backup, "manifest.json"), "utf8"));
    assert.equal(manifest.assignments, 2);
    assert.equal(manifest.receipts, 2);
    store.provision([{ ...alice, subject: "later", extension: "1002" }], context);
    store.close(); closed = true;
    await rm(path);
    await assert.rejects(access(path), /ENOENT/);
    const restoredPath = await restoreAgentStore(backup, directory);
    const restored = openAgentStore(restoredPath, { readOnly: true });
    try {
      assert.deepEqual(restored.receipt(receipt.id), expected);
      assert.deepEqual(restored.receipt(repeated.id), expectedRepeated);
      assert.deepEqual(restored.profile(alice.issuer, "alice", "customer-a"),
        { extension: "1001", displayName: "Alice \u00e9" });
      assert.equal(restored.profile(alice.issuer, "alice", "customer-b")?.extension, "2001");
      assert.equal(restored.profile(alice.issuer, "later", "customer-a"), undefined);
      assert.equal(restored.profile("https://foreign.example", "alice", "customer-a"), undefined);
    } finally { restored.close(); }
    const script = fileURLToPath(new URL("../scripts/Manage-AgentBackup.ts", import.meta.url));
    const execute = promisify(execFile);
    const cliBackup = JSON.parse((await execute(process.execPath, [script, "backup", restoredPath, directory])).stdout);
    const cliRestore = JSON.parse((await execute(process.execPath, [script, "restore", cliBackup.path, directory])).stdout);
    const cliStore = openAgentStore(cliRestore.path, { readOnly: true });
    try { assert.deepEqual(cliStore.receipt(receipt.id), expected); }
    finally { cliStore.close(); }
    await assert.rejects(execute(process.execPath, [script, "replace", path, directory]), /Usage:/);
  } finally { if (!closed) store.close(); await rm(directory, { recursive: true }); }
});

test("agent recovery rejects corrupt content even with recalculated checksum and cleans failed outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-backup-invalid-"));
  const path = join(directory, "source.sqlite");
  const store = openAgentStore(path);
  const receipt = store.provision([alice], context);
  try {
    const artifact = await backupAgentStore(path, directory);
    const dbPath = join(artifact, "agents.sqlite");
    const manifestPath = join(artifact, "manifest.json");
    const originalDb = await readFile(dbPath);
    const originalManifest = await readFile(manifestPath, "utf8");
    const updateManifest = async () => {
      const record = JSON.parse(originalManifest);
      record.sha256 = createHash("sha256").update(await readFile(dbPath)).digest("hex");
      await writeFile(manifestPath, JSON.stringify(record));
    };
    const baseline = (await readdir(directory)).sort();
    for (const sql of [
      "UPDATE agent_assignments SET extension = 'invalid'",
      "UPDATE agent_provision_receipts SET sha256 = 'invalid'",
      "UPDATE agent_provision_receipts SET unchanged = 20",
      "UPDATE agent_provision_receipts SET reason = ''",
      "PRAGMA user_version = 99",
    ]) {
      const db = new DatabaseSync(dbPath);
      db.exec(sql); db.close();
      await updateManifest();
      await assert.rejects(restoreAgentStore(artifact, directory));
      assert.deepEqual((await readdir(directory)).sort(), baseline);
      await writeFile(dbPath, originalDb);
      await writeFile(manifestPath, originalManifest);
    }
    const invalidReceipt = new DatabaseSync(dbPath);
    const invalidJson = JSON.stringify([{ ...alice, extension: "not-an-extension" }]);
    invalidReceipt.prepare("UPDATE agent_provision_receipts SET assignments = ?, sha256 = ?")
      .run(invalidJson, createHash("sha256").update(invalidJson).digest("hex"));
    invalidReceipt.close();
    await updateManifest();
    await assert.rejects(restoreAgentStore(artifact, directory), /Invalid/);
    await writeFile(dbPath, originalDb);
    await writeFile(manifestPath, originalManifest);
    await writeFile(dbPath, Buffer.from("corrupt SQLite"));
    await assert.rejects(restoreAgentStore(artifact, directory), /checksum/);
    await writeFile(dbPath, originalDb);
    const record = JSON.parse(originalManifest);
    record.assignments++;
    await writeFile(manifestPath, JSON.stringify(record));
    await assert.rejects(restoreAgentStore(artifact, directory), /count mismatch/);
    await writeFile(manifestPath, "{}");
    await assert.rejects(restoreAgentStore(artifact, directory), /Invalid/);
    const writer = new DatabaseSync(path);
    writer.prepare("UPDATE agent_provision_receipts SET reason = '' WHERE id = ?").run(receipt.id);
    writer.close();
    await assert.rejects(backupAgentStore(path, directory), /bounded/);
    assert.deepEqual((await readdir(directory)).sort(), baseline);
    const missing = join(directory, "missing.sqlite");
    await assert.rejects(backupAgentStore(missing, directory));
    await assert.rejects(access(missing), /ENOENT/);
    await assert.rejects(backupAgentStore("relative.sqlite", directory), /absolute/);
    await assert.rejects(restoreAgentStore(artifact, "relative"), /absolute/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test("empty agent stores recover and older schemas are refused without source migration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-agent-empty-"));
  try {
    const path = join(directory, "empty.sqlite");
    const store = openAgentStore(path);
    store.close();
    const artifact = await backupAgentStore(path, directory);
    const restored = openAgentStore(await restoreAgentStore(artifact, directory), { readOnly: true });
    try { assert.equal(restored.profile(alice.issuer, alice.subject, alice.customer), undefined); }
    finally { restored.close(); }
    const legacyPath = join(directory, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec("PRAGMA user_version = 1");
    legacy.close();
    const bytes = await readFile(legacyPath);
    const baseline = (await readdir(directory)).sort();
    await assert.rejects(backupAgentStore(legacyPath, directory), /requires schema version 2/);
    assert.deepEqual(await readFile(legacyPath), bytes);
    assert.deepEqual((await readdir(directory)).sort(), baseline);
  } finally { await rm(directory, { recursive: true }); }
});
