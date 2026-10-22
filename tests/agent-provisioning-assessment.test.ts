import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentProvisioningAssessment } from "../src/agent-provisioning-assessment.ts";
import { openAgentProvisioningStore, openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningReceipt } from "../src/agent-provisioning-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-assessment-"));
  const backendPath = join(directory, "backend.sqlite");
  const workerPath = join(directory, "worker.sqlite");
  const binding = { customer: "customer-a", epoch: randomUUID() };
  let time = 100000;
  const options = { now: () => time };
  const store = openAgentProvisioningStore(backendPath, options);
  const worker = openAgentProvisioningJournal(workerPath, binding, options);
  store.enrol(binding.customer, binding.epoch);
  const command: AgentProvisioningCommand = {
    version: 1, ...binding, revision: 1, operationId: randomUUID(), leaseId: randomUUID(),
    notAfter: 160000, action: "prepare", payload: { generationId: randomUUID(), extension: "1001" },
  };
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Assessment only" };
  const owner = { issuer: "https://identity.invalid", subject: "alice", customer: command.customer,
    authorisationId: randomBytes(32).toString("base64url"), sessionExpiresAt: 180000,
    deviceId: randomUUID(), generationId: command.payload.generationId, extension: "1001" };
  let live = true;
  const sessions = {
    resolveAuthorisation() {
      return live ? { sessionId: randomBytes(32).toString("base64url"), subject: "alice",
        customer: command.customer, expiresAt: 180000 } : undefined;
    },
  };
  const transport = { async report(id: string, signal: AbortSignal) {
    signal.throwIfAborted(); return worker.report(id);
  } };
  const assessment = createAgentProvisioningAssessment(store, binding, transport, sessions, options);
  const receipt = (sequence: number, stage: ProvisioningReceipt["stage"]): ProvisioningReceipt =>
    ({ receiptId: randomUUID(), sequence, stage, code: `fixture_${stage}` });
  return { store, worker, command, context, owner, sessions, transport, assessment, binding, options, receipt,
    time(value: number) { time = value; }, live(value: boolean) { live = value; },
    async bytes() { return Promise.all([readFile(backendPath), readFile(workerPath)]); },
    async close() { store.close(); worker.close(); await rm(directory, { recursive: true }); } };
}

test("assessment is read-only for idle, undelivered, accepted and worker-ahead evidence including after expiry/logout", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(await f.assessment.assess(), { state: "idle" });
    f.store.enqueueOwned(f.command, f.context, f.owner);
    let before = await f.bytes();
    assert.deepEqual(await f.assessment.assess(), {
      state: "assessed", operationId: f.command.operationId, revision: 1, deadlineExpired: false,
      localStage: "none", workerStage: "missing", history: "worker-missing", ownership: "session-resolved",
    });
    assert.deepEqual(await f.bytes(), before);
    assert.equal(f.worker.operation(f.command.operationId), undefined);
    f.worker.accept(f.command, f.context);
    const accepted = await f.assessment.assess();
    assert.equal(accepted.state === "assessed" && accepted.workerStage, "none");
    assert.equal(accepted.state === "assessed" && accepted.history, "equal");
    const applying = f.receipt(1, "applying");
    f.worker.record(f.command.operationId, applying);
    f.worker.record(f.command.operationId, f.receipt(2, "verified"));
    f.time(160000); f.live(false);
    before = await f.bytes();
    const result = await f.assessment.assess();
    assert.deepEqual(result, {
      state: "assessed", operationId: f.command.operationId, revision: 1, deadlineExpired: true,
      localStage: "none", workerStage: "verified", history: "worker-ahead", ownership: "session-unresolved",
    });
    assert.deepEqual(await f.bytes(), before, "Assessment must not import worker receipts or change intent/history");
    assert.deepEqual(f.store.operation(f.command.customer, f.command.operationId)?.receipts, []);
    assert.ok(!JSON.stringify(result).includes(f.owner.authorisationId));
    assert.ok(!JSON.stringify(result).includes(f.owner.subject));
  } finally { await f.close(); }
});

test("assessment distinguishes missing history, delayed prefixes and failed ordered heads without mutation", async () => {
  const f = await fixture();
  try {
    f.store.enqueue(f.command, f.context);
    const applying = f.receipt(1, "applying");
    f.store.record(f.command.customer, f.command.operationId, applying);
    const missing = await f.assessment.assess();
    assert.equal(missing.state === "assessed" && missing.history, "worker-history-missing");
    assert.equal(missing.state === "assessed" && missing.ownership, "missing");
    f.worker.accept(f.command, f.context);
    const behind = await f.assessment.assess();
    assert.equal(behind.state === "assessed" && behind.history, "worker-behind");
    f.worker.record(f.command.operationId, applying);
    const failed = f.receipt(2, "failed");
    f.worker.record(f.command.operationId, failed);
    f.store.record(f.command.customer, f.command.operationId, failed);
    const before = await f.bytes();
    const result = await f.assessment.assess();
    assert.equal(result.state === "assessed" && result.localStage, "failed");
    assert.equal(result.state === "assessed" && result.workerStage, "failed");
    assert.equal(result.state === "assessed" && result.history, "equal");
    assert.deepEqual(await f.bytes(), before);
  } finally { await f.close(); }
});

