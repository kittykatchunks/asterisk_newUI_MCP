import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { createAgentBrokerReadback } from "../src/agent-broker-readback.ts";
import type { BrokerReadbackSource } from "../src/agent-broker-readback.ts";
import { openFakeProvisioningRuntime } from "./identity/fake-provisioning-runtime.ts";

function fixture() {
  const peer = { customer: "customer-a", epoch: randomUUID(), principal: "journal-worker" };
  const generationId = randomUUID();
  const generations = [{ generationId, notAfter: 160000, draining: false }];
  const observation = { newCallsBlocked: true, dialogs: 1, removed: false };
  let reads = 0;
  const source: BrokerReadbackSource = {
    async inventory() { reads++; return generations; },
    async generation(id) { reads++; return id === generationId ? observation : undefined; },
  };
  const broker = createAgentBrokerReadback(peer, source);
  const request = (action: string, extra = {}) => JSON.stringify({
    version: 1, customer: peer.customer, epoch: peer.epoch, action, ...extra,
  });
  return { peer, generationId, generations, observation, source, broker, request, reads: () => reads };
}

test("read-only broker returns exact detached allowlisted inventory, observed and missing generation snapshots", async () => {
  const f = fixture();
  assert.deepEqual(await f.broker.read(f.request("inventory"), f.peer), {
    version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "inventory", generations: f.generations,
  });
  const inventory = await f.broker.read(f.request("inventory"), f.peer);
  assert.equal(inventory.action, "inventory");
  if (inventory.action === "inventory") inventory.generations[0].draining = true;
  assert.equal(f.generations[0].draining, false);
  const observed = await f.broker.read(f.request("generation", { generationId: f.generationId }), f.peer);
  assert.deepEqual(observed, {
    version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "generation",
    generationId: f.generationId, state: "observed", observation: f.observation,
  });
  if (observed.action === "generation" && observed.state === "observed") observed.observation.dialogs = 99;
  assert.equal(f.observation.dialogs, 1);
  const missing = randomUUID();
  assert.deepEqual(await f.broker.read(f.request("generation", { generationId: missing }), f.peer), {
    version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "generation", generationId: missing, state: "missing",
  });
});

test("peer denial happens before decoding or source access and body scope cannot select another customer", async () => {
  const f = fixture();
  for (const peer of [undefined, { ...f.peer, principal: "foreign-worker" },
    { ...f.peer, customer: "customer-b" }, { ...f.peer, epoch: randomUUID() }]) {
    await assert.rejects(f.broker.read("{", peer), /peer denied/);
  }
  for (const extra of [{ customer: "customer-b" }, { epoch: randomUUID() }]) {
    await assert.rejects(f.broker.read(f.request("inventory", extra), f.peer), /scope mismatch/);
  }
  assert.equal(f.reads(), 0);
});

test("protocol rejects mutation/CLI/secret fields, malformed input and oversized UTF-8 requests before source access", async () => {
  const f = fixture();
  for (const text of [
    "", "{", "null", "[]", f.request("apply"), f.request("prepare"), f.request("drain"),
    f.request("inventory", { command: "module reload res_pjsip.so" }),
    f.request("inventory", { path: "..\\pjsip.conf" }), f.request("inventory", { password: "secret" }),
    f.request("inventory", { principal: f.peer.principal }), f.request("inventory", { version: 2 }),
    f.request("generation"), f.request("generation", { generationId: "../bad" }),
    f.request("inventory") + " ".repeat(8192), f.request("inventory", { extra: "\u00e9".repeat(4096) }),
  ]) await assert.rejects(f.broker.read(text, f.peer));
  assert.equal(f.reads(), 0);
  const text = f.request("inventory");
  assert.equal(Buffer.byteLength(text.padEnd(8192)), 8192);
  await f.broker.read(text.padEnd(8192), f.peer);
  assert.equal(f.reads(), 1);
});

