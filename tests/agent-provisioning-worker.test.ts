import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentProvisioningWorker } from "../src/agent-provisioning-worker.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";
import { openFakeProvisioningRuntime } from "./identity/fake-provisioning-runtime.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-worker-loop-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  let time = 100000;
  const options = { now: () => time };
  const journal = openAgentProvisioningJournal(join(directory, "journal.sqlite"), binding, options);
  const runtime = openFakeProvisioningRuntime(join(directory, "runtime.sqlite"), binding, options);
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Worker cycle" };
  let revision = 0;
  const enqueue = (action: "prepare" | "activate", generationId: string, deadline = 160000) => {
    const base = { version: 1 as const, ...binding, operationId: randomUUID(), leaseId: randomUUID(),
      revision: ++revision, notAfter: deadline };
    const command: AgentProvisioningCommand = action === "prepare" ?
      { ...base, action, payload: { generationId, extension: "1001" } } :
      { ...base, action, payload: { generationId } };
    journal.accept(command, context);
    return command;
  };
  return { journal, runtime, options, enqueue, time(value: number) { time = value; },
    async close() { runtime.close(); journal.close(); await rm(directory, { recursive: true }); } };
}

test("one worker loop serially executes commands, drains expiry and removes the old generation before replacement", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error("fixture worker timeout")), 5000);
  const first = randomUUID(); const replacement = randomUUID();
  const prepare = f.enqueue("prepare", first);
  const activate = f.enqueue("activate", first);
  let cycles = 0;
  let replacementOperation = "";
  let stage = "prepare";
  try {
    await assert.rejects(runAgentProvisioningWorker(f.journal,
      { execution: f.runtime.execution, expiry: f.runtime.expiry }, controller.signal, async (cycle) => {
        cycles++;
        if (stage === "prepare") {
          assert.deepEqual(cycle.execution, { state: "verified", operationId: prepare.operationId });
          assert.equal(f.runtime.generation(first).phase, "prepared");
          stage = "activate";
        } else if (stage === "activate") {
          assert.deepEqual(cycle.execution, { state: "verified", operationId: activate.operationId });
          f.runtime.startCall(first);
          f.time(160000); stage = "drain";
        } else if (stage === "drain") {
          assert.deepEqual(cycle.expiry, [{ generationId: first, state: "draining" }]);
          assert.equal(cycle.execution.state, "idle");
          assert.equal(f.runtime.generation(first).dialogs, 1);
          assert.throws(() => f.runtime.startCall(first), /new call denied/);
          f.runtime.setDialogs(first, 0);
          replacementOperation = f.enqueue("prepare", replacement, 220000).operationId;
          stage = "replace";
        } else {
          assert.deepEqual(cycle.expiry, [{ generationId: first, state: "revoked" }]);
          assert.deepEqual(cycle.execution, { state: "verified", operationId: replacementOperation });
          assert.equal(f.runtime.generation(first).phase, "removed");
          assert.equal(f.runtime.generation(replacement).phase, "prepared");
          controller.abort(new Error("fixture completed"));
        }
      }, f.options), /fixture completed/);
    assert.equal(cycles, 4);
    assert.equal(f.runtime.effectCount(), 3);
    assert.equal(await f.journal.exclusive(async () => "released"), "released");
  } finally { clearTimeout(watchdog); controller.abort(); await f.close(); }
});

test("expired journal heads do not prevent subsequent expiry sweeps", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error("fixture worker timeout")), 5000);
  const id = randomUUID();
  const signal = AbortSignal.timeout(5000);
  const prepare = f.enqueue("prepare", id);
  // Simulate already-applied runtime state with a still-unstarted journal command.
  await f.runtime.execution.apply(prepare, signal);
  f.time(160000);
  let cycles = 0;
  try {
    await assert.rejects(runAgentProvisioningWorker(f.journal,
      { execution: f.runtime.execution, expiry: f.runtime.expiry }, controller.signal, async (cycle) => {
        cycles++;
        assert.equal(cycle.execution.state, "expired");
        if (cycles === 1) assert.deepEqual(cycle.expiry, [{ generationId: id, state: "revoked" }]);
        else {
          assert.deepEqual(cycle.expiry, []);
          controller.abort(new Error("fixture completed"));
        }
      }, f.options), /fixture completed/);
    assert.equal(cycles, 2);
    assert.equal(f.journal.operation(prepare.operationId)?.receipts.length, 0);
  } finally { clearTimeout(watchdog); controller.abort(); await f.close(); }
});

test("expiry failure prevents execution; execution or reporting failure stops the awaited worker", async () => {
  const f = await fixture();
  const signal = AbortSignal.timeout(5000);
  const command = f.enqueue("prepare", randomUUID());
  let reports = 0;
  try {
    await assert.rejects(runAgentProvisioningWorker(f.journal, {
      execution: { async apply() { assert.fail("Expiry must precede execution"); },
        async observe() { assert.fail("No observation"); } },
      expiry: { ...f.runtime.expiry, async inventory() { throw new Error("fixture expiry failure"); } },
    }, signal, async () => { reports++; }, f.options), /expiry failure/);
    assert.equal(f.journal.operation(command.operationId)?.receipts.length, 0);
    await assert.rejects(runAgentProvisioningWorker(f.journal, {
      execution: { ...f.runtime.execution, async apply() { throw new Error("fixture execution failure"); } },
      expiry: f.runtime.expiry,
    }, signal, async () => { reports++; }, f.options), /execution failure/);
    assert.equal(reports, 0);
    assert.equal(f.journal.operation(command.operationId)?.receipts.at(-1)?.stage, "applying");
    await assert.rejects(runAgentProvisioningWorker(f.journal,
      { execution: f.runtime.execution, expiry: f.runtime.expiry }, signal, async (cycle) => {
        reports++;
        assert.equal(cycle.execution.state, "uncertain", "Interrupted missing effect must not replay");
        throw new Error("fixture reporting failure");
      }, f.options), /reporting failure/);
    assert.equal(reports, 1);
    assert.equal(f.runtime.effectCount(), 0);
    assert.equal(await f.journal.exclusive(async () => "released"), "released");
  } finally { await f.close(); }
});

test("cancellation during expiry never starts execution or reports a successful cycle", async () => {
  const f = await fixture();
  const controller = new AbortController();
  f.enqueue("prepare", randomUUID());
  try {
    await assert.rejects(runAgentProvisioningWorker(f.journal, {
      execution: { async apply() { assert.fail("Cancelled cycle cannot execute"); },
        async observe() { assert.fail("Cancelled cycle cannot observe"); } },
      expiry: { ...f.runtime.expiry, async inventory() {
        controller.abort(new Error("fixture cancelled"));
        return [];
      } },
    }, controller.signal, async () => assert.fail("No completed cycle"), f.options), /fixture cancelled/);
    assert.equal(f.runtime.effectCount(), 0);
  } finally { await f.close(); }
});
