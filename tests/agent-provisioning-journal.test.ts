import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openAgentProvisioningJournal, openAgentProvisioningStore } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningReceipt } from "../src/agent-provisioning-store.ts";

const binding = { customer: "customer-a", epoch: randomUUID() };
const context = { requestId: randomUUID(), actor: "controller-assertion", reason: "Synthetic worker command" };
function command(revision = 1): AgentProvisioningCommand {
  return { version: 1, operationId: randomUUID(), ...binding, revision, leaseId: randomUUID(),
    notAfter: 160000, action: "prepare", payload: { generationId: randomUUID(), extension: "1001" } };
}
function receipt(sequence: number, stage: ProvisioningReceipt["stage"]): ProvisioningReceipt {
  return { receiptId: randomUUID(), sequence, stage, code: `fixture_${stage}` };
}

test("worker journal pins customer/authority durably and cannot be repurposed as a backend store", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-worker-binding-"));
  const path = join(directory, "worker.sqlite");
  const mutable = { ...binding };
  const journal = openAgentProvisioningJournal(path, mutable, { now: () => 100000 });
  try {
    mutable.customer = "customer-b";
    const first = command();
    journal.accept(first, context);
    assert.equal(journal.next().state, "ready");
    assert.throws(() => journal.accept({ ...first, customer: "customer-b" }, context), /customer or authority/);
    assert.throws(() => journal.accept({ ...first, epoch: randomUUID() }, context), /customer or authority/);
    assert.throws(() => openAgentProvisioningJournal(path, { ...binding, customer: "customer-b" }), /binding mismatch/);
    assert.throws(() => openAgentProvisioningJournal(path, { ...binding, epoch: randomUUID() }), /binding mismatch/);
    assert.throws(() => openAgentProvisioningStore(path), /cannot be opened as a backend/);
    const peer = openAgentProvisioningJournal(path, binding, { now: () => 100000 });
    try { assert.deepEqual(peer.operation(first.operationId)?.intent.command, first); }
    finally { peer.close(); }
    assert.equal(journal.operation(randomUUID()), undefined);
    assert.throws(() => journal.operation("invalid"), /UUID/);
    const backendPath = join(directory, "backend.sqlite");
    const backend = openAgentProvisioningStore(backendPath);
    try { backend.enrol(binding.customer, binding.epoch); } finally { backend.close(); }
    assert.throws(() => openAgentProvisioningJournal(backendPath, binding), /repurpose/);
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});

test("ordered worker application is durable, reconcilable and fenced at expiry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-worker-order-"));
  const path = join(directory, "worker.sqlite");
  let time = 100000;
  let journal = openAgentProvisioningJournal(path, binding, { now: () => time });
  try {
    assert.deepEqual(journal.next(), { state: "idle" });
    const first = command();
    const second = command(2);
    journal.accept(first, context);
    journal.accept(second, context);
    const applying = receipt(1, "applying");
    assert.throws(() => journal.record(second.operationId, applying), /ordered head/);
    journal.record(first.operationId, applying);
    const peer = openAgentProvisioningJournal(path, binding, { now: () => time });
    try {
      peer.record(first.operationId, applying);
      assert.throws(() => peer.record(first.operationId, receipt(1, "applying")), /transition/);
      assert.equal(peer.next().state, "reconcile", "Applying after restart is uncertain, not ready to blindly execute again");
    } finally { peer.close(); }
    journal.close();
    journal = openAgentProvisioningJournal(path, binding, { now: () => time });
    assert.equal(journal.next().state, "reconcile");
    journal.record(first.operationId, receipt(2, "uncertain"));
    journal.record(first.operationId, receipt(3, "verified"));
    assert.deepEqual(journal.next(), { state: "ready", intent: journal.operation(second.operationId)!.intent, receipts: [] });
    journal.record(first.operationId, applying);
    time = second.notAfter;
    assert.equal(journal.next().state, "expired");
    assert.throws(() => journal.record(second.operationId, receipt(1, "applying")), /expired/);
    assert.equal(journal.operation(second.operationId)?.receipts.length, 0);
    assert.deepEqual(journal.accept(second, context), journal.operation(second.operationId)?.intent,
      "Expired acceptance retry reconciles old intent without making it executable");
    journal.record(second.operationId, receipt(1, "uncertain"));
    assert.equal(journal.next().state, "reconcile");
    assert.throws(() => journal.record(second.operationId, receipt(2, "applying")), /expired/);
    journal.record(second.operationId, receipt(2, "failed"));
    assert.equal(journal.next().state, "blocked", "Failure must not silently advance the customer revision stream");
    time = 100000;
    const third = command(3);
    journal.accept(third, context);
    assert.throws(() => journal.record(third.operationId, receipt(1, "applying")), /ordered head/);
    assert.throws(() => journal.record(second.operationId, receipt(3, "verified")), /transition/);
    const reader = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(reader.prepare("SELECT count(*) AS count FROM provisioning_intents").get()?.count, 3); }
    finally { reader.close(); }
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});

