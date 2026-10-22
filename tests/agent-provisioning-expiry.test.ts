import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAgentProvisioningExpiry } from "../src/agent-provisioning-expiry.ts";
import type { AgentProvisioningExpiryAdapter } from "../src/agent-provisioning-expiry.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";

test("disconnected expiry latches drain across restart, preserves calls and only revokes verified empty generations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-expiry-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const path = join(directory, "journal.sqlite");
  let journal = openAgentProvisioningJournal(path, binding);
  let runtime = new DatabaseSync(join(directory, "runtime.sqlite"));
  runtime.exec(`CREATE TABLE generations (id TEXT PRIMARY KEY, deadline INTEGER, draining INTEGER,
    dialogs INTEGER, removed INTEGER) STRICT`);
  const expired = randomUUID(); const fresh = randomUUID();
  runtime.prepare("INSERT INTO generations VALUES (?, 1000, 0, 1, 0)").run(expired);
  runtime.prepare("INSERT INTO generations VALUES (?, 9000, 0, 0, 0)").run(fresh);
  let time = 1000;
  let revokes = 0;
  const adapter: AgentProvisioningExpiryAdapter = {
    async inventory() {
      return runtime.prepare("SELECT * FROM generations WHERE removed = 0").all().map((row) => ({
        generationId: String(row.id), notAfter: Number(row.deadline), draining: row.draining === 1,
      }));
    },
    async fence(id) { runtime.prepare("UPDATE generations SET draining = 1 WHERE id = ?").run(id); },
    async observe(id) {
      const row = runtime.prepare("SELECT * FROM generations WHERE id = ?").get(id)!;
      return { newCallsBlocked: row.draining === 1,
        dialogs: row.dialogs === -1 ? "unknown" : Number(row.dialogs), removed: row.removed === 1 };
    },
    async revoke(id) {
      revokes++;
      const row = runtime.prepare("SELECT * FROM generations WHERE id = ?").get(id)!;
      assert.equal(row.draining, 1); assert.equal(row.dialogs, 0);
      runtime.prepare("UPDATE generations SET removed = 1 WHERE id = ?").run(id);
    },
  };
  try {
    const sweep = () => createAgentProvisioningExpiry(journal, adapter, { now: () => time }).sweep();
    assert.deepEqual(await sweep(), [{ generationId: expired, state: "draining" }]);
    assert.equal(revokes, 0);
    assert.equal(runtime.prepare("SELECT dialogs FROM generations WHERE id = ?").get(expired)?.dialogs, 1);
    journal.close(); runtime.close();
    journal = openAgentProvisioningJournal(path, binding);
    runtime = new DatabaseSync(join(directory, "runtime.sqlite"));
    time = 500;
    assert.deepEqual(await sweep(), [{ generationId: expired, state: "draining" }],
      "Clock rollback must not reverse a persisted drain");
    runtime.prepare("UPDATE generations SET dialogs = -1 WHERE id = ?").run(expired);
    assert.deepEqual(await sweep(), [{ generationId: expired, state: "uncertain" }]);
    assert.equal(revokes, 0);
    runtime.prepare("UPDATE generations SET dialogs = 0 WHERE id = ?").run(expired);
    assert.deepEqual(await sweep(), [{ generationId: expired, state: "revoked" }]);
    assert.equal(revokes, 1);
    assert.deepEqual(await sweep(), []);
    assert.equal(runtime.prepare("SELECT draining FROM generations WHERE id = ?").get(fresh)?.draining, 0);
  } finally { journal.close(); runtime.close(); await rm(directory, { recursive: true }); }
});

test("expiry validates whole inventory, verifies fence/removal, propagates failures and shares executor ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-expiry-fail-"));
  const journal = openAgentProvisioningJournal(join(directory, "journal.sqlite"),
    { customer: "customer-a", epoch: randomUUID() });
  const id = randomUUID();
  let mode = "fence";
  let revokes = 0;
  const adapter: AgentProvisioningExpiryAdapter = {
    async inventory() { return [{ generationId: id, notAfter: 1000, draining: false }]; },
    async fence() { if (mode === "error") throw new Error("fixture fence failure"); },
    async observe() { return { newCallsBlocked: mode !== "fence", dialogs: 0, removed: false }; },
    async revoke() { revokes++; },
  };
  const expiry = createAgentProvisioningExpiry(journal, adapter, { now: () => 1000 });
  try {
    await assert.rejects(expiry.sweep(), /fence not verified/);
    assert.equal(revokes, 0);
    mode = "remove";
    await assert.rejects(expiry.sweep(), /removal not verified/);
    mode = "error";
    await assert.rejects(expiry.sweep(), /fixture fence failure/);
    await assert.rejects(expiry.sweep(AbortSignal.abort(new Error("fixture cancelled"))), /fixture cancelled/);
    await assert.rejects(journal.exclusive(() => expiry.sweep()), /locked/);
    await assert.rejects(createAgentProvisioningExpiry(journal, adapter, { now: () => NaN }).sweep(), /clock/);
    for (const inventory of [
      Array(101).fill({ generationId: id, notAfter: 1000, draining: false }),
      [{ generationId: id, notAfter: 1000, draining: false }, { generationId: "invalid", notAfter: 1, draining: false }],
      [{ generationId: id, notAfter: 1000, draining: false }, { generationId: id, notAfter: 1, draining: false }],
    ]) {
      await assert.rejects(createAgentProvisioningExpiry(journal,
        { ...adapter, async inventory() { return inventory; },
          async fence() { assert.fail("Whole inventory validation must precede effects"); } },
        { now: () => 1000 }).sweep(), /Invalid expiry/);
    }
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});

test("invalid or inconsistent dialog observations cannot authorise removal and verified removal is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-expiry-observe-"));
  const journal = openAgentProvisioningJournal(join(directory, "journal.sqlite"),
    { customer: "customer-a", epoch: randomUUID() });
  let revokes = 0;
  const adapter: AgentProvisioningExpiryAdapter = {
    async inventory() { return [{ generationId: randomUUID(), notAfter: 1000, draining: true }]; },
    async fence() {},
    async observe() { return { newCallsBlocked: true, dialogs: 0, removed: true }; },
    async revoke() { revokes++; },
  };
  try {
    for (const state of [
      { newCallsBlocked: true, dialogs: -1, removed: false },
      { newCallsBlocked: true, dialogs: 0.5, removed: false },
      { newCallsBlocked: true, dialogs: 1, removed: true },
      { newCallsBlocked: true, dialogs: "unknown" as const, removed: true },
    ]) {
      await assert.rejects(createAgentProvisioningExpiry(journal, {
        ...adapter, async observe() { return state; },
      }, { now: () => 1000 }).sweep(), /Invalid expiry observation|inconsistent/);
    }
    const result = await createAgentProvisioningExpiry(journal, adapter, { now: () => 1000 }).sweep();
    assert.equal(result[0].state, "revoked");
    assert.equal(revokes, 0, "Verified prior removal must not repeat revoke");
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});
