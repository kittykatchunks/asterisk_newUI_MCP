import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openBookingSimulation, BookingSimulationOwnershipError } from "../src/booking-simulation.ts";

const alice = { issuer: "https://identity.example", subject: "alice", customer: "customer-a" };
const details = { pickup: "customer-a-station", destination: "customer-a-hotel",
  passenger: "Synthetic Alice", contact: "test-contact-alice", passengers: 2 };
async function fixture(action: (path: string) => void) {
  const directory = await mkdtemp(join(tmpdir(), "simulation-ownership-"));
  try { action(join(directory, "simulation.sqlite")); }
  finally { await rm(directory, { recursive: true }); }
}

test("SW-03: durable owner scope denies guessed operations and legacy conversations across every action", async () => {
  await fixture((path) => {
    let store = openBookingSimulation(path);
    try {
      const legacy = store.create("customer-a", "synthetic-legacy", details);
      const mutableOwner = { ...alice };
      const workspace = store.forOwner(mutableOwner);
      mutableOwner.subject = "someone-else";
      const conversation = workspace.createConversation();
      assert.match(conversation.conversation, /^synthetic-[0-9a-f-]{36}$/);
      const draft = workspace.create(conversation.conversation, details);
      workspace.review(draft.id, 1);
      workspace.confirm(draft.id, draft.revision);
      workspace.submit(draft.id, "lose-reply", 1);
      assert.equal(workspace.list().length, 1);
      assert.equal(workspace.list()[0].operations[0].state, "outcome unknown");
      for (const identity of [
        { ...alice, subject: "other-agent" }, { ...alice, customer: "customer-b" },
        { ...alice, issuer: "https://other-identity.example" },
      ]) {
        const other = store.forOwner(identity);
        assert.deepEqual(other.list(), []);
        for (const id of [draft.id, legacy.id]) {
          for (const action of [
            () => other.read(id), () => other.edit(id, details, 1), () => other.review(id, 1),
            () => other.confirm(id, 1), () => other.submit(id, "accept", 1),
            () => other.reconcile(id), () => other.handover(id, "human_requested"),
          ]) assert.throws(action, BookingSimulationOwnershipError);
        }
        assert.throws(() => other.create(conversation.conversation, details), BookingSimulationOwnershipError);
      }
      assert.throws(() => workspace.read(legacy.id), BookingSimulationOwnershipError);
      assert.throws(() => workspace.create("synthetic-legacy", details), BookingSimulationOwnershipError);
      store.close();
      store = openBookingSimulation(path);
      const resumed = store.forOwner(alice);
      assert.equal(resumed.list()[0].operations[0].id, draft.id);
      assert.equal(resumed.reconcile(draft.id).state, "accepted");
      const list = resumed.list();
      list[0].operations.length = 0;
      assert.equal(resumed.list()[0].operations.length, 1, "Recovery results must be detached");
      assert.equal(store.read("customer-a", legacy.id).state, "collecting");
      assert.throws(() => store.forOwner({ ...alice, subject: "" }));
      assert.throws(() => store.forOwner({ ...alice, customer: "foreign" }));
    } finally { store.close(); }
  });
});

test("SW-03: schema-1 migration preserves unowned harness records without inventing ownership", async () => {
  await fixture((path) => {
    const store = openBookingSimulation(path);
    const legacy = store.create("customer-a", "synthetic-legacy", details);
    store.close();
    const old = new DatabaseSync(path);
    old.exec("DROP TABLE simulated_conversations; PRAGMA user_version = 1;");
    old.close();
    const migrated = openBookingSimulation(path);
    try {
      assert.deepEqual(migrated.forOwner(alice).list(), []);
      assert.deepEqual(migrated.read("customer-a", legacy.id), legacy);
      assert.throws(() => migrated.forOwner(alice).read(legacy.id), BookingSimulationOwnershipError);
      const reader = new DatabaseSync(path, { readOnly: true });
      try { assert.equal(reader.prepare("PRAGMA user_version").get()?.user_version, 2); }
      finally { reader.close(); }
    } finally { migrated.close(); }
    const corrupt = new DatabaseSync(path);
    corrupt.prepare("INSERT INTO simulated_conversations VALUES (?, ?, ?, ?)")
      .run("synthetic-invalid", alice.customer, alice.issuer, alice.subject);
    corrupt.close();
    assert.throws(() => openBookingSimulation(path), /Corrupt simulation conversation/);
  });
});