test("worker journal fails explicitly on receipt errors, corruption, gaps and invalid clocks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-worker-failure-"));
  const path = join(directory, "worker.sqlite");
  let time = 100000;
  const journal = openAgentProvisioningJournal(path, binding, { now: () => time });
  const writer = new DatabaseSync(path);
  try {
    const first = command();
    journal.accept(first, context);
    writer.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => journal.record(first.operationId, receipt(1, "applying")), /locked/); }
    finally { writer.exec("ROLLBACK"); }
    assert.equal(journal.next().state, "ready");
    writer.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON provisioning_receipts
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`);
    assert.throws(() => journal.record(first.operationId, receipt(1, "applying")), /fixture failure/);
    assert.equal(journal.next().state, "ready");
    writer.exec("DROP TRIGGER reject_receipt");
    time = NaN;
    assert.throws(() => journal.next(), /clock/);
    time = 100000;
    journal.record(first.operationId, receipt(1, "applying"));
    journal.record(first.operationId, receipt(2, "verified"));
    journal.accept(command(2), context);
    writer.prepare("DELETE FROM provisioning_intents WHERE operation_id = ?").run(first.operationId);
    assert.throws(() => journal.next(), /revision or authority mismatch/);
    writer.exec("DELETE FROM provisioning_intents");
    assert.throws(() => journal.next(), /revision gap/);
    writer.exec("UPDATE provisioning_worker_binding SET customer = 'customer-b'");
    assert.throws(() => openAgentProvisioningJournal(path, binding), /binding mismatch/);
  } finally { writer.close(); journal.close(); await rm(directory, { recursive: true }); }
});

test("competing worker processes cannot start the ordered operation twice with different receipts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-worker-race-"));
  const path = join(directory, "worker.sqlite");
  const journal = openAgentProvisioningJournal(path, binding, { now: () => 100000 });
  try {
    const first = command();
    journal.accept(first, context);
    const execute = promisify(execFile);
    const module = new URL("../src/agent-provisioning-store.ts", import.meta.url).href;
    const results = await Promise.all(Array.from({ length: 4 }, async () => {
      const script = `
        import { openAgentProvisioningJournal, AgentProvisioningConflict } from ${JSON.stringify(module)};
        const journal = openAgentProvisioningJournal(${JSON.stringify(path)}, ${JSON.stringify(binding)}, { now: () => 100000 });
        try {
          journal.record(${JSON.stringify(first.operationId)}, ${JSON.stringify(receipt(1, "applying"))});
          console.log("started");
        } catch (error) {
          if (!(error instanceof AgentProvisioningConflict)) throw error;
          console.log("conflict");
        } finally { journal.close(); }
      `;
      return (await execute(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10000 })).stdout.trim();
    }));
    assert.equal(results.filter((value) => value === "started").length, 1);
    assert.equal(results.filter((value) => value === "conflict").length, 3);
    assert.equal(journal.operation(first.operationId)?.receipts.length, 1);
    assert.equal(journal.next().state, "reconcile");
  } finally { journal.close(); await rm(directory, { recursive: true }); }
});
