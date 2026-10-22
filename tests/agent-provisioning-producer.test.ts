import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AccessResult } from "../src/access.ts";
import type { ApplicationSessionIdentity } from "../src/application-session.ts";
import type { AgentProfile } from "../src/agent-directory.ts";
import { openAgentDeviceLeaseStore } from "../src/agent-device-lease.ts";
import { createSessionProvisioningProducer } from "../src/agent-provisioning-authorisation.ts";
import { openAgentProvisioningStore } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-producer-"));
  let time = 100000;
  const options = { now: () => time };
  const owner = { issuer: "https://identity.invalid", subject: "alice", customer: "customer-a",
    sessionId: randomBytes(32).toString("base64url"), sessionExpiresAt: 300000, deviceId: randomUUID() };
  const authorisationId = randomBytes(32).toString("base64url");
  const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"), options);
  const lease = leases.acquire(owner);
  const path = join(directory, "backend.sqlite");
  const store = openAgentProvisioningStore(path, options);
  const epoch = randomUUID();
  store.enrol(owner.customer, epoch);
  let session: ApplicationSessionIdentity | undefined = {
    sessionId: owner.sessionId, subject: owner.subject, customer: owner.customer, expiresAt: owner.sessionExpiresAt,
  };
  let profile: AgentProfile | undefined = { extension: "1001", displayName: "Alice" };
  let access: AccessResult = { allowed: true, subject: "alice", basis: "membership" };
  let hook = async () => {};
  const producer = createSessionProvisioningProducer({
    store, leases, agents: { profile() { return profile; } },
    sessions: {
      lookupIdentity() { return session; },
      async verifyAgentAccess(owner, verify, signal) {
        await hook();
        return verify(undefined, owner.customer, "agent:access");
      },
      authorisationReference() { return session ? authorisationId : undefined; },
    },
    async verify() { return access; },
  });
  const command: AgentProvisioningCommand = {
    version: 1, customer: owner.customer, epoch, operationId: randomUUID(), revision: 1,
    leaseId: lease.id, notAfter: lease.expiresAt, action: "prepare",
    payload: { generationId: randomUUID(), extension: "1001" },
  };
  const context = { requestId: randomUUID(), actor: "trusted-fixture", reason: "Original authenticated owner" };
  return { directory, path, owner, authorisationId, leases, lease, store, producer, command, context,
    session(value: typeof session) { session = value; }, profile(value: typeof profile) { profile = value; },
    access(value: AccessResult) { access = value; }, hook(value: () => Promise<void>) { hook = value; },
    time(value: number) { time = value; },
    async close() { store.close(); leases.close(); await rm(directory, { recursive: true }); } };
}

test("session producer captures derived original ownership without renewing the lease or dispatching", async () => {
  const f = await fixture();
  try {
    const signal = AbortSignal.timeout(5000);
    for (const [index, action] of (["prepare", "activate", "extend"] as const).entries()) {
      const command: AgentProvisioningCommand = action === "prepare" ? f.command : {
        ...f.command, operationId: randomUUID(), revision: index + 1, action,
        payload: { generationId: f.command.payload.generationId },
      };
      const intent = await f.producer.enqueue(command, f.context, f.owner, signal);
      assert.deepEqual(await f.producer.enqueue(command, f.context, f.owner, signal), intent);
      assert.deepEqual(f.store.ownership(command.customer, command.operationId), {
        issuer: f.owner.issuer, subject: f.owner.subject, customer: f.owner.customer,
        authorisationId: f.authorisationId, sessionExpiresAt: f.owner.sessionExpiresAt,
        deviceId: f.owner.deviceId, generationId: command.payload.generationId, extension: "1001",
      });
      assert.deepEqual(f.store.operation(command.customer, command.operationId)?.receipts, []);
    }
    assert.deepEqual(f.leases.current(f.owner, f.lease.id), f.lease);
    assert.ok(!(await readFile(f.path)).includes(Buffer.from(f.owner.sessionId)));
  } finally { await f.close(); }
});

