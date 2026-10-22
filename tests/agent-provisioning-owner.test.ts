import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openAgentProvisioningStore, openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningOwnership } from "../src/agent-provisioning-store.ts";

function fixture() {
  const command: AgentProvisioningCommand = {
    version: 1, customer: "customer-a", epoch: randomUUID(), operationId: randomUUID(), revision: 1,
    leaseId: randomUUID(), notAfter: 160000, action: "prepare",
    payload: { generationId: randomUUID(), extension: "1001" },
  };
  const owner: ProvisioningOwnership = {
    issuer: "https://identity.invalid", subject: "alice", customer: command.customer,
    authorisationId: randomBytes(32).toString("base64url"), sessionExpiresAt: 180000,
    deviceId: randomUUID(), generationId: command.payload.generationId, extension: "1001",
  };
  return { command, owner, context: { requestId: randomUUID(), actor: "fixture", reason: "Owned intent" } };
}

test("owned intents persist exact detached ownership atomically and never transmit it to the worker", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-owner-"));
  const path = join(directory, "backend.sqlite");
  const store = openAgentProvisioningStore(path, { now: () => 100000 });
  const writer = new DatabaseSync(path);
  const { command, owner, context } = fixture();
  const workerPath = join(directory, "worker.sqlite");
  const worker = openAgentProvisioningJournal(workerPath, { customer: command.customer, epoch: command.epoch }, { now: () => 100000 });
  try {
    store.enrol(command.customer, command.epoch);
    writer.exec(`CREATE TRIGGER reject_owner BEFORE INSERT ON provisioning_ownership
      BEGIN SELECT RAISE(ABORT, 'fixture ownership failure'); END;`);
    assert.throws(() => store.enqueueOwned(command, context, owner), /fixture ownership failure/);
    assert.equal(store.operation(command.customer, command.operationId), undefined);
    assert.equal(store.ownership(command.customer, command.operationId), undefined);
    assert.equal(writer.prepare("SELECT revision FROM provisioning_authorities").get()?.revision, 0);
    writer.exec(`DROP TRIGGER reject_owner;
      CREATE TRIGGER reject_revision BEFORE UPDATE ON provisioning_authorities
      BEGIN SELECT RAISE(ABORT, 'fixture revision failure'); END;`);
    assert.throws(() => store.enqueueOwned(command, context, owner), /fixture revision failure/);
    assert.equal(writer.prepare("SELECT count(*) AS total FROM provisioning_ownership").get()?.total, 0);
    writer.exec("DROP TRIGGER reject_revision; BEGIN IMMEDIATE");
    try { assert.throws(() => store.enqueueOwned(command, context, owner), /locked/); }
    finally { writer.exec("ROLLBACK"); }
    const intent = store.enqueueOwned(command, context, owner);
    assert.deepEqual(store.enqueueOwned(command, context, { ...owner }), intent);
    assert.throws(() => store.enqueue(command, context), /ownership conflict/);
    for (const changed of [
      { ...owner, subject: "bob" }, { ...owner, authorisationId: randomBytes(32).toString("base64url") },
      { ...owner, deviceId: randomUUID() }, { ...owner, sessionExpiresAt: owner.sessionExpiresAt + 1 },
    ]) assert.throws(() => store.enqueueOwned(command, context, changed), /ownership conflict/);
    assert.equal(store.ownership("customer-b", command.operationId), undefined);
    const detached = store.ownership(command.customer, command.operationId)!;
    detached.subject = "changed";
    assert.deepEqual(store.ownership(command.customer, command.operationId), owner);
    const reopened = openAgentProvisioningStore(path, { now: () => 200000 });
    try {
      assert.deepEqual(reopened.ownership(command.customer, command.operationId), owner);
      assert.deepEqual(reopened.enqueueOwned(command, context, owner), intent, "Expired exact retry only reads original evidence");
    } finally { reopened.close(); }
    worker.accept(intent.command, intent.context);
    assert.ok(!JSON.stringify(worker.operation(command.operationId)).includes(owner.authorisationId));
    assert.ok(!JSON.stringify(worker.report(command.operationId)).includes(owner.authorisationId));
    const workerDb = new DatabaseSync(workerPath, { readOnly: true });
    try { assert.equal(workerDb.prepare("SELECT count(*) AS total FROM provisioning_ownership").get()?.total, 0); }
    finally { workerDb.close(); }
    assert.ok(!(await readFile(workerPath)).includes(Buffer.from(owner.authorisationId)));
    writer.prepare("UPDATE provisioning_ownership SET ownership = ?").run(JSON.stringify({ ...owner, generationId: randomUUID() }));
    assert.throws(() => store.ownership(command.customer, command.operationId), /ownership/);
  } finally { worker.close(); writer.close(); store.close(); await rm(directory, { recursive: true }); }
});

