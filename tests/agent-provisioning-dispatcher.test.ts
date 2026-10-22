import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAgentProvisioningDispatcher } from "../src/agent-provisioning-dispatcher.ts";
import type { AgentProvisioningTransport } from "../src/agent-provisioning-dispatcher.ts";
import { openAgentProvisioningJournal, openAgentProvisioningStore } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningReceipt } from "../src/agent-provisioning-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-dispatch-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  let time = 100000;
  const now = () => time;
  const store = openAgentProvisioningStore(join(directory, "backend.sqlite"), { now });
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding, { now });
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Synthetic dispatch" };
  const command = (revision = 1): AgentProvisioningCommand => ({
    version: 1, ...binding, operationId: randomUUID(), revision, leaseId: randomUUID(),
    notAfter: 160000, action: "prepare", payload: { generationId: randomUUID(), extension: "1001" },
  });
  const receipt = (sequence: number, stage: ProvisioningReceipt["stage"]): ProvisioningReceipt =>
    ({ receiptId: randomUUID(), sequence, stage, code: `fixture_${stage}` });
  let accepts = 0;
  const transport: AgentProvisioningTransport = {
    async report(id, signal) { signal.throwIfAborted(); return journal.report(id); },
    async accept(intent, signal) {
      signal.throwIfAborted(); accepts++;
      journal.accept(intent.command, intent.context);
      return journal.report(intent.command.operationId)!;
    },
  };
  store.enrol(binding.customer, binding.epoch);
  return { store, journal, binding, command, context, receipt, transport, now,
    setTime(value: number) { time = value; }, accepts: () => accepts,
    async close() { store.close(); journal.close(); await rm(directory, { recursive: true }); } };
}

test("dispatcher queries first, accepts once and reconciles ordered work without executing it", async () => {
  const f = await fixture();
  try {
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, f.transport, { now: f.now });
    assert.deepEqual(await dispatcher.dispatch(), { state: "idle" });
    const first = f.command(); const second = f.command(2);
    f.store.enqueue(first, f.context); f.store.enqueue(second, f.context);
    assert.deepEqual(await dispatcher.dispatch(), { state: "accepted", operationId: first.operationId });
    assert.deepEqual(await dispatcher.dispatch(), { state: "accepted", operationId: first.operationId });
    assert.equal(f.accepts(), 1);
    assert.equal(f.journal.operation(second.operationId), undefined);
    f.journal.record(first.operationId, f.receipt(1, "applying"));
    assert.equal((await dispatcher.dispatch()).state, "reconcile");
    f.journal.record(first.operationId, f.receipt(2, "verified"));
    assert.equal((await dispatcher.dispatch()).state, "verified");
    assert.deepEqual(await dispatcher.dispatch(), { state: "accepted", operationId: second.operationId });
    f.journal.record(second.operationId, f.receipt(1, "applying"));
    f.journal.record(second.operationId, f.receipt(2, "failed"));
    assert.equal((await dispatcher.dispatch()).state, "blocked");
    assert.equal((await dispatcher.dispatch()).state, "blocked");
  } finally { await f.close(); }
});

test("lost accept responses recover through a fresh dispatcher, including after expiry", async () => {
  const f = await fixture();
  try {
    const input = f.command(); f.store.enqueue(input, f.context);
    const broken: AgentProvisioningTransport = { ...f.transport, async accept(intent, signal) {
      await f.transport.accept(intent, signal);
      f.journal.record(input.operationId, f.receipt(1, "applying"));
      f.journal.record(input.operationId, f.receipt(2, "verified"));
      throw new Error("fixture lost response");
    } };
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, broken, { now: f.now });
    await assert.rejects(dispatcher.dispatch(), /lost response/);
    assert.equal(f.store.operation(f.binding.customer, input.operationId)?.receipts.length, 0);
    f.setTime(200000);
    const recovered = createAgentProvisioningDispatcher(f.store, f.binding, f.transport, { now: f.now });
    assert.equal((await recovered.dispatch()).state, "verified");
    assert.equal(f.accepts(), 1);
    assert.equal((await recovered.dispatch()).state, "idle");
  } finally { await f.close(); }
});

