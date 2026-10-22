import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { openAgentProvisioningStore, AgentProvisioningConflict } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand, ProvisioningReceipt } from "../src/agent-provisioning-store.ts";

const epoch = randomUUID();
const command = (revision = 1): AgentProvisioningCommand => ({
  version: 1, operationId: randomUUID(), customer: "customer-a", epoch, revision,
  leaseId: randomUUID(), notAfter: 160000, action: "prepare",
  payload: { generationId: randomUUID(), extension: "1001" },
});
const context = { requestId: randomUUID(), actor: "synthetic-verified-subject", reason: "Approved synthetic intent" };
const receipt = (sequence: number, stage: ProvisioningReceipt["stage"]): ProvisioningReceipt =>
  ({ receiptId: randomUUID(), sequence, stage, code: `fixture_${stage}` });

test("provisioning intents persist ordered commands and exact retries without widening customer or authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-provisioning-"));
  const path = join(directory, "provisioning.sqlite");
  let time = 100000;
  const store = openAgentProvisioningStore(path, { now: () => time });
  const peer = openAgentProvisioningStore(path, { now: () => time });
  try {
    const first = command();
    assert.throws(() => store.enqueue(first, context), AgentProvisioningConflict);
    store.enrol("customer-a", epoch);
    peer.enrol("customer-a", epoch);
    assert.throws(() => store.enrol("customer-a", randomUUID()), /epoch rotation/);
    const accepted = store.enqueue(first, context);
    assert.equal(accepted.acceptedAt, time);
    assert.match(accepted.sha256, /^[0-9a-f]{64}$/);
    first.payload.generationId = randomUUID();
    assert.notEqual(store.operation("customer-a", first.operationId)?.intent.command.payload.generationId, first.payload.generationId);
    const saved = accepted.command;
    assert.deepEqual(peer.enqueue(saved, { ...context, requestId: randomUUID(), reason: "Retry" }), accepted);
    assert.throws(() => peer.enqueue({ ...saved, notAfter: saved.notAfter + 1 }, context), /payload conflict/);
    assert.throws(() => peer.enqueue(command(1), context), /out of order/);
    assert.throws(() => peer.enqueue(command(3), context), /out of order/);
    assert.throws(() => peer.enqueue({ ...command(2), epoch: randomUUID() }, context), /authority/);
    assert.throws(() => peer.enqueue({ ...command(2), notAfter: time }, context), /expired/);
    const second = command(2);
    store.enqueue(second, context);
    assert.equal(peer.operation("customer-b", saved.operationId), undefined);
    assert.throws(() => peer.record("customer-b", saved.operationId, receipt(1, "applying")), /not found/);
    assert.deepEqual(peer.pending("customer-a", 1).map((intent) => intent.command.operationId), [saved.operationId]);
    assert.deepEqual(peer.pending("customer-b"), []);
    const stages = [receipt(1, "applying"), receipt(2, "uncertain"), receipt(3, "applying"), receipt(4, "verified")];
    assert.throws(() => peer.record("customer-a", saved.operationId, receipt(1, "verified")), /transition/);
    for (const entry of stages) store.record("customer-a", saved.operationId, entry);
    for (const entry of stages) peer.record("customer-a", saved.operationId, entry);
    assert.throws(() => peer.record("customer-a", saved.operationId, { ...stages[0], code: "changed" }), /receipt conflict/);
    assert.throws(() => peer.record("customer-a", saved.operationId, receipt(5, "applying")), /transition/);
    assert.deepEqual(peer.pending("customer-a").map((intent) => intent.command.operationId), [second.operationId]);
    peer.record("customer-a", second.operationId, receipt(1, "uncertain"));
    peer.record("customer-a", second.operationId, receipt(2, "failed"));
    assert.deepEqual(peer.pending("customer-a"), []);
    time = 200000;
    assert.deepEqual(peer.enqueue(saved, context), accepted, "Expired retry reconciles original intent; it does not reauthorise dispatch");
    const reopened = openAgentProvisioningStore(path, { now: () => time });
    try {
      assert.deepEqual(reopened.operation("customer-a", saved.operationId), { intent: accepted, receipts: stages });
      store.enrol("customer-b", randomUUID());
    } finally { reopened.close(); }
  } finally { peer.close(); store.close(); await rm(directory, { recursive: true }); }
});

