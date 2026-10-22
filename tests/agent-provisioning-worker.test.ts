import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runAgentProvisioningWorker, createAgentProvisioningWorkerSupervisor } from "../src/agent-provisioning-worker.ts";
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

test("supervisor exposes detached phase health, exact stall threshold and pending shutdown without releasing an effect", async () => {
  const f = await fixture();
  const controller = new AbortController();
  const watchdog = setTimeout(() => controller.abort(new Error("fixture timeout")), 5000);
  let tick = 100;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const command = f.enqueue("prepare", randomUUID());
  const supervisor = createAgentProvisioningWorkerSupervisor(f.journal, {
    execution: {
      ...f.runtime.execution,
      async apply() { enter(); await gate; },
    }, expiry: f.runtime.expiry,
  }, { ...f.options, stallAfterMs: 1000, monotonicNow: () => tick });
  let lifetime: Promise<void> | undefined;
  try {
    assert.deepEqual(supervisor.health(), {
      state: "idle", phase: null, phaseAgeMs: 0, completedCycles: 0, stopRequested: false,
    });
    lifetime = supervisor.run(controller.signal, async () => assert.fail("Cancelled effect cannot complete a cycle"));
    const rejected = assert.rejects(lifetime, /fixture stopped/);
    await entered;
    assert.equal(supervisor.health().phase, "execution");
    tick = 1099;
    assert.equal(supervisor.health().state, "running");
    tick = 1100;
    const snapshot = supervisor.health();
    assert.equal(snapshot.state, "stalled");
    assert.equal(snapshot.phaseAgeMs, 1000);
    snapshot.completedCycles = 99;
    assert.equal(supervisor.health().completedCycles, 0);
    tick = 1101;
    controller.abort(new Error("fixture stopped"));
    assert.equal(supervisor.health().state, "stalled");
    assert.equal(supervisor.health().stopRequested, true);
    await assert.rejects(f.journal.exclusive(async () => assert.fail("Stalled effect still owns journal")), /locked/);
    assert.equal(f.journal.operation(command.operationId)?.receipts.at(-1)?.stage, "applying");
    await assert.rejects(supervisor.run(new AbortController().signal, async () => {}), /single-use/);
    release();
    await rejected;
    assert.equal(supervisor.health().state, "stopped");
    assert.equal(supervisor.health().phase, "execution");
    assert.equal(await f.journal.exclusive(async () => "released"), "released");
    await assert.rejects(supervisor.run(new AbortController().signal, async () => {}), /single-use/);
  } finally {
    release(); clearTimeout(watchdog); controller.abort();
    if (lifetime) await lifetime.catch(() => {});
    await f.close();
  }
});

test("default monotonic health clock detects a real stalled inventory without a timer-driven restart", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let attempts = 0;
  const supervisor = createAgentProvisioningWorkerSupervisor(f.journal, {
    execution: f.runtime.execution,
    expiry: { ...f.runtime.expiry, async inventory() { attempts++; enter(); await gate; return []; } },
  }, { ...f.options, stallAfterMs: 30 });
  const lifetime = supervisor.run(controller.signal, async () => assert.fail("No cancelled cycle"));
  const rejected = assert.rejects(lifetime, (error: unknown) => error === controller.signal.reason);
  try {
    await entered;
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(supervisor.health().state, "stalled");
    assert.ok(supervisor.health().phaseAgeMs >= 30);
    assert.equal(attempts, 1);
    controller.abort(new Error("fixture completed"));
    release();
    await rejected;
    assert.equal(supervisor.health().state, "stopped");
  } finally { release(); controller.abort(); await lifetime.catch(() => {}); await f.close(); }
});

test("supervisor reports expiry and reporting stalls and counts only successfully reported cycles", async () => {
  const f = await fixture();
  const controller = new AbortController();
  let tick = 0;
  let inventoryEnter!: () => void;
  let inventoryRelease!: () => void;
  const inventoryEntered = new Promise<void>((resolve) => { inventoryEnter = resolve; });
  const inventoryGate = new Promise<void>((resolve) => { inventoryRelease = resolve; });
  let reportEnter!: () => void;
  let reportRelease!: () => void;
  const reportEntered = new Promise<void>((resolve) => { reportEnter = resolve; });
  const reportGate = new Promise<void>((resolve) => { reportRelease = resolve; });
  const supervisor = createAgentProvisioningWorkerSupervisor(f.journal, {
    execution: f.runtime.execution,
    expiry: { ...f.runtime.expiry, async inventory() { inventoryEnter(); await inventoryGate; return []; } },
  }, { ...f.options, stallAfterMs: 500, monotonicNow: () => tick });
  let lifetime: Promise<void> | undefined;
  try {
    lifetime = supervisor.run(controller.signal, async () => { reportEnter(); await reportGate; });
    const rejected = assert.rejects(lifetime, (error: unknown) => error === controller.signal.reason ||
      (error instanceof Error && error.cause === controller.signal.reason));
    await inventoryEntered;
    assert.equal(supervisor.health().phase, "expiry");
    tick = 500;
    assert.equal(supervisor.health().state, "stalled");
    inventoryRelease();
    await reportEntered;
    assert.equal(supervisor.health().phase, "reporting");
    assert.equal(supervisor.health().state, "running");
    tick = 1000;
    assert.equal(supervisor.health().state, "stalled");
    assert.equal(supervisor.health().completedCycles, 0);
    reportRelease();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(supervisor.health().phase, "waiting");
    assert.equal(supervisor.health().completedCycles, 1);
    assert.equal(supervisor.health().state, "running");
    controller.abort(new Error("fixture done"));
    assert.equal(supervisor.health().state, "stopping");
    await rejected;
    assert.equal(supervisor.health().state, "stopped");
  } finally {
    inventoryRelease(); reportRelease(); controller.abort();
    if (lifetime) await lifetime.catch(() => {});
    await f.close();
  }
});