test("expired and raced deadlines, missing history and transport failures never trigger a blind send", async () => {
  const f = await fixture();
  try {
    const input = f.command(); f.store.enqueue(input, f.context);
    const errorTransport: AgentProvisioningTransport = { ...f.transport,
      async report() { throw new Error("fixture outage"); } };
    const failing = createAgentProvisioningDispatcher(f.store, f.binding, errorTransport, { now: f.now });
    await assert.rejects(failing.dispatch(), /outage/);
    await assert.rejects(failing.dispatch(), /outage/);
    const deadline: AgentProvisioningTransport = { ...f.transport,
      async report() { f.setTime(input.notAfter); return undefined; } };
    assert.equal((await createAgentProvisioningDispatcher(f.store, f.binding, deadline, { now: f.now }).dispatch()).state, "expired");
    assert.equal(f.accepts(), 0);
    f.setTime(100000);
    const observation = f.receipt(1, "uncertain");
    f.store.record(f.binding.customer, input.operationId, observation);
    await assert.rejects(createAgentProvisioningDispatcher(f.store, f.binding, f.transport, { now: f.now }).dispatch(), /history missing/);
    assert.equal(f.accepts(), 0);
  } finally { await f.close(); }
});

test("dispatcher rejects foreign reports, wrong authority even when idle and overlapping local attempts", async () => {
  const f = await fixture();
  try {
    const foreign = createAgentProvisioningDispatcher(f.store, { ...f.binding, epoch: randomUUID() }, f.transport);
    await assert.rejects(foreign.dispatch(), /authority mismatch/);
    const input = f.command(); f.store.enqueue(input, f.context);
    f.journal.accept(input, f.context);
    const report = f.journal.report(input.operationId)!;
    for (const changed of [{ ...report, operationId: randomUUID() }, { ...report, customer: "customer-b" },
      { ...report, sha256: "0".repeat(64) }]) {
      const transport: AgentProvisioningTransport = { ...f.transport, async report() { return changed; } };
      await assert.rejects(createAgentProvisioningDispatcher(f.store, f.binding, transport).dispatch(), /different|mismatch/);
    }
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    const waiting: AgentProvisioningTransport = { ...f.transport, async report() { await gate; return report; } };
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, waiting);
    const running = dispatcher.dispatch();
    try { await assert.rejects(dispatcher.dispatch(), /already in flight/); }
    finally { finish(); }
    assert.equal((await running).state, "accepted");
    assert.equal(f.accepts(), 0);
  } finally { await f.close(); }
});

test("cooperative transport cancellation surfaces timeout and releases the in-flight guard", async () => {
  const f = await fixture();
  try {
    const input = f.command(); f.store.enqueue(input, f.context);
    let wait = true;
    const transport: AgentProvisioningTransport = { ...f.transport, async report(id, signal) {
      if (!wait) return f.transport.report(id, signal);
      // AbortSignal.timeout does not keep Node alive by itself.
      const keepAlive = setTimeout(() => {}, 10000);
      try {
        await new Promise<never>((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } finally { clearTimeout(keepAlive); }
    } };
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, transport, { now: f.now });
    const start = performance.now();
    await assert.rejects(dispatcher.dispatch(), { name: "TimeoutError" });
    assert.ok(performance.now() - start >= 4900, "Transport budget must be five seconds");
    assert.equal(f.accepts(), 0);
    wait = false;
    assert.equal((await dispatcher.dispatch()).state, "accepted");
  } finally { await f.close(); }
});

test("a new local receipt during the remote query and an invalid clock block acceptance", async () => {
  const f = await fixture();
  try {
    const input = f.command(); f.store.enqueue(input, f.context);
    const invalid = createAgentProvisioningDispatcher(f.store, f.binding, f.transport, { now: () => NaN });
    await assert.rejects(invalid.dispatch(), /Invalid provisioning dispatcher clock/);
    const raced: AgentProvisioningTransport = { ...f.transport, async report() {
      f.store.record(f.binding.customer, input.operationId, f.receipt(1, "uncertain"));
      return undefined;
    } };
    await assert.rejects(createAgentProvisioningDispatcher(f.store, f.binding, raced, { now: f.now }).dispatch(),
      /history changed/);
    assert.equal(f.accepts(), 0);
  } finally { await f.close(); }
});
