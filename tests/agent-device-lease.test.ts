import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentDeviceLeaseError, openAgentDeviceLeaseStore } from "../src/agent-device-lease.ts";

const alice = { issuer: "https://identity.example", subject: "alice", customer: "customer-a",
  sessionId: "a".repeat(43), sessionExpiresAt: 900000, deviceId: randomUUID() };
function rejects(code: AgentDeviceLeaseError["code"]) {
  return (error: unknown) => error instanceof AgentDeviceLeaseError && error.code === code;
}

test("exclusive leases persist, bind every owner dimension and reject stale holders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-lease-"));
  const path = join(directory, "leases.sqlite");
  let time = 100000;
  const store = openAgentDeviceLeaseStore(path, { now: () => time });
  const peer = openAgentDeviceLeaseStore(path, { now: () => time });
  try {
    const first = store.acquire(alice);
    assert.deepEqual(Object.keys(first).sort(), ["expiresAt", "id"]);
    assert.equal(first.expiresAt, 160000);
    assert.deepEqual(peer.acquire(alice), first);
    time += 10000;
    assert.deepEqual(store.acquire(alice), first, "Acquire retry must not silently renew");
    const contenders = [
      { ...alice, deviceId: randomUUID() },
      { ...alice, sessionId: "b".repeat(43) },
    ];
    for (const contender of contenders) {
      assert.throws(() => peer.acquire(contender), rejects("device_lease_conflict"));
    }
    for (const foreign of [...contenders,
      { ...alice, issuer: "https://other.example" }, { ...alice, subject: "bob" },
      { ...alice, customer: "customer-b" }]) {
      assert.throws(() => peer.renew(foreign, first.id), rejects("device_lease_not_owned"));
      assert.throws(() => peer.release(foreign, first.id), rejects("device_lease_not_owned"));
    }
    const renewed = peer.renew(alice, first.id);
    assert.equal(renewed.id, first.id);
    assert.equal(renewed.expiresAt, 170000);
    time = renewed.expiresAt;
    assert.throws(() => store.renew(alice, first.id), rejects("device_lease_not_owned"));
    assert.throws(() => store.release(alice, first.id), rejects("device_lease_not_owned"));
    const replacement = peer.acquire(contenders[0]);
    assert.notEqual(replacement.id, first.id);
    assert.throws(() => store.release(alice, first.id), rejects("device_lease_not_owned"));
    assert.throws(() => store.renew(alice, first.id), rejects("device_lease_not_owned"));
    peer.release(contenders[0], replacement.id);
    assert.throws(() => peer.release(contenders[0], replacement.id), rejects("device_lease_not_owned"));
    assert.notEqual(store.acquire(alice).id, first.id);
    for (const owner of [
      { ...alice, issuer: "https://other.example" }, { ...alice, subject: "bob" },
      { ...alice, customer: "customer-b" },
    ]) assert.ok(peer.acquire(owner).id, "Independent identities must not contend");
    const reopened = openAgentDeviceLeaseStore(path, { now: () => time });
    try { assert.throws(() => reopened.acquire(contenders[0]), rejects("device_lease_conflict")); }
    finally { reopened.close(); }
    const reader = new DatabaseSync(path);
    try {
      const json = JSON.stringify(reader.prepare("SELECT * FROM agent_device_leases").all());
      assert.ok(!json.includes(alice.sessionId), "Do not persist raw application session IDs");
      reader.exec("BEGIN IMMEDIATE");
      try { assert.throws(() => peer.acquire(alice), /locked/); }
      finally { reader.exec("ROLLBACK"); }
      assert.ok(peer.acquire(alice).id, "Lock failures must not leave a transaction open");
      reader.exec("CREATE TRIGGER reject_lease_update BEFORE UPDATE ON agent_device_leases BEGIN SELECT RAISE(ABORT, 'fixture rejection'); END");
      const current = store.acquire(alice);
      time++;
      assert.throws(() => store.renew(alice, current.id), /fixture rejection/);
      assert.deepEqual(peer.acquire(alice), current, "Failed renewal must roll back");
    } finally { reader.close(); }
  } finally { peer.close(); store.close(); await rm(directory, { recursive: true }); }
});