test("source output must obey existing expiry inventory/observation contracts without leaking extra fields", async () => {
  const f = fixture();
  for (const invalid of [
    [{ ...f.generations[0], password: "secret" }], [f.generations[0], f.generations[0]],
    [{ ...f.generations[0], notAfter: NaN }], [{ ...f.generations[0], draining: "yes" }],
  ]) {
    const broker = createAgentBrokerReadback(f.peer, { ...f.source, async inventory() { return invalid as never; } });
    await assert.rejects(broker.read(f.request("inventory"), f.peer), /expiry/);
  }
  const hundred = Array.from({ length: 100 }, () => ({ generationId: randomUUID(), notAfter: 160000, draining: false }));
  const maximum = createAgentBrokerReadback(f.peer, { ...f.source, async inventory() { return hundred; } });
  assert.equal((await maximum.read(f.request("inventory"), f.peer)).action, "inventory");
  hundred.push({ generationId: randomUUID(), notAfter: 160000, draining: false });
  await assert.rejects(maximum.read(f.request("inventory"), f.peer), /inventory/);
  for (const invalid of [null, { ...f.observation, token: "secret" }, { ...f.observation, dialogs: -1 },
    { ...f.observation, dialogs: 0.5 }, { ...f.observation, removed: "no" }]) {
    const broker = createAgentBrokerReadback(f.peer, { ...f.source, async generation() { return invalid as never; } });
    await assert.rejects(broker.read(f.request("generation", { generationId: f.generationId }), f.peer), /observation/);
  }
  const unknown = createAgentBrokerReadback(f.peer, {
    ...f.source, async generation() { return { ...f.observation, dialogs: "unknown" }; },
  });
  assert.equal((await unknown.read(f.request("generation", { generationId: f.generationId }), f.peer)).action, "generation");
});

test("readback detaches configuration and request before awaits, propagates failure and retains overlap guard until settlement", async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = new AbortController();
  const broker = createAgentBrokerReadback(f.peer, {
    ...f.source, async inventory() { enter(); await gate; return f.generations; },
  });
  const pending = broker.read(f.request("inventory"), f.peer, controller.signal);
  const reason = new Error("fixture cancelled");
  const rejected = assert.rejects(pending, (error) => error === reason);
  try {
    await entered;
    controller.abort(reason);
    await assert.rejects(broker.read(f.request("inventory"), f.peer), /already in flight/);
  } finally { release(); }
  await rejected;
  assert.equal((await broker.read(f.request("inventory"), f.peer)).action, "inventory");
  await assert.rejects(broker.read(f.request("inventory"), f.peer, AbortSignal.abort(reason)), (error) => error === reason);
  const failing = createAgentBrokerReadback(f.peer, { ...f.source, async inventory() { throw reason; } });
  await assert.rejects(failing.read(f.request("inventory"), f.peer), (error) => error === reason);
  const original = { ...f.peer };
  const stable = createAgentBrokerReadback(f.peer, f.source);
  f.peer.customer = "customer-b";
  assert.equal((await stable.read(JSON.stringify({ version: 1, customer: original.customer, epoch: original.epoch,
    action: "inventory" }), original)).customer, original.customer);
});

test("readback cooperative timeout is explicit and invalid bindings fail before use", async () => {
  const f = fixture();
  for (const binding of [{ ...f.peer, principal: "../bad" }, { ...f.peer, epoch: "bad" },
    { ...f.peer, customer: "../bad" }, { ...f.peer, extra: true }]) {
    assert.throws(() => createAgentBrokerReadback(binding, f.source), /binding/);
  }
  const broker = createAgentBrokerReadback(f.peer, {
    ...f.source, async inventory(signal) { await delay(10000, undefined, { signal }); return []; },
  });
  await assert.rejects(broker.read(f.request("inventory"), f.peer), { name: "AbortError" });
});

test("readback against the durable fake runtime does not apply, fence, revoke or change its database", async () => {
  const f = fixture();
  const directory = await mkdtemp(join(tmpdir(), "asterisk-broker-readback-"));
  const path = join(directory, "runtime.sqlite");
  const runtime = openFakeProvisioningRuntime(path, { customer: f.peer.customer, epoch: f.peer.epoch }, { now: () => 100000 });
  try {
    await runtime.execution.apply({
      version: 1, customer: f.peer.customer, epoch: f.peer.epoch, revision: 1,
      operationId: randomUUID(), leaseId: randomUUID(), notAfter: 160000, action: "prepare",
      payload: { generationId: f.generationId, extension: "1001" },
    }, AbortSignal.timeout(5000));
    const broker = createAgentBrokerReadback(f.peer, {
      inventory: runtime.expiry.inventory,
      generation: runtime.expiry.observe,
    });
    const before = await readFile(path);
    assert.deepEqual(await broker.read(f.request("inventory"), f.peer), {
      version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "inventory", generations: f.generations,
    });
    const result = await broker.read(f.request("generation", { generationId: f.generationId }), f.peer);
    assert.deepEqual(result, {
      version: 1, customer: f.peer.customer, epoch: f.peer.epoch, action: "generation",
      generationId: f.generationId, state: "observed", observation: { newCallsBlocked: true, dialogs: 0, removed: false },
    });
    await assert.rejects(broker.read(f.request("revoke", { generationId: f.generationId }), f.peer), /fields or action/);
    assert.deepEqual(await readFile(path), before);
    assert.equal(runtime.effectCount(), 1);
    assert.equal(runtime.generation(f.generationId).phase, "prepared");
  } finally { runtime.close(); await rm(directory, { recursive: true }); }
});
