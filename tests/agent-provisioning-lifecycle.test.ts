import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAgentProvisioningExecutor } from "../src/agent-provisioning-executor.ts";
import { createAgentProvisioningExpiry } from "../src/agent-provisioning-expiry.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";
import { openFakeProvisioningRuntime } from "./identity/fake-provisioning-runtime.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-lifecycle-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  let time = 100000;
  const options = { now: () => time };
  const path = join(directory, "runtime.sqlite");
  let runtime = openFakeProvisioningRuntime(path, binding, options);
  const journalPath = join(directory, "journal.sqlite");
  let journal = openAgentProvisioningJournal(journalPath, binding, options);
  let revision = 0;
  const generationId = randomUUID();
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Fake lifecycle" };
  const command = (action: AgentProvisioningCommand["action"], id = generationId, deadline = 160000): AgentProvisioningCommand => {
    const base = { version: 1 as const, ...binding, operationId: randomUUID(), revision: ++revision,
      leaseId: randomUUID(), notAfter: deadline };
    return action === "prepare" ? { ...base, action, payload: { generationId: id, extension: "1001" } } :
      { ...base, action, payload: { generationId: id } };
  };
  const run = async (input: AgentProvisioningCommand) => {
    journal.accept(input, context);
    return createAgentProvisioningExecutor(journal, runtime.execution, options).step();
  };
  return { directory, path, binding, options, generationId, command, run,
    get runtime() { return runtime; }, get journal() { return journal; },
    time(value: number) { time = value; },
    sweep() { return createAgentProvisioningExpiry(journal, runtime.expiry, options).sweep(); },
    reopen() {
      runtime.close(); journal.close();
      runtime = openFakeProvisioningRuntime(path, binding, options);
      journal = openAgentProvisioningJournal(journalPath, binding, options);
    },
    async close() { runtime.close(); journal.close(); await rm(directory, { recursive: true }); } };
}

test("durable fake lifecycle preserves renewed active calls, blocks replacement while draining and allows it only after removal", async () => {
  const f = await fixture();
  const signal = AbortSignal.timeout(5000);
  try {
    assert.equal((await f.run(f.command("prepare"))).state, "verified");
    assert.throws(() => f.runtime.startCall(f.generationId), /new call denied/);
    assert.equal((await f.run(f.command("activate"))).state, "verified");
    f.runtime.startCall(f.generationId);
    f.time(130000);
    const extended = f.command("extend", f.generationId, 190000);
    assert.equal((await f.run(extended)).state, "verified");
    await f.runtime.execution.apply(extended, signal);
    assert.equal(f.runtime.effectCount(), 3, "Exact retries cannot duplicate effects");
    f.time(160001);
    assert.deepEqual(await f.sweep(), [], "Extension survives the old deadline");
    f.reopen();
    assert.equal(f.runtime.generation(f.generationId).dialogs, 1);
    f.time(190000);
    assert.throws(() => f.runtime.startCall(f.generationId), /new call denied/,
      "The fake new-call boundary checks expiry even before the sweep latches drain");
    assert.deepEqual(await f.sweep(), [{ generationId: f.generationId, state: "draining" }]);
    assert.throws(() => f.runtime.startCall(f.generationId), /new call denied/);
    const replacement = f.command("prepare", randomUUID(), 250000);
    await assert.rejects(f.runtime.execution.apply(replacement, signal), /replacement blocked/);
    await assert.rejects(f.runtime.execution.apply(f.command("extend", f.generationId, 250000), signal),
      /cannot activate or extend/);
    f.runtime.setDialogs(f.generationId, "unknown");
    assert.equal((await f.sweep())[0].state, "uncertain");
    await assert.rejects(f.runtime.expiry.revoke(f.generationId, signal), /zero-dialog/);
    f.reopen(); f.time(110000);
    assert.equal((await f.sweep())[0].state, "uncertain", "Drain survives restart and clock rollback");
    await assert.rejects(f.runtime.execution.apply(replacement, signal), /replacement blocked/);
    f.runtime.setDialogs(f.generationId, 0);
    assert.equal((await f.sweep())[0].state, "revoked");
    await f.runtime.execution.apply(replacement, signal);
    assert.equal(f.runtime.generation(replacement.payload.generationId).phase, "prepared");
    assert.equal(f.runtime.generation(f.generationId).phase, "removed");
  } finally { await f.close(); }
});

