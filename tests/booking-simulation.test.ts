import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { openBookingSimulation } from "../src/booking-simulation.ts";

const details = (customer = "customer-a") => ({
  pickup: `${customer}-station`, destination: `${customer}-hotel`,
  passenger: "Synthetic Alice", contact: "test-contact-alice", passengers: 2,
});
type Store = ReturnType<typeof openBookingSimulation>;
function confirmed(store: Store, conversation = "synthetic-call", customer = "customer-a") {
  const draft = store.create(customer, conversation, details(customer));
  store.review(customer, draft.id);
  return store.confirm(customer, draft.id, draft.revision);
}
async function fixture(action: (path: string) => void | Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "booking-simulation-"));
  try { await action(join(directory, "simulation.sqlite")); }
  finally { await rm(directory, { recursive: true }); }
}
function effects(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return db.prepare("SELECT count(*) AS count FROM simulated_dispatch").get()?.count; }
  finally { db.close(); }
}

test("BS-01/02: synthetic inputs and revision-bound confirmation prevent unapproved dispatch", async () => {
  await fixture((path) => {
    const store = openBookingSimulation(path);
    try {
      for (const input of [null, {}, { ...details(), pickup: "customer-b-station" },
        { ...details(), destination: "customer-a-station" }, { ...details(), passengers: 0 },
        { ...details(), passengers: 9 }, { ...details(), passengers: 1.5 },
        { ...details(), passenger: "Real person" }, { ...details(), contact: "+44123456789" },
        { ...details(), advanceTime: "tomorrow" }]) {
        assert.throws(() => store.create("customer-a", "synthetic-call", input));
      }
      assert.throws(() => store.create("foreign", "synthetic-call", details()));
      assert.throws(() => store.create("customer-a", "real-call", details()));
      for (const count of [1, 8]) {
        assert.equal(store.create("customer-a", `synthetic-boundary-${count}`, { ...details(), passengers: count }).details.passengers, count);
      }
      const draft = store.create("customer-a", "synthetic-call", details());
      assert.equal(draft.state, "collecting");
      assert.throws(() => store.submit("customer-a", draft.id, "accept"));
      assert.throws(() => store.confirm("customer-a", draft.id, 1));
      assert.match(store.review("customer-a", draft.id).summary, /^SIMULATION: book now/);
      assert.throws(() => store.submit("customer-a", draft.id, "accept"));
      store.confirm("customer-a", draft.id, 1);
      const changed = store.edit("customer-a", draft.id, { ...details(), passengers: 3 });
      assert.equal(changed.confirmedRevision, null);
      store.review("customer-a", draft.id);
      assert.throws(() => store.confirm("customer-a", draft.id, 1));
      assert.throws(() => store.submit("customer-a", draft.id, "accept"));
      assert.equal(effects(path), 0);
      store.confirm("customer-a", draft.id, 2);
      assert.equal(store.submit("customer-a", draft.id, "accept").state, "accepted");
      assert.throws(() => store.edit("customer-a", draft.id, details()), /immutable/);
    } finally { store.close(); }
  });
});

test("BS-03/04/07/08: truthful outcomes, immutable replay and scope remain independently correlated", async () => {
  await fixture((path) => {
    const store = openBookingSimulation(path);
    try {
      const first = confirmed(store);
      const accepted = store.submit("customer-a", first.id, "accept");
      assert.equal(accepted.simulation, true);
      assert.equal(accepted.reference, `SIM-${first.id}`);
      assert.equal(accepted.reason, "simulated_acceptance");
      assert.equal("eta" in accepted, false);
      assert.equal("fare" in accepted, false);
      assert.equal("allocated" in accepted, false);
      assert.deepEqual(store.submit("customer-a", first.id, "reject"), accepted);
      accepted.details.passengers = 8;
      assert.equal(store.read("customer-a", first.id).details.passengers, 2);
      const second = confirmed(store);
      const rejected = store.submit("customer-a", second.id, "reject");
      assert.equal(rejected.state, "rejected");
      assert.equal(rejected.reference, null);
      assert.equal(rejected.reason, "simulated_rejection");
      assert.equal(store.handover("customer-a", second.id, "human_requested").state, "rejected");
      assert.equal(store.handover("customer-a", second.id, "unsupported_request").handoverReason, "unsupported_request");
      assert.notEqual(first.id, second.id);
      const foreign = confirmed(store, "synthetic-call", "customer-b");
      assert.equal(store.submit("customer-b", foreign.id, "accept").customer, "customer-b");
      for (const action of [
        () => store.read("customer-b", first.id),
        () => store.edit("customer-b", first.id, details("customer-b")),
        () => store.review("customer-b", first.id),
        () => store.confirm("customer-b", first.id, 1),
        () => store.submit("customer-b", first.id, "accept"),
        () => store.reconcile("customer-b", first.id),
        () => store.handover("customer-b", first.id, "human_requested"),
      ]) assert.throws(action, /customer scope/);
      assert.equal(effects(path), 3);
    } finally { store.close(); }
  });
});

