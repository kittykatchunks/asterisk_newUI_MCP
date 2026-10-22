import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentProvisioningExpiry, runAgentProvisioningExpiry } from "../src/agent-provisioning-expiry.ts";
import type { AgentProvisioningExpiryAdapter } from "../src/agent-provisioning-expiry.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";
import { openFakeProvisioningRuntime } from "./identity/fake-provisioning-runtime.ts";

test("monitor fences at real expiry without a controller, drains the call and revokes after it ends", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-expiry-monitor-"));
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const journal = openAgentProvisioningJournal(join(directory, "journal.sqlite"), binding);
  const runtime = openFakeProvisioningRuntime(join(directory, "runtime.sqlite"), binding);
  const id = randomUUID();
  const deadline = Date.now() + 400;
  const setupSignal = AbortSignal.timeout(5000);
  const base = { version: 1 as const, ...binding, leaseId: randomUUID(), notAfter: deadline };
  const prepare: AgentProvisioningCommand = { ...base, operationId: randomUUID(), revision: 1,
    action: "prepare", payload: { generationId: id, extension: "1001" } };
  await runtime.execution.apply(prepare, setupSignal);
  await runtime.execution.apply({ ...base, operationId: randomUUID(), revision: 2,
    action: "activate", payload: { generationId: id } }, setupSignal);
  runtime.startCall(id);
  let fencedAt = 0;
  let revokedAt = 0;
  let calls = 0;
  const adapter: AgentProvisioningExpiryAdapter = {
    ...runtime.expiry,
    async fence(generationId, signal) {
      if (!fencedAt) fencedAt = Date.now();
      await runtime.expiry.fence(generationId, signal);
    },
    async revoke(generationId, signal) {
      assert.equal(runtime.generation(id).dialogs, 0);
      assert.equal(runtime.generation(id).phase, "draining");
      await runtime.expiry.revoke(generationId, signal);
      revokedAt = Date.now();
    },
  };
  const controller = new AbortController();
  let finished!: () => void;
  const complete = new Promise<void>((resolve) => { finished = resolve; });
  const running = runAgentProvisioningExpiry(createAgentProvisioningExpiry(journal, adapter),
    controller.signal, async (results) => {
      calls++;
      if (results[0]?.state === "draining") {
        assert.equal(runtime.generation(id).dialogs, 1, "Expiry must preserve the active call");
        assert.equal(runtime.generation(id).phase, "draining");
        runtime.setDialogs(id, 0);
      }
      if (results[0]?.state === "revoked") finished();
    });
  // Attach a rejection observer immediately so a failed monitor is never unhandled.
  const stopped = running.then(() => undefined, (error: unknown) => error);
  const watchdog = new AbortController();
  try {
    await Promise.race([complete, running, delay(4000, undefined, { signal: watchdog.signal })
      .then(() => assert.fail("Expiry monitor did not revoke"))]);
    watchdog.abort();
    assert.ok(fencedAt >= deadline, "No premature fencing");
    assert.ok(fencedAt - deadline < 1000, "Idle monitor must detect expiry within one second in the fixture");
    assert.ok(revokedAt >= fencedAt);
    assert.ok(calls >= 3, "Immediate sweep must be followed by scheduled sweeps");
    controller.abort(new Error("fixture shutdown"));
    assert.ok(await stopped instanceof Error);
    const count = calls;
    await delay(300);
    assert.equal(calls, count, "Shutdown must leave no scheduled sweep");
    assert.equal(await journal.exclusive(async () => "released"), "released");
  } finally {
    watchdog.abort();
    controller.abort(); await stopped;
    journal.close(); runtime.close(); await rm(directory, { recursive: true });
  }
});

test("monitor is serial, waits 250ms after reporting, and stops on callback or adapter errors", async () => {
  const controller = new AbortController();
  const starts: number[] = [];
  let reporting = false;
  const expiry = { async sweep() {
    assert.equal(reporting, false, "Sweep must not overlap reporting");
    starts.push(performance.now());
    return [];
  } };
  await assert.rejects(runAgentProvisioningExpiry(expiry, controller.signal, async () => {
    reporting = true;
    await delay(30);
    reporting = false;
    if (starts.length === 2) throw new Error("fixture report failure");
  }), /report failure/);
  assert.equal(starts.length, 2);
  assert.ok(starts[1] - starts[0] >= 275);
  let reported = false;
  await assert.rejects(runAgentProvisioningExpiry({ async sweep() { throw new Error("fixture adapter failure"); } },
    controller.signal, async () => { reported = true; }), /adapter failure/);
  assert.equal(reported, false);
  await assert.rejects(runAgentProvisioningExpiry(expiry, AbortSignal.abort(new Error("fixture pre-aborted")),
    async () => assert.fail("No sweep callback")), /pre-aborted/);
  assert.equal(starts.length, 2);
});

test("shutdown during an adapter call keeps ownership until the call actually settles", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-monitor-stop-"));
  const journal = openAgentProvisioningJournal(join(directory, "journal.sqlite"),
    { customer: "customer-a", epoch: randomUUID() });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const controller = new AbortController();
  const running = runAgentProvisioningExpiry(createAgentProvisioningExpiry(journal, {
    async inventory() { started(); await gate; return []; },
    async fence() { assert.fail(); }, async observe() { assert.fail(); }, async revoke() { assert.fail(); },
  }), controller.signal, async () => assert.fail("Aborted sweep cannot report success"));
  const stopped = running.then(() => undefined, (error: unknown) => error);
  try {
    await entered; controller.abort(new Error("fixture shutdown during inventory"));
    await assert.rejects(journal.exclusive(async () => {}), /locked/);
    release();
    const error = await stopped;
    assert.ok(error instanceof Error); assert.match(error.message, /shutdown during inventory/);
    assert.equal(await journal.exclusive(async () => "released"), "released");
  } finally {
    release(); controller.abort(); await stopped;
    journal.close(); await rm(directory, { recursive: true });
  }
});
