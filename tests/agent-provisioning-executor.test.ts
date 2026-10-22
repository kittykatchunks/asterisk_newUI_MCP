import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAgentProvisioningExecutor } from "../src/agent-provisioning-executor.ts";
import type { AgentProvisioningAdapter } from "../src/agent-provisioning-executor.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-executor-"));
  const path = join(directory, "journal.sqlite");
  const binding = { customer: "customer-a", epoch: randomUUID() };
  let time = 100000;
  const options = { now: () => time };
  let journal = openAgentProvisioningJournal(path, binding, options);
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Synthetic execution" };
  const command = (revision = 1): AgentProvisioningCommand => ({
    version: 1, ...binding, revision, operationId: randomUUID(), leaseId: randomUUID(), notAfter: 160000,
    action: "prepare", payload: { generationId: randomUUID(), extension: "1001" },
  });
  return { get journal() { return journal; }, path, context, command,
    setTime(value: number) { time = value; },
    reopen() { journal.close(); journal = openAgentProvisioningJournal(path, binding, options); },
    async close() { journal.close(); await rm(directory, { recursive: true }); } };
}

test("executor commits applying before fixed-action adapter work and requires observation for verification", async () => {
  const f = await fixture();
  try {
    let applies = 0;
    const adapter: AgentProvisioningAdapter = {
      async apply(command) {
        applies++;
        assert.equal(f.journal.operation(command.operationId)?.receipts.at(-1)?.stage, "applying");
        command.payload.generationId = randomUUID();
      },
      async observe(command) {
        assert.deepEqual(command, f.journal.operation(command.operationId)?.intent.command);
        return "verified";
      },
    };
    const executor = createAgentProvisioningExecutor(f.journal, adapter);
    assert.deepEqual(await executor.step(), { state: "idle" });
    const actions = ["prepare", "activate", "extend", "drain", "revoke"] as const;
    for (const [index, action] of actions.entries()) {
      const base = f.command(index + 1);
      const command: AgentProvisioningCommand = action === "prepare" ? base :
        { ...base, action, payload: { generationId: base.payload.generationId } };
      f.journal.accept(command, f.context);
      assert.deepEqual(await executor.step(), { state: "verified", operationId: command.operationId });
      assert.deepEqual(f.journal.operation(command.operationId)?.receipts.map((r) => r.stage), ["applying", "verified"]);
    }
    assert.equal(applies, 5);
    assert.deepEqual(await executor.step(), { state: "idle" });
  } finally { await f.close(); }
});

test("restart after an effect but before its receipt observes without replay even after expiry", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    let applies = 0;
    const adapter: AgentProvisioningAdapter = {
      async apply() { applies++; throw new Error("fixture crash after effect"); },
      async observe() { return "verified"; },
    };
    await assert.rejects(createAgentProvisioningExecutor(f.journal, adapter).step(), /crash after effect/);
    assert.equal(f.journal.next().state, "reconcile");
    f.reopen(); f.setTime(command.notAfter);
    assert.equal((await createAgentProvisioningExecutor(f.journal, adapter).step()).state, "verified");
    assert.equal(applies, 1);
  } finally { await f.close(); }
});

test("unknown observations remain uncertain without replay or receipt growth and failed observations block later work", async () => {
  const f = await fixture();
  try {
    const first = f.command(); const later = f.command(2);
    f.journal.accept(first, f.context); f.journal.accept(later, f.context);
    let applies = 0;
    let result: "unknown" | "failed" = "unknown";
    const adapter: AgentProvisioningAdapter = {
      async apply() { applies++; }, async observe() { return result; },
    };
    const executor = createAgentProvisioningExecutor(f.journal, adapter);
    assert.equal((await executor.step()).state, "uncertain");
    for (let index = 0; index < 105; index++) assert.equal((await executor.step()).state, "uncertain");
    assert.equal(f.journal.report(first.operationId)?.receipts.length, 2);
    result = "failed";
    assert.equal((await executor.step()).state, "blocked");
    assert.equal((await executor.step()).state, "blocked");
    assert.equal(applies, 1);
    assert.equal(f.journal.operation(later.operationId)?.receipts.length, 0);
  } finally { await f.close(); }
});