test("explicit fake drain/revoke actions share the same irreversible lifecycle and transactional dialog checks", async () => {
  const f = await fixture();
  const signal = AbortSignal.timeout(5000);
  try {
    for (const action of ["prepare", "activate", "drain"] as const) {
      assert.equal((await f.run(f.command(action))).state, "verified");
    }
    assert.throws(() => f.runtime.startCall(f.generationId), /new call denied/);
    const activation = f.command("activate");
    await assert.rejects(f.runtime.execution.apply(activation, signal), /cannot activate or extend/);
    f.runtime.setDialogs(f.generationId, 1);
    const revoke = f.command("revoke");
    await assert.rejects(f.runtime.execution.apply(revoke, signal), /zero-dialog/);
    assert.equal(await f.runtime.execution.observe(revoke, signal), "unknown");
    f.runtime.setDialogs(f.generationId, 0);
    await f.runtime.execution.apply(revoke, signal);
    assert.equal(await f.runtime.execution.observe(revoke, signal), "verified");
    await f.runtime.execution.apply(revoke, signal);
    assert.equal(f.runtime.effectCount(), 4);
    await assert.rejects(f.runtime.execution.apply({ ...revoke, notAfter: revoke.notAfter + 1 }, signal),
      /operation conflict/);
  } finally { await f.close(); }
});

test("fake runtime rejects foreign scope, stale authority, expired operations and competing replacement writes", async () => {
  const f = await fixture();
  const signal = AbortSignal.timeout(5000);
  const other = openFakeProvisioningRuntime(f.path, f.binding, f.options);
  try {
    assert.throws(() => openFakeProvisioningRuntime(f.path, { ...f.binding, epoch: randomUUID() }), /binding mismatch/);
    for (const scope of [{ ...f.binding, customer: "customer-b" }, { ...f.binding, epoch: randomUUID() }]) {
      await assert.rejects(f.runtime.execution.apply({ ...f.command("prepare"), ...scope }, signal), /scope mismatch/);
    }
    const expired = f.command("prepare");
    f.time(expired.notAfter);
    await assert.rejects(f.runtime.execution.apply(expired, signal), /expired/);
    f.time(100000);
    const candidates = [f.command("prepare", randomUUID()), f.command("prepare", randomUUID())];
    const results = await Promise.allSettled([
      f.runtime.execution.apply(candidates[0], signal), other.execution.apply(candidates[1], signal),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.equal(f.runtime.effectCount(), 1);
    await assert.rejects(other.execution.apply(f.command("drain", randomUUID()), signal), /missing fake generation/);
    await assert.rejects(other.execution.apply(f.command("drain"), AbortSignal.abort(new Error("fixture aborted"))),
      /fixture aborted/);
  } finally { other.close(); await f.close(); }
});

test("fake generation mutation and immutable effect evidence roll back together on a late write failure", async () => {
  const f = await fixture();
  const writer = new DatabaseSync(f.path);
  const signal = AbortSignal.timeout(5000);
  try {
    const prepare = f.command("prepare");
    writer.exec(`CREATE TRIGGER reject_effect BEFORE INSERT ON fake_effects
      BEGIN SELECT RAISE(ABORT, 'fixture effect write failure'); END`);
    await assert.rejects(f.runtime.execution.apply(prepare, signal), /effect write failure/);
    assert.throws(() => f.runtime.generation(f.generationId), /missing fake generation/);
    assert.equal(f.runtime.effectCount(), 0);
    writer.exec("DROP TRIGGER reject_effect");
    await f.runtime.execution.apply(prepare, signal);
    assert.equal(f.runtime.generation(f.generationId).phase, "prepared");
    assert.equal(f.runtime.effectCount(), 1);
    f.reopen();
    assert.equal(await f.runtime.execution.observe(prepare, signal), "verified");
  } finally { writer.close(); await f.close(); }
});