test("BS-05/06: lost replies reconcile without resubmission; absence remains unknown after disconnect", async () => {
  await fixture((path) => {
    const store = openBookingSimulation(path);
    try {
      const lost = confirmed(store);
      const earlierDraft = confirmed(store);
      const unknown = store.submit("customer-a", lost.id, "lose-reply");
      assert.equal(unknown.state, "outcome unknown");
      assert.equal(unknown.reference, null);
      assert.throws(() => store.create("customer-a", "synthetic-call", details()), /Reconcile/);
      assert.throws(() => store.submit("customer-a", earlierDraft.id, "accept"), /Reconcile/);
      assert.deepEqual(store.submit("customer-a", lost.id, "accept"), unknown);
      assert.equal(store.handover("customer-a", lost.id, "caller_disconnected").state, "outcome unknown");
      const recovered = store.reconcile("customer-a", lost.id);
      assert.equal(recovered.state, "accepted");
      assert.equal(recovered.reference, `SIM-${lost.id}`);
      assert.equal(effects(path), 1);
      const unresolved = confirmed(store, "synthetic-unresolved");
      store.submit("customer-a", unresolved.id, "unresolved");
      assert.equal(store.reconcile("customer-a", unresolved.id).state, "outcome unknown");
      const db = new DatabaseSync(path);
      try { db.prepare("DELETE FROM simulated_dispatch WHERE id = ?").run(unresolved.id); }
      finally { db.close(); }
      assert.equal(store.reconcile("customer-a", unresolved.id).state, "outcome unknown");
      const handover = store.handover("customer-a", unresolved.id, "caller_disconnected");
      assert.equal(handover.reference, null);
      assert.equal(handover.state, "outcome unknown");
      assert.equal(handover.confirmedRevision, 1);
      assert.throws(() => store.create("customer-a", "synthetic-unresolved", details()), /Reconcile/);
    } finally { store.close(); }
  });
});

test("BS-07/09: committed submission and simulator effect survive crash boundary and competing access", async () => {
  await fixture((path) => {
    let other: Store;
    const store = openBookingSimulation(path, { afterEffect() {
      assert.throws(() => other.submit("customer-a", id, "accept"), /reconcile/);
      throw new Error("Injected crash after durable simulator effect");
    } });
    other = openBookingSimulation(path);
    const { id } = confirmed(store);
    try {
      assert.throws(() => store.submit("customer-a", id, "accept"), /Injected crash/);
      assert.equal(other.read("customer-a", id).state, "submitting");
      assert.equal(effects(path), 1);
    } finally { other.close(); store.close(); }
    const reopened = openBookingSimulation(path);
    try {
      assert.equal(reopened.read("customer-a", id).state, "submitting");
      assert.throws(() => reopened.submit("customer-a", id, "accept"), /reconcile/);
      const result = reopened.reconcile("customer-a", id);
      assert.equal(result.state, "accepted");
      assert.deepEqual(result.history.map((entry) => entry.state),
        ["collecting", "awaiting confirmation", "awaiting confirmation", "submitting", "accepted"]);
      assert.equal(effects(path), 1);
    } finally { reopened.close(); }
  });
});

