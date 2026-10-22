import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openAgentProvisioningJournal, openAgentProvisioningStore } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningReceipt, ProvisioningReport } from "../src/agent-provisioning-store.ts";

const worker = { customer: "customer-a", epoch: randomUUID() };
const context = { requestId: randomUUID(), actor: "verified-controller-assertion", reason: "Synthetic command" };
function command(revision = 1): AgentProvisioningCommand {
  return { version: 1, ...worker, operationId: randomUUID(), revision, leaseId: randomUUID(),
    notAfter: 160000, action: "prepare", payload: { generationId: randomUUID(), extension: "1001" } };
}
function receipt(sequence: number, stage: ProvisioningReceipt["stage"]): ProvisioningReceipt {
  return { receiptId: randomUUID(), sequence, stage, code: `fixture_${stage}` };
}

test("lost worker responses reconcile durable receipt history after restart without reissuing commands", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-reconcile-"));
  const backendPath = join(directory, "backend.sqlite");
  const workerPath = join(directory, "worker.sqlite");
  let time = 100000;
  let backend = openAgentProvisioningStore(backendPath, { now: () => time });
  let journal = openAgentProvisioningJournal(workerPath, worker, { now: () => time });
  try {
    backend.enrol(worker.customer, worker.epoch);
    const input = command();
    backend.enqueue(input, context);
    journal.accept(input, context);
    const accepted = journal.report(input.operationId)!;
    assert.deepEqual(Object.keys(accepted).sort(),
      ["customer", "epoch", "operationId", "receipts", "revision", "sha256", "version"]);
    assert.deepEqual(accepted.receipts, []);
    assert.equal(journal.report(randomUUID()), undefined);
    assert.deepEqual(backend.reconcile(worker, accepted), { inserted: 0, unchanged: 0 });
    journal.record(input.operationId, receipt(1, "applying"));
    const applying = journal.report(input.operationId)!;
    journal.record(input.operationId, receipt(2, "uncertain"));
    journal.record(input.operationId, receipt(3, "applying"));
    journal.record(input.operationId, receipt(4, "verified"));
    assert.equal(backend.pending(worker.customer).length, 1, "Lost response must not manufacture backend completion");
    backend.close(); journal.close();
    time = 200000;
    backend = openAgentProvisioningStore(backendPath, { now: () => time });
    journal = openAgentProvisioningJournal(workerPath, worker, { now: () => time });
    const verified = journal.report(input.operationId)!;
    assert.deepEqual(backend.reconcile(worker, verified), { inserted: 4, unchanged: 0 });
    assert.deepEqual(backend.operation(worker.customer, input.operationId)?.receipts, verified.receipts);
    assert.deepEqual(backend.pending(worker.customer), []);
    assert.deepEqual(backend.reconcile(worker, verified), { inserted: 0, unchanged: 4 });
    assert.deepEqual(backend.reconcile(worker, applying), { inserted: 0, unchanged: 1 });
    assert.deepEqual(backend.reconcile(worker, accepted), { inserted: 0, unchanged: 0 });
    assert.equal(backend.operation(worker.customer, input.operationId)?.receipts.length, 4, "Delayed snapshots cannot erase later receipts");
    verified.receipts[0].code = "mutated_copy";
    assert.equal(journal.report(input.operationId)?.receipts[0].code, "fixture_applying");
    const reader = new DatabaseSync(backendPath, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT count(*) AS count FROM provisioning_intents").get()?.count, 1);
      assert.equal(reader.prepare("SELECT revision FROM provisioning_authorities").get()?.revision, 1);
    } finally { reader.close(); }
  } finally { backend.close(); journal.close(); await rm(directory, { recursive: true }); }
});