test("intent, audit context and revision updates roll back together and survive lock failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-provisioning-atomic-"));
  const path = join(directory, "provisioning.sqlite");
  const store = openAgentProvisioningStore(path, { now: () => 100000 });
  const writer = new DatabaseSync(path);
  try {
    store.enrol("customer-a", epoch);
    const first = command();
    writer.exec(`CREATE TRIGGER reject_revision BEFORE UPDATE ON provisioning_authorities
      BEGIN SELECT RAISE(ABORT, 'fixture revision failure'); END;`);
    assert.throws(() => store.enqueue(first, context), /fixture revision failure/);
    assert.equal(store.operation("customer-a", first.operationId), undefined);
    assert.equal(writer.prepare("SELECT revision FROM provisioning_authorities").get()?.revision, 0);
    writer.exec("DROP TRIGGER reject_revision");
    writer.exec("BEGIN IMMEDIATE");
    try { assert.throws(() => store.enqueue(first, context), /locked/); }
    finally { writer.exec("ROLLBACK"); }
    store.enqueue(first, context);
    const event = receipt(1, "applying");
    writer.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON provisioning_receipts
      BEGIN SELECT RAISE(ABORT, 'fixture receipt failure'); END;`);
    assert.throws(() => store.record("customer-a", first.operationId, event), /fixture receipt failure/);
    assert.deepEqual(store.operation("customer-a", first.operationId)?.receipts, []);
    writer.exec("DROP TRIGGER reject_receipt");
    store.record("customer-a", first.operationId, event);
    assert.equal(store.pending("customer-a").length, 1, "Unconfirmed delivery remains reconcilable after reopen");
    const reopened = openAgentProvisioningStore(path, { now: () => 100000 });
    try { assert.deepEqual(reopened.operation("customer-a", first.operationId)?.receipts, [event]); }
    finally { reopened.close(); }
    writer.prepare("UPDATE provisioning_intents SET command = ? WHERE operation_id = ?")
      .run(JSON.stringify({ ...first, notAfter: 170000 }), first.operationId);
    assert.throws(() => store.operation("customer-a", first.operationId), /mismatch/);
    assert.throws(() => store.pending("customer-a"), /mismatch/);
  } finally { writer.close(); store.close(); await rm(directory, { recursive: true }); }
});

test("provisioning rejects secrets, unsafe envelopes, invalid receipts, foreign schemas and corrupt data", async () => {
  assert.throws(() => openAgentProvisioningStore("relative.sqlite"), /absolute/);
  const directory = await mkdtemp(join(tmpdir(), "asterisk-provisioning-invalid-"));
  const path = join(directory, "provisioning.sqlite");
  let time = 100000;
  const store = openAgentProvisioningStore(path, { now: () => time });
  try {
    store.enrol("customer-a", epoch);
    for (const value of [
      { ...command(), version: 2 }, { ...command(), operationId: "bad" }, { ...command(), customer: "../foreign" },
      { ...command(), revision: 0 }, { ...command(), revision: 1.5 }, { ...command(), notAfter: NaN },
      { ...command(), action: "Command" }, { ...command(), secret: "must-not-persist" },
      { ...command(), payload: { generationId: randomUUID(), extension: "sip:1001" } },
      { ...command(), payload: { generationId: randomUUID(), extension: "1001", password: "private" } },
      { ...command(), action: "extend", payload: { generationId: randomUUID(), extension: "1001" } },
    ]) assert.throws(() => store.enqueue(value as AgentProvisioningCommand, context), /Invalid/);
    assert.throws(() => store.enqueue(command(), { ...context, actor: "\n" }), /Invalid/);
    assert.throws(() => store.enqueue(command(), { ...context, reason: "x".repeat(2001) }), /Invalid/);
    time = NaN;
    assert.throws(() => store.enqueue(command(), context), /clock/);
    time = 100000;
    const first = command();
    store.enqueue(first, context);
    for (const value of [
      { ...receipt(1, "applying"), sequence: 0 }, { ...receipt(1, "applying"), code: "private\nmessage" },
      { ...receipt(1, "applying"), stage: "success" }, { ...receipt(1, "applying"), receiptId: "bad" },
    ]) assert.throws(() => store.record("customer-a", first.operationId, value as ProvisioningReceipt), /Invalid/);
    for (const limit of [0, 101, 1.5]) assert.throws(() => store.pending("customer-a", limit), /limit/);
    const event = receipt(1, "applying");
    store.record("customer-a", first.operationId, event);
    const writer = new DatabaseSync(path);
    try { writer.exec("UPDATE provisioning_receipts SET sequence = 2"); } finally { writer.close(); }
    assert.throws(() => store.operation("customer-a", first.operationId), /mismatch/);
    for (const [name, sql] of [
      ["foreign", "CREATE TABLE other (id TEXT)"], ["version", "PRAGMA user_version = 99"],
      ["missing", "PRAGMA user_version = 1"],
    ]) {
      const foreign = join(directory, `${name}.sqlite`);
      const db = new DatabaseSync(foreign);
      try { db.exec(sql); } finally { db.close(); }
      assert.throws(() => openAgentProvisioningStore(foreign), /nonempty|Unsupported|no such table/);
    }
    const corrupt = join(directory, "corrupt.sqlite");
    await writeFile(corrupt, "not SQLite");
    assert.throws(() => openAgentProvisioningStore(corrupt), /not a database/);
  } finally { store.close(); await rm(directory, { recursive: true }); }
});

test("all fixed actions round-trip and competing processes cannot allocate the same customer revision twice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-provisioning-race-"));
  const path = join(directory, "provisioning.sqlite");
  const store = openAgentProvisioningStore(path, { now: () => 100000 });
  try {
    store.enrol("customer-a", epoch);
    const execute = promisify(execFile);
    const module = new URL("../src/agent-provisioning-store.ts", import.meta.url).href;
    const outcomes = await Promise.all(Array.from({ length: 4 }, async () => {
      const input = command();
      const script = `
        import { openAgentProvisioningStore, AgentProvisioningConflict } from ${JSON.stringify(module)};
        const store = openAgentProvisioningStore(${JSON.stringify(path)}, { now: () => 100000 });
        try { store.enqueue(${JSON.stringify(input)}, ${JSON.stringify(context)}); console.log("accepted"); }
        catch (error) { if (!(error instanceof AgentProvisioningConflict)) throw error; console.log("conflict"); }
        finally { store.close(); }
      `;
      return (await execute(process.execPath, ["--input-type=module", "--eval", script], { timeout: 10000 })).stdout.trim();
    }));
    assert.equal(outcomes.filter((value) => value === "accepted").length, 1);
    assert.equal(outcomes.filter((value) => value === "conflict").length, 3);
    let revision = 1;
    for (const action of ["activate", "extend", "drain", "revoke"] as const) {
      const input: AgentProvisioningCommand = {
        ...command(++revision), action, payload: { generationId: randomUUID() },
      };
      assert.deepEqual(store.enqueue(input, context).command, input);
      assert.deepEqual(store.operation("customer-a", input.operationId)?.intent.command, input);
    }
    assert.equal(store.pending("customer-a").length, 5);
    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT revision FROM provisioning_authorities WHERE customer = 'customer-a'").get()?.revision, 5);
      assert.equal(reader.prepare("SELECT count(*) AS total FROM provisioning_intents").get()?.total, 5);
    } finally { reader.close(); }
  } finally { store.close(); await rm(directory, { recursive: true }); }
});