test("BS-07: simultaneous processes cannot duplicate the simulated dispatch effect", async () => {
  await fixture(async (path) => {
    const store = openBookingSimulation(path);
    const { id } = confirmed(store);
    store.close();
    const moduleUrl = new URL("../src/booking-simulation.ts", import.meta.url).href;
    const script = `import { openBookingSimulation } from ${JSON.stringify(moduleUrl)};
      const s = openBookingSimulation(process.argv[1]);
      try { console.log(s.submit('customer-a', process.argv[2], 'accept').state); }
      catch(e) { if (!/reconcile|locked/.test(e.message)) throw e; console.log('conflict'); }
      finally { s.close(); }`;
    const run = promisify(execFile);
    const results = await Promise.all([1, 2].map(() =>
      run(process.execPath, ["--input-type=module", "-e", script, path, id], { timeout: 10000 })));
    assert.ok(results.some((result) => result.stdout.trim() === "accepted"));
    assert.equal(effects(path), 1);
    const reopened = openBookingSimulation(path);
    try { assert.equal(reopened.reconcile("customer-a", id).state, "accepted"); }
    finally { reopened.close(); }
  });
});

test("BS-09: unrelated, invalid and corrupted stores and dispatch payload conflicts fail explicitly", async () => {
  assert.throws(() => openBookingSimulation("relative.sqlite"), /absolute/);
  await fixture(async (path) => {
    await writeFile(path, "not SQLite");
    assert.throws(() => openBookingSimulation(path));
  });
  await fixture((path) => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated (value TEXT)");
    db.close();
    assert.throws(() => openBookingSimulation(path), /nonempty/);
  });
  await fixture((path) => {
    const store = openBookingSimulation(path);
    const { id } = confirmed(store);
    store.submit("customer-a", id, "lose-reply");
    const db = new DatabaseSync(path);
    try {
      db.prepare("UPDATE simulated_dispatch SET payload = '{}' WHERE id = ?").run(id);
      assert.throws(() => store.reconcile("customer-a", id), /Conflicting or corrupt/);
      assert.throws(() => store.read("customer-a", id), /Conflicting or corrupt/);
      db.prepare("UPDATE simulated_bookings SET record = '{}' WHERE id = ?").run(id);
      assert.throws(() => store.read("customer-a", id), /Corrupt/);
    } finally { db.close(); store.close(); }
    assert.throws(() => openBookingSimulation(path), /Corrupt/);
  });

});

test("BS-09: unexpected dispatch failure persists submitting and explicit reconciliation does not recreate", async () => {
  await fixture((path) => {
    const store = openBookingSimulation(path);
    const { id } = confirmed(store);
    const db = new DatabaseSync(path);
    try {
      db.exec(`CREATE TRIGGER fail_dispatch BEFORE INSERT ON simulated_dispatch
          BEGIN SELECT RAISE(ABORT, 'Injected dispatch storage failure'); END;`);
      assert.throws(() => store.submit("customer-a", id, "accept"), /Injected dispatch storage failure/);
      assert.equal(store.read("customer-a", id).state, "submitting");
      assert.equal(effects(path), 0);
      assert.equal(store.reconcile("customer-a", id).state, "outcome unknown");
      assert.equal(effects(path), 0);
    } finally { db.close(); store.close(); }
  });
});

test("BS-09: process exit after effect commit retains one recoverable result", async () => {
  await fixture(async (path) => {
    const store = openBookingSimulation(path);
    const { id } = confirmed(store);
    store.close();
    const script = `import { openBookingSimulation } from ${JSON.stringify(new URL("../src/booking-simulation.ts", import.meta.url).href)};
        const s = openBookingSimulation(process.argv[1], { afterEffect() { process.exit(17); } });
        s.submit('customer-a', process.argv[2], 'accept');`;
    const run = promisify(execFile);
    await assert.rejects(run(process.execPath, ["--input-type=module", "-e", script, path, id],
      { timeout: 10000 }), (error: unknown) => error instanceof Error && "code" in error && error.code === 17);
    const reopened = openBookingSimulation(path);
    try {
      assert.equal(reopened.read("customer-a", id).state, "submitting");
      assert.equal(reopened.reconcile("customer-a", id).state, "accepted");
      assert.equal(effects(path), 1);
    } finally { reopened.close(); }
  });
});
