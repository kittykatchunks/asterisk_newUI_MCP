import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAuthorisedProvisioningTransport } from "../src/agent-provisioning-authorisation.ts";
import { createAgentProvisioningDispatcher } from "../src/agent-provisioning-dispatcher.ts";
import { openAgentDeviceLeaseStore } from "../src/agent-device-lease.ts";
import { openAgentProvisioningStore, openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";
import type { AccessResult } from "../src/access.ts";
import type { ApplicationSessionIdentity } from "../src/application-session.ts";
import type { AgentProfile } from "../src/agent-directory.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-live-dispatch-"));
  let time = 100000;
  const options = { now: () => time };
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const owner = { issuer: "https://identity.example/realms/test", subject: "alice", customer: binding.customer,
    sessionId: randomBytes(32).toString("base64url"), sessionExpiresAt: 300000, deviceId: randomUUID() };
  const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"), options);
  const lease = leases.acquire(owner);
  const store = openAgentProvisioningStore(join(directory, "backend.sqlite"), options);
  const journal = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding, options);
  store.enrol(binding.customer, binding.epoch);
  const command: AgentProvisioningCommand = { version: 1, ...binding, operationId: randomUUID(), leaseId: lease.id,
    revision: 1, notAfter: lease.expiresAt, action: "prepare",
    payload: { generationId: randomUUID(), extension: "1001" } };
  const context = { requestId: randomUUID(), actor: "assertion-not-authority", reason: "Fixture" };
  const intent = store.enqueue(command, context);
  let session: ApplicationSessionIdentity | undefined = {
    sessionId: owner.sessionId, subject: owner.subject, customer: owner.customer, expiresAt: owner.sessionExpiresAt,
  };
  let profile: AgentProfile | undefined = { extension: "1001", displayName: "Alice" };
  let access: AccessResult = { allowed: true, subject: owner.subject, basis: "membership" };
  let duringAccess = () => {};
  let mapping = true;
  let accepted = 0;
  const transport = createAuthorisedProvisioningTransport({
    async report(id, signal) { signal.throwIfAborted(); return journal.report(id); },
    async accept(input, signal) {
      signal.throwIfAborted(); accepted++;
      journal.accept(input.command, input.context);
      return journal.report(input.command.operationId)!;
    },
  }, binding, {
    resolve() { return mapping ? { owner, generationId: command.payload.generationId, extension: "1001" } : undefined; },
    session() { return session; },
    async agentAccess() { duringAccess(); return access; },
    agents: { profile() { return profile; } }, leases,
  });
  return { owner, lease, leases, store, journal, command, intent, transport, options, binding,
    accepts: () => accepted,
    session(value: typeof session) { session = value; }, profile(value: typeof profile) { profile = value; },
    access(value: AccessResult) { access = value; }, hook(value: () => void) { duringAccess = value; },
    mapping(value: boolean) { mapping = value; }, time(value: number) { time = value; },
    async close() { leases.close(); store.close(); journal.close(); await rm(directory, { recursive: true }); } };
}

test("authorised dispatch checks real owned leases without renewing or leaking session/device context", async () => {
  const f = await fixture();
  try {
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, f.transport, f.options);
    assert.equal((await dispatcher.dispatch()).state, "accepted");
    assert.equal(f.accepts(), 1);
    assert.deepEqual(f.leases.current(f.owner, f.lease.id), f.lease);
    const stored = f.journal.operation(f.command.operationId)!;
    assert.equal(JSON.stringify(stored).includes(f.owner.sessionId), false);
    assert.equal(JSON.stringify(stored).includes(f.owner.deviceId), false);
    f.session(undefined);
    assert.equal((await dispatcher.dispatch()).state, "accepted", "Existing history remains readable after logout");
    assert.equal(f.accepts(), 1);
  } finally { await f.close(); }
});