test("live session, membership, assignment, lease and cancellation races leave no intent or ownership", async () => {
  for (const scenario of ["logout", "rotation", "release", "expiry", "shorten", "assignment", "removed",
    "denied", "support", "subject", "unavailable", "exception", "cancel"] as const) {
    const f = await fixture();
    const controller = new AbortController();
    try {
      f.hook(async () => {
        if (scenario === "logout") f.session(undefined);
        if (scenario === "rotation") f.session({ sessionId: randomBytes(32).toString("base64url"),
          subject: f.owner.subject, customer: f.owner.customer, expiresAt: f.owner.sessionExpiresAt });
        if (scenario === "release") f.leases.release(f.owner, f.lease.id);
        if (scenario === "expiry") f.time(f.lease.expiresAt);
        if (scenario === "shorten") f.session({ sessionId: f.owner.sessionId,
          subject: f.owner.subject, customer: f.owner.customer, expiresAt: f.lease.expiresAt - 1 });
        if (scenario === "assignment") f.profile({ extension: "1002", displayName: "Alice" });
        if (scenario === "removed") f.profile(undefined);
        if (scenario === "denied") f.access({ allowed: false, status: 403, code: "denied" });
        if (scenario === "support") f.access({ allowed: true, subject: "alice", basis: "support-grant" });
        if (scenario === "subject") f.access({ allowed: true, subject: "bob", basis: "membership" });
        if (scenario === "unavailable") f.access({ allowed: false, status: 503, code: "identity_verification_unavailable" });
        if (scenario === "exception") throw new Error("fixture verification failure");
        if (scenario === "cancel") controller.abort(new Error("fixture cancelled"));
      });
      await assert.rejects(f.producer.enqueue(f.command, f.context, f.owner, controller.signal));
      assert.equal(f.store.operation(f.command.customer, f.command.operationId), undefined, scenario);
      assert.equal(f.store.ownership(f.command.customer, f.command.operationId), undefined, scenario);
      assert.equal(f.store.next(f.command.customer, f.command.epoch).state, "idle");
    } finally { await f.close(); }
  }
});

test("producer rejects cleanup, foreign scope, incorrect assignment/deadline and pre-cancellation", async () => {
  const f = await fixture();
  try {
    const signal = AbortSignal.timeout(5000);
    for (const action of ["drain", "revoke"] as const) {
      await assert.rejects(f.producer.enqueue({ ...f.command, action,
        payload: { generationId: f.command.payload.generationId } }, f.context, f.owner, signal), /trusted cleanup/);
    }
    await assert.rejects(f.producer.enqueue({ ...f.command, customer: "customer-b" }, f.context, f.owner, signal), /context mismatch/);
    await assert.rejects(f.producer.enqueue({ ...f.command, action: "prepare",
      payload: { ...f.command.payload, extension: "1002" } }, f.context, f.owner, signal), /assignment changed/);
    await assert.rejects(f.producer.enqueue({ ...f.command, notAfter: f.lease.expiresAt + 1 }, f.context, f.owner, signal), /exceeds live lease/);
    await assert.rejects(f.producer.enqueue(f.command, f.context, f.owner,
      AbortSignal.abort(new Error("fixture pre-cancelled"))), /pre-cancelled/);
    assert.equal(f.store.operation(f.command.customer, f.command.operationId), undefined);
  } finally { await f.close(); }
});

test("producer detaches command, context and owner before asynchronous verification", async () => {
  const f = await fixture();
  const original = structuredClone({ command: f.command, context: f.context, owner: f.owner });
  try {
    f.hook(async () => {
      f.command.notAfter++;
      f.command.payload.generationId = randomUUID();
      f.context.reason = "Changed while pending";
      f.owner.subject = "bob";
      f.owner.deviceId = randomUUID();
    });

    const intent = await f.producer.enqueue(f.command, f.context, f.owner, AbortSignal.timeout(5000));
    assert.deepEqual(intent.command, original.command);
    assert.deepEqual(intent.context, original.context);
    assert.equal(f.store.ownership(original.command.customer, original.command.operationId)?.subject, original.owner.subject);
    assert.equal(f.store.ownership(original.command.customer, original.command.operationId)?.deviceId, original.owner.deviceId);
  } finally { await f.close(); }
});

test("final lease check and intent commit share one synchronous turn", async () => {
  const f = await fixture();
  try {
    const current = f.leases.current.bind(f.leases);
    let committedBeforeRelease = false;
    f.leases.current = (owner, id) => {
      const lease = current(owner, id);
      queueMicrotask(() => {
        committedBeforeRelease = f.store.operation(f.command.customer, f.command.operationId) !== undefined;
        f.leases.release(f.owner, f.lease.id);
      });
      return lease;
    };
    await f.producer.enqueue(f.command, f.context, f.owner, AbortSignal.timeout(5000));
    assert.equal(committedBeforeRelease, true, "No extra await is allowed after the final live checks");
  } finally { await f.close(); }
});