test("ownership rejects secret fields, malformed or mismatched scope and cannot be attached to legacy intents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-owner-invalid-"));
  const path = join(directory, "backend.sqlite");
  const store = openAgentProvisioningStore(path, { now: () => 100000 });
  const { command, owner, context } = fixture();
  try {
    store.enrol(command.customer, command.epoch);
    for (const invalid of [
      { ...owner, sessionId: "browser-cookie" }, { ...owner, token: "bearer-secret" },
      { ...owner, authorisationId: "bad" }, { ...owner, issuer: "bad" }, { ...owner, subject: "" },
      { ...owner, customer: "customer-b" }, { ...owner, deviceId: "bad" },
      { ...owner, sessionExpiresAt: command.notAfter - 1 }, { ...owner, sessionExpiresAt: NaN },
      { ...owner, generationId: randomUUID() }, { ...owner, extension: "1002" },
    ]) assert.throws(() => store.enqueueOwned(command, context, invalid));
    assert.equal(store.operation(command.customer, command.operationId), undefined);
    store.enqueue(command, context);
    assert.equal(store.ownership(command.customer, command.operationId), undefined);
    assert.throws(() => store.enqueueOwned(command, context, owner), /ownership conflict/);
    let revision = 2;
    for (const action of ["activate", "extend"] as const) {
      const next = { ...command, operationId: randomUUID(), revision: revision++, action, payload: { generationId: owner.generationId } };
      store.enqueueOwned(next, context, owner);
      assert.deepEqual(store.ownership(command.customer, next.operationId), owner);
    }
    for (const action of ["drain", "revoke"] as const) {
      assert.throws(() => store.enqueueOwned({ ...command, action, payload: { generationId: owner.generationId } }, context, owner), /ownership/);
    }
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test("version-one backend and pinned worker upgrade without inventing ownership or changing historical hashes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-owner-upgrade-"));
  const { command, context } = fixture();
  try {
    for (const role of ["backend", "worker"]) {
      const path = join(directory, `${role}.sqlite`);
      const binding = { customer: command.customer, epoch: command.epoch };
      const initial = role === "backend" ? openAgentProvisioningStore(path, { now: () => 100000 }) : undefined;
      const journal = role === "worker" ? openAgentProvisioningJournal(path, binding, { now: () => 100000 }) : undefined;
      initial?.enrol(command.customer, command.epoch);
      const intent = initial ? initial.enqueue(command, context) : journal!.accept(command, context);
      initial?.close(); journal?.close();
      const downgrade = new DatabaseSync(path);
      try { downgrade.exec("DROP TABLE provisioning_ownership; PRAGMA user_version = 1"); }
      finally { downgrade.close(); }
      if (role === "backend") {
        const upgraded = openAgentProvisioningStore(path);
        try {
          assert.deepEqual(upgraded.operation(command.customer, command.operationId)?.intent, intent);
          assert.equal(upgraded.ownership(command.customer, command.operationId), undefined);
        } finally { upgraded.close(); }
      } else {
        assert.throws(() => openAgentProvisioningStore(path), /Worker journal/);
        assert.throws(() => openAgentProvisioningJournal(path, { ...binding, epoch: randomUUID() }), /binding mismatch/);
        const unchanged = new DatabaseSync(path, { readOnly: true });
        try {
          assert.equal(unchanged.prepare("PRAGMA user_version").get()?.user_version, 1);
          assert.equal(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'provisioning_ownership'").get(), undefined);
        } finally { unchanged.close(); }
        const upgraded = openAgentProvisioningJournal(path, binding);
        try { assert.deepEqual(upgraded.operation(command.operationId)?.intent, intent); }
        finally { upgraded.close(); }
      }
      const reader = new DatabaseSync(path, { readOnly: true });
      try { assert.equal(reader.prepare("PRAGMA user_version").get()?.user_version, 2); }
      finally { reader.close(); }
    }
  } finally { await rm(directory, { recursive: true }); }
});