test("logout, lease loss, assignment change and membership denial while verification yields prevent acceptance", async () => {
  for (const scenario of ["logout", "rotated", "released", "expired", "shortened", "assignment", "removed", "denied", "support", "subject"] as const) {
    const f = await fixture();
    try {
      f.hook(() => {
        if (scenario === "logout") f.session(undefined);
        if (scenario === "rotated") f.session({ sessionId: randomBytes(32).toString("base64url"),
          subject: f.owner.subject, customer: f.owner.customer, expiresAt: 300000 });
        if (scenario === "released") f.leases.release(f.owner, f.lease.id);
        if (scenario === "expired") f.time(f.lease.expiresAt);
        if (scenario === "shortened") f.session({ sessionId: f.owner.sessionId,
          subject: f.owner.subject, customer: f.owner.customer, expiresAt: f.lease.expiresAt - 1 });
        if (scenario === "assignment") f.profile({ extension: "1002", displayName: "Alice" });
        if (scenario === "removed") f.profile(undefined);
        if (scenario === "denied") f.access({ allowed: false, status: 403, code: "denied" });
        if (scenario === "support") f.access({ allowed: true, subject: f.owner.subject, basis: "support-grant" });
        if (scenario === "subject") f.access({ allowed: true, subject: "bob", basis: "membership" });
      });
      await assert.rejects(f.transport.accept(f.intent, AbortSignal.timeout(5000)));
      assert.equal(f.accepts(), 0, scenario);
      assert.equal(f.journal.operation(f.command.operationId), undefined);
    } finally { await f.close(); }
  }
});

test("prepare/activate/extend require mapped ownership and bounded deadlines; cleanup remains possible after logout", async () => {
  const f = await fixture();
  const signal = AbortSignal.timeout(5000);
  try {
    for (const action of ["prepare", "activate", "extend"] as const) {
      const base = { ...f.command, notAfter: f.lease.expiresAt + 1 };
      const command: AgentProvisioningCommand = action === "prepare" ? { ...base, action, payload: { ...f.command.payload, extension: "1001" } } :
        { ...base, action, payload: { generationId: f.command.payload.generationId } };
      await assert.rejects(f.transport.accept({ ...f.intent, command }, signal), /deadline exceeds live lease/);
    }
    f.mapping(false);
    await assert.rejects(f.transport.accept(f.intent, signal), /context missing/);
    f.mapping(true);
    await assert.rejects(f.transport.accept({ ...f.intent, command: {
      ...f.command, payload: { generationId: randomUUID(), extension: "1001" }, action: "prepare",
    } }, signal), /context mismatch/);
    await assert.rejects(f.transport.accept({ ...f.intent, command: { ...f.command, customer: "customer-b" } }, signal), /scope mismatch/);
    f.session(undefined);
    f.mapping(false);
    for (const action of ["drain", "revoke"] as const) {
      const command: AgentProvisioningCommand = { ...f.command, operationId: randomUUID(),
        revision: action === "drain" ? 1 : 2, action, payload: { generationId: f.command.payload.generationId } };
      assert.equal((await f.transport.accept({ ...f.intent, command }, signal)).operationId, command.operationId);
    }
    assert.equal(f.accepts(), 2);
  } finally { await f.close(); }
});

test("verification failures and cancellation propagate without dispatching or fabricating receipts", async () => {
  const f = await fixture();
  try {
    f.hook(() => { throw new Error("fixture identity unavailable"); });
    await assert.rejects(f.transport.accept(f.intent, AbortSignal.timeout(5000)), /identity unavailable/);
    assert.equal(f.accepts(), 0);
    const controller = new AbortController();
    f.hook(() => { controller.abort(new Error("fixture cancelled")); });
    await assert.rejects(f.transport.accept(f.intent, controller.signal), /fixture cancelled/);
    assert.equal(f.accepts(), 0);
    f.hook(() => {});
    f.profile({ extension: "invalid", displayName: "Alice" });
    await assert.rejects(f.transport.accept(f.intent, AbortSignal.timeout(5000)), /Invalid provisioned agent profile/);
    assert.equal(f.accepts(), 0);
    assert.equal(f.journal.operation(f.command.operationId), undefined);
  } finally { await f.close(); }
});

test("live activate/extend accept at the exact lease cap and release during report lookup prevents later send", async () => {
  for (const action of ["activate", "extend"] as const) {
    const f = await fixture();
    try {
      const command: AgentProvisioningCommand = { ...f.command, action,
        payload: { generationId: f.command.payload.generationId } };
      const report = await f.transport.accept({ ...f.intent, command }, AbortSignal.timeout(5000));
      assert.equal(report.operationId, command.operationId);
      assert.equal(f.accepts(), 1);
    } finally { await f.close(); }
  }
  const f = await fixture();
  try {
    const dispatcher = createAgentProvisioningDispatcher(f.store, f.binding, {
      ...f.transport,
      async report(id, signal) {
        const result = await f.transport.report(id, signal);
        f.leases.release(f.owner, f.lease.id);
        return result;
      },
    }, f.options);
    await assert.rejects(dispatcher.dispatch(), /device_lease_not_owned/);
    assert.equal(f.accepts(), 0);
    assert.equal(f.store.operation(f.binding.customer, f.command.operationId)?.receipts.length, 0);
  } finally { await f.close(); }
});