test("leases are capped by verified session expiry and reject invalid owners and stored state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-validation-"));
  const path = join(directory, "leases.sqlite");
  let time = 100000;
  const store = openAgentDeviceLeaseStore(path, { now: () => time });
  try {
    const owner = { ...alice, sessionExpiresAt: 100050 };
    store.acquire(alice);
    const lease = store.acquire(owner);
    assert.equal(lease.expiresAt, 100050, "A shortened verified session must cap an existing lease too");
    time++;
    assert.equal(store.renew(owner, lease.id).expiresAt, 100050);
    time = 100050;
    for (const action of [() => store.acquire(owner), () => store.renew(owner, lease.id),
      () => store.release(owner, lease.id)]) {
      assert.throws(action, rejects("device_session_expired"));
    }
    assert.notEqual(store.acquire(alice).id, lease.id);
    for (const invalid of [
      { ...alice, issuer: "file:///private" }, { ...alice, subject: "" },
      { ...alice, customer: "../foreign" }, { ...alice, deviceId: "" },
      { ...alice, sessionId: "" }, { ...alice, sessionExpiresAt: NaN },
    ]) assert.throws(() => store.acquire(invalid), /Invalid/);
    assert.throws(() => store.renew(alice, "invalid"), /Invalid device lease ID/);
    assert.throws(() => store.release(alice, "invalid"), /Invalid device lease ID/);
    time = NaN;
    assert.throws(() => store.acquire(alice), /Invalid device lease clock/);
    time = 100100;
    const writer = new DatabaseSync(path);
    try { writer.exec("UPDATE agent_device_leases SET expires_at = -1"); }
    finally { writer.close(); }
    assert.throws(() => store.acquire(alice), /Invalid stored device lease/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test("device lease store refuses relative paths, unrelated schemas and corrupt databases", async () => {
  assert.throws(() => openAgentDeviceLeaseStore("relative.sqlite"), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-schema-"));
  try {
    for (const [name, sql] of [
      ["foreign", "CREATE TABLE other (id TEXT)"],
      ["version", "PRAGMA user_version = 99"],
      ["missing", "PRAGMA user_version = 1"],
    ]) {
      const path = join(directory, `${name}.sqlite`);
      const db = new DatabaseSync(path);
      try { db.exec(sql); } finally { db.close(); }
      assert.throws(() => openAgentDeviceLeaseStore(path), /nonempty|Unsupported|no such table/);
    }
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, "not SQLite");
    assert.throws(() => openAgentDeviceLeaseStore(corrupt), /not a database/);
  } finally { await rm(directory, { recursive: true }); }
});

test("closing every connection and reopening retains only an unexpired reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-restart-"));
  const path = join(directory, "leases.sqlite");
  let time = 100000;
  try {
    const first = openAgentDeviceLeaseStore(path, { now: () => time });
    let original;
    try { original = first.acquire(alice); } finally { first.close(); }
    const reopened = openAgentDeviceLeaseStore(path, { now: () => time });
    try {
      assert.deepEqual(reopened.acquire(alice), original);
      assert.throws(() => reopened.acquire({ ...alice, deviceId: randomUUID() }), rejects("device_lease_conflict"));
      time = original.expiresAt;
      const next = reopened.acquire({ ...alice, deviceId: randomUUID() });
      assert.notEqual(next.id, original.id);
    } finally { reopened.close(); }
  } finally { await rm(directory, { recursive: true }); }
});

test("simultaneous backend processes grant exactly one competing device lease", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-race-"));
  const path = join(directory, "leases.sqlite");
  const execute = promisify(execFile);
  try {
    openAgentDeviceLeaseStore(path).close();
    const moduleUrl = new URL("../src/agent-device-lease.ts", import.meta.url).href;
    const outcomes = await Promise.all(Array.from({ length: 6 }, async () => {
      const owner = { ...alice, deviceId: randomUUID() };
      const script = `
        import { openAgentDeviceLeaseStore, AgentDeviceLeaseError } from ${JSON.stringify(moduleUrl)};
        const store = openAgentDeviceLeaseStore(${JSON.stringify(path)}, { now: () => 100000 });
        try {
          const lease = store.acquire(${JSON.stringify(owner)});
          console.log(JSON.stringify({ acquired: lease.id }));
        } catch (error) {
          if (!(error instanceof AgentDeviceLeaseError) || error.code !== "device_lease_conflict") throw error;
          console.log(JSON.stringify({ conflict: true }));
        } finally { store.close(); }
      `;
      return JSON.parse((await execute(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10000 })).stdout);
    }));
    assert.equal(outcomes.filter((outcome) => outcome.acquired).length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.conflict === true).length, 5);
  } finally { await rm(directory, { recursive: true }); }
});