test("expired, aborted and failed applying commits never invoke an adapter", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    const adapter: AgentProvisioningAdapter = { async apply() { assert.fail("Unexpected apply"); },
      async observe() { assert.fail("Unexpected observe"); } };
    const executor = createAgentProvisioningExecutor(f.journal, adapter);
    f.setTime(command.notAfter);
    assert.equal((await executor.step()).state, "expired");
    await assert.rejects(executor.step(AbortSignal.abort(new Error("fixture cancelled"))), /cancelled/);
    f.setTime(100000);
    const db = new DatabaseSync(f.path);
    try {
      db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON provisioning_receipts
        BEGIN SELECT RAISE(ABORT, 'fixture commit failure'); END`);
      await assert.rejects(executor.step(), /commit failure/);
      assert.equal(f.journal.operation(command.operationId)?.receipts.length, 0);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test("errors and cancellation after applying leave reconcilable evidence and release shared in-flight ownership", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    const controller = new AbortController();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let applies = 0;
    const adapter: AgentProvisioningAdapter = {
      async apply() { applies++; await gate; controller.abort(new Error("fixture cancelled during apply")); },
      async observe() { throw new Error("fixture observation failed"); },
    };
    const executor = createAgentProvisioningExecutor(f.journal, adapter);
    const running = executor.step(controller.signal);
    try {
      await assert.rejects(createAgentProvisioningExecutor(f.journal, adapter).step(), /already in flight/);
    } finally { unblock(); }
    await assert.rejects(running, /cancelled during apply/);
    await assert.rejects(executor.step(), /observation failed/);
    assert.equal(f.journal.operation(command.operationId)?.receipts.at(-1)?.stage, "applying");
    assert.equal(applies, 1);
  } finally { await f.close(); }
});

test("a crash between applying commit and effect is observation-only, never a blind replay", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    f.journal.record(command.operationId, { receiptId: randomUUID(), sequence: 1,
      stage: "applying", code: "fixture_interrupted_start" });
    f.reopen();
    const adapter: AgentProvisioningAdapter = { async apply() { assert.fail("No blind replay"); },
      async observe() { return "unknown"; } };
    assert.equal((await createAgentProvisioningExecutor(f.journal, adapter).step()).state, "uncertain");
    assert.equal(f.journal.next().state, "reconcile");
  } finally { await f.close(); }
});

test("a failed completion commit recovers by observation and invalid observations never manufacture success", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    let applies = 0;
    let invalid = false;
    const adapter: AgentProvisioningAdapter = {
      async apply() { applies++; },
      async observe() { return invalid ? JSON.parse('"ready"') : "verified"; },
    };
    const executor = createAgentProvisioningExecutor(f.journal, adapter);
    const db = new DatabaseSync(f.path);
    try {
      db.exec(`CREATE TRIGGER reject_completion BEFORE INSERT ON provisioning_receipts WHEN NEW.sequence = 2
        BEGIN SELECT RAISE(ABORT, 'fixture completion commit failure'); END`);
      await assert.rejects(executor.step(), /completion commit failure/);
      assert.equal(f.journal.next().state, "reconcile");
      db.exec("DROP TRIGGER reject_completion");
      invalid = true;
      await assert.rejects(executor.step(), /Invalid provisioning adapter observation/);
      assert.equal(f.journal.operation(command.operationId)?.receipts.length, 1);
      invalid = false;
      f.setTime(command.notAfter);
      assert.equal((await executor.step()).state, "verified");
      assert.equal(applies, 1);
    } finally { db.close(); }
  } finally { await f.close(); }
});

test("the shared five-second adapter budget surfaces timeout and never records verified", async () => {
  const f = await fixture();
  try {
    const command = f.command(); f.journal.accept(command, f.context);
    const executor = createAgentProvisioningExecutor(f.journal, {
      async apply() {},
      async observe(_command, signal) {
        const keepAlive = setTimeout(() => {}, 10000);
        try {
          return await new Promise<never>((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        } finally { clearTimeout(keepAlive); }
      },
    });
    const start = performance.now();
    await assert.rejects(executor.step(), { name: "TimeoutError" });
    assert.ok(performance.now() - start >= 4900);
    assert.equal(f.journal.operation(command.operationId)?.receipts.at(-1)?.stage, "applying");
  } finally { await f.close(); }
});