test("assessment rejects foreign, malformed and divergent reports rather than manufacturing a recovery status", async () => {
  const f = await fixture();
  try {
    f.store.enqueue(f.command, f.context); f.worker.accept(f.command, f.context);
    const applying = f.receipt(1, "applying");
    f.worker.record(f.command.operationId, applying);
    f.store.record(f.command.customer, f.command.operationId, applying);
    const report = f.worker.report(f.command.operationId)!;
    const before = await f.bytes();
    for (const changed of [
      { ...report, customer: "customer-b" }, { ...report, epoch: randomUUID() },
      { ...report, operationId: randomUUID() }, { ...report, sha256: "0".repeat(64) },
      { ...report, receipts: [{ ...applying, code: "different" }] },
      { ...report, receipts: [{ ...applying, sequence: 2 }] },
      { ...report, revision: 0 },
    ]) {
      const assessment = createAgentProvisioningAssessment(f.store, f.binding,
        { async report() { return changed; } }, f.sessions, f.options);
      await assert.rejects(assessment.assess());
    }
    assert.deepEqual(await f.bytes(), before);
  } finally { await f.close(); }
});

test("assessment rejects changed local head/history, cancellation and outages, and releases overlap guard", async () => {
  const f = await fixture();
  try {
    f.store.enqueue(f.command, f.context);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = createAgentProvisioningAssessment(f.store, f.binding, {
      async report(id, signal) { entered(); await gate; return f.transport.report(id, signal); },
    }, f.sessions, f.options);
    const pending = held.assess();
    const rejected = assert.rejects(pending, /head or history changed/);
    try {
      await started;
      await assert.rejects(held.assess(), /already in flight/);
      f.store.record(f.command.customer, f.command.operationId, f.receipt(1, "uncertain"));
    } finally { release(); }
    await rejected;
    assert.equal((await held.assess()).state, "assessed");
    const failure = new Error("fixture unavailable");
    const unavailable = createAgentProvisioningAssessment(f.store, f.binding,
      { async report() { throw failure; } }, f.sessions, f.options);
    await assert.rejects(unavailable.assess(), (error) => error === failure);
    await assert.rejects(unavailable.assess(), (error) => error === failure);
    await assert.rejects(f.assessment.assess(AbortSignal.abort(failure)), (error) => error === failure);
    const controller = new AbortController();
    const cancelled = createAgentProvisioningAssessment(f.store, f.binding, {
      async report() { controller.abort(failure); return undefined; },
    }, f.sessions, f.options);
    await assert.rejects(cancelled.assess(controller.signal), (error) => error === failure);
    f.time(NaN);
    await assert.rejects(f.assessment.assess(), /clock/);
  } finally { await f.close(); }
});

test("trusted cleanup assessment needs no browser owner and invalid bindings fail explicitly", async () => {
  const f = await fixture();
  try {
    for (const binding of [{ ...f.binding, customer: "../bad" }, { ...f.binding, epoch: "bad" }]) {
      assert.throws(() => createAgentProvisioningAssessment(f.store, binding, f.transport, f.sessions), /binding/);
    }
    const foreign = createAgentProvisioningAssessment(f.store, { ...f.binding, epoch: randomUUID() }, f.transport, f.sessions);
    await assert.rejects(foreign.assess(), /authority/);
    const command: AgentProvisioningCommand = { ...f.command, action: "drain", payload: { generationId: f.owner.generationId } };
    f.store.enqueue(command, f.context);
    const assessment = createAgentProvisioningAssessment(f.store, f.binding, f.transport,
      { resolveAuthorisation() { return assert.fail("Cleanup must not require a browser session"); } }, f.options);
    const result = await assessment.assess();
    assert.equal(result.state === "assessed" && result.ownership, "trusted-cleanup");
  } finally { await f.close(); }
});

test("head advancement during readback rejects a stale assessment rather than returning recovery advice", async () => {
  const f = await fixture();
  try {
    f.store.enqueue(f.command, f.context); f.worker.accept(f.command, f.context);
    f.worker.record(f.command.operationId, f.receipt(1, "applying"));
    f.worker.record(f.command.operationId, f.receipt(2, "verified"));
    const assessment = createAgentProvisioningAssessment(f.store, f.binding, {
      async report(id) {
        const report = f.worker.report(id)!;
        f.store.reconcile(f.binding, report);
        return report;
      },
    }, f.sessions, f.options);
    await assert.rejects(assessment.assess(), /head or history changed/);
    assert.deepEqual(await assessment.assess(), { state: "idle" });
  } finally { await f.close(); }
});

test("cooperative readback times out and the assessment remains usable after failure", async () => {
  const f = await fixture();
  try {
    f.store.enqueue(f.command, f.context);
    let wait = true;
    const assessment = createAgentProvisioningAssessment(f.store, f.binding, {
      async report(id, signal) {
        if (wait) await delay(10000, undefined, { signal });
        return f.transport.report(id, signal);
      },
    }, f.sessions, f.options);
    const before = await f.bytes();
    await assert.rejects(assessment.assess(), { name: "AbortError" });
    wait = false;
    assert.equal((await assessment.assess()).state, "assessed");
    assert.deepEqual(await f.bytes(), before);
  } finally { await f.close(); }
});