test("receipt reconciliation rejects foreign scope, wrong intent and divergent or malformed history atomically", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-reconcile-input-"));
  const path = join(directory, "backend.sqlite");
  const backend = openAgentProvisioningStore(path, { now: () => 100000 });
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), worker, { now: () => 100000 });
  try {
    backend.enrol(worker.customer, worker.epoch);
    const input = command();
    backend.enqueue(input, context);
    journal.accept(input, context);
    journal.record(input.operationId, receipt(1, "applying"));
    journal.record(input.operationId, receipt(2, "verified"));
    const report = journal.report(input.operationId)!;
    for (const changed of [
      { ...report, customer: "customer-b" }, { ...report, epoch: randomUUID() },
      { ...report, operationId: randomUUID() }, { ...report, revision: 2 },
      { ...report, sha256: "0".repeat(64) },
    ]) assert.throws(() => backend.reconcile(worker, changed), /mismatch|not found/);
    assert.throws(() => backend.reconcile({ ...worker, customer: "customer-b" }, report), /scope mismatch/);
    for (const changed of [
      { ...report, version: 2 }, { ...report, sha256: "bad" }, { ...report, receipts: null },
      { ...report, extra: "not-allowed" }, { ...report, receipts: Array(101).fill(report.receipts[0]) },
      { ...report, receipts: [{ ...report.receipts[0], password: "not-allowed" }] },
    ]) assert.throws(() => backend.reconcile(worker, changed as ProvisioningReport), /Invalid/);
    for (const history of [
      [report.receipts[1]], [report.receipts[0], { ...report.receipts[1], sequence: 3 }],
      [report.receipts[0], { ...report.receipts[1], receiptId: report.receipts[0].receiptId }],
      [report.receipts[0], report.receipts[1], receipt(3, "applying")],
    ]) {
      assert.throws(() => backend.reconcile(worker, { ...report, receipts: history }), /transition|Duplicate/);
      assert.deepEqual(backend.operation(worker.customer, input.operationId)?.receipts, []);
    }
    backend.record(worker.customer, input.operationId, report.receipts[0]);
    assert.throws(() => backend.reconcile(worker, {
      ...report, receipts: [{ ...report.receipts[0], code: "divergent" }, report.receipts[1]],
    }), /history diverged/);
    assert.equal(backend.operation(worker.customer, input.operationId)?.receipts.length, 1);
    assert.deepEqual(backend.reconcile(worker, report), { inserted: 1, unchanged: 1 });
  } finally { backend.close(); journal.close(); await rm(directory, { recursive: true }); }
});

test("a mid-import SQLite error rolls back every receipt and an identical retry recovers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-reconcile-rollback-"));
  const path = join(directory, "backend.sqlite");
  const backend = openAgentProvisioningStore(path, { now: () => 100000 });
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), worker, { now: () => 100000 });
  const writer = new DatabaseSync(path);
  try {
    backend.enrol(worker.customer, worker.epoch);
    const input = command();
    backend.enqueue(input, context);
    journal.accept(input, context);
    journal.record(input.operationId, receipt(1, "applying"));
    journal.record(input.operationId, receipt(2, "verified"));
    const report = journal.report(input.operationId)!;
    writer.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON provisioning_receipts WHEN NEW.sequence = 2
      BEGIN SELECT RAISE(ABORT, 'fixture second receipt failure'); END`);
    assert.throws(() => backend.reconcile(worker, report), /fixture second receipt failure/);
    assert.deepEqual(backend.operation(worker.customer, input.operationId)?.receipts, []);
    writer.exec("DROP TRIGGER reject_second");
    writer.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => backend.reconcile(worker, report), /locked/); }
    finally { writer.exec("ROLLBACK"); }
    assert.deepEqual(backend.reconcile(worker, report), { inserted: 2, unchanged: 0 });
    writer.exec("UPDATE provisioning_receipts SET receipt = '{}' WHERE sequence = 1");
    assert.throws(() => backend.reconcile(worker, report), /Invalid/);
  } finally { writer.close(); backend.close(); journal.close(); await rm(directory, { recursive: true }); }
});

test("reports at the exact history limit are complete and longer histories fail without truncation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-report-limit-"));
  const backend = openAgentProvisioningStore(join(directory, "backend.sqlite"), { now: () => 100000 });
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), worker, { now: () => 100000 });
  try {
    backend.enrol(worker.customer, worker.epoch);
    const input = command();
    backend.enqueue(input, context);
    journal.accept(input, context);
    for (let sequence = 1; sequence <= 100; sequence++) {
      journal.record(input.operationId, receipt(sequence, sequence % 2 ? "applying" : "uncertain"));
    }
    const report = journal.report(input.operationId)!;
    assert.equal(report.receipts.length, 100);
    assert.deepEqual(backend.reconcile(worker, report), { inserted: 100, unchanged: 0 });
    journal.record(input.operationId, receipt(101, "verified"));
    assert.throws(() => journal.report(input.operationId), /Invalid provisioning report/);
    assert.equal(journal.operation(input.operationId)?.receipts.length, 101, "Report limit must not discard stored history");
    assert.equal(backend.pending(worker.customer).length, 1, "A failed export cannot fabricate completion");
  } finally { backend.close(); journal.close(); await rm(directory, { recursive: true }); }
});