test("supervisor fails explicitly on adapter/reporting errors, never restarts and preserves the original rejection", async () => {
  const f = await fixture();
  try {
    for (const failurePhase of ["expiry", "execution", "reporting"] as const) {
      const failure = new Error(`fixture ${failurePhase} failure with private adapter details`);
      const controller = new AbortController();
      let attempts = 0;
      const supervisor = createAgentProvisioningWorkerSupervisor(f.journal, {
        execution: {
          ...f.runtime.execution,
          async apply() { attempts++; controller.abort(new Error("concurrent shutdown")); throw failure; },
        },
        expiry: {
          ...f.runtime.expiry,
          async inventory() {
            if (failurePhase === "expiry") { attempts++; throw failure; }
            return [];
          },
        },
      }, { ...f.options, stallAfterMs: 1000 });
      if (failurePhase === "execution") f.enqueue("prepare", randomUUID());
      // The interrupted execution head is observed, never replayed, on the reporting run.
      await assert.rejects(supervisor.run(controller.signal, async () => { attempts++; throw failure; }),
        (error) => error === failure);
      assert.equal(supervisor.health().state, "failed");
      assert.equal(supervisor.health().phase, failurePhase);
      assert.equal(supervisor.health().completedCycles, 0);
      assert.equal(attempts, 1);
      assert.ok(!JSON.stringify(supervisor.health()).includes("private"));
      await assert.rejects(supervisor.run(new AbortController().signal, async () => {}), /single-use/);
      assert.equal(await f.journal.exclusive(async () => "released"), "released");
    }
  } finally { await f.close(); }
});

test("supervisor handles pre-cancellation and rejects invalid thresholds or non-monotonic health clocks", async () => {
  const f = await fixture();
  try {
    for (const stallAfterMs of [0, -1, NaN, Infinity]) {
      assert.throws(() => createAgentProvisioningWorkerSupervisor(f.journal,
        { execution: f.runtime.execution, expiry: f.runtime.expiry }, { stallAfterMs }), /stall threshold/);
    }
    const reason = new Error("fixture pre-cancelled");
    const stopped = createAgentProvisioningWorkerSupervisor(f.journal,
      { execution: f.runtime.execution, expiry: f.runtime.expiry }, { stallAfterMs: 1000 });
    await assert.rejects(stopped.run(AbortSignal.abort(reason), async () => assert.fail("No cancelled cycle")),
      (error) => error === reason);
    assert.equal(stopped.health().state, "stopped");
    for (const value of [NaN, Infinity, -1]) {
      const invalid = createAgentProvisioningWorkerSupervisor(f.journal,
        { execution: f.runtime.execution, expiry: f.runtime.expiry }, { stallAfterMs: 1000, monotonicNow: () => value });
      await assert.rejects(invalid.run(new AbortController().signal, async () => {}), /health clock/);
      assert.equal(invalid.health().state, "failed");
    }
    let tick = 10;
    const controller = new AbortController();
    let entered!: () => void;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const backwards = createAgentProvisioningWorkerSupervisor(f.journal, {
      execution: f.runtime.execution,
      expiry: { ...f.runtime.expiry, async inventory() { entered(); await gate; return []; } },
    }, { stallAfterMs: 1000, monotonicNow: () => tick });
    const lifetime = backwards.run(controller.signal, async () => {});
    const rejected = assert.rejects(lifetime, /health clock/);
    try {
      await started;
      tick = 9;
      assert.throws(() => backwards.health(), /health clock/);
      release();
      await rejected;
      assert.equal(backwards.health().state, "failed");
    } finally { release(); controller.abort(); await lifetime.catch(() => {}); }
  } finally { await f.close(); }
});
