import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openDiagnosticStore } from "../src/diagnostic-store.ts";
import { approveSyntheticIncidents } from "./diagnostic-fixture.ts";
import { backupDiagnosticStore, restoreDiagnosticStore } from "../src/diagnostic-backup.ts";
import type { ApprovedIncident } from "../src/incidents.ts";
import type { AccessAudit } from "../src/diagnostic-api.ts";

const html = "<!doctype html><title>Approved report</title>";
function entry(customer = "customer-a", digit = "a"): ApprovedIncident {
  return {
    customer,
    summary: { id: "incident-" + digit.repeat(32), title: "Synthetic incident", createdAt: "2026-10-22T12:00:00Z" },
    report: { html, sha256: createHash("sha256").update(html).digest("hex") },
  };
}
function event(requestId = "request-a"): AccessAudit {
  return {
    requestId, timestamp: "2026-10-22T12:00:00Z", customer: "customer-a", subject: "alice",
    status: 200, outcome: "incident_report_viewed", operation: "report-view", basis: "membership",
    incident: entry().summary.id,
  };
}

async function fixture(run: (path: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-store-"));
  try { await run(join(directory, "diagnostics.sqlite")); }
  finally { await rm(directory, { recursive: true }); }
}

test("approved reports and allowlisted audit records survive database reopening", async () => {
  await fixture(async (path) => {
    let store = openDiagnosticStore(path);
    try {
      const approved = entry();
      approveSyntheticIncidents(store, [approved, entry("customer-b", "b")]);
      approved.report!.html = "later caller mutation";
      await store.audit({ ...event(), ...{ authorization: "must-not-persist", report: "must-not-persist" } });
      store.close();
      store = openDiagnosticStore(path);
      assert.deepEqual(await store.catalog.list("customer-a"), [entry().summary]);
      assert.equal(await store.catalog.report("customer-a", entry().summary.id), html);
      assert.equal(await store.catalog.report("customer-b", entry().summary.id), undefined);
      assert.deepEqual(await store.catalog.list("unknown-customer"), []);
      const reader = new DatabaseSync(path);
      try {
        const rows = reader.prepare("SELECT * FROM access_audit").all();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].request_id, "request-a");
        assert.equal(rows[0].incident, entry().summary.id);
        assert.ok(!JSON.stringify(rows).includes("must-not-persist"));
      } finally { reader.close(); }
    } finally { store.close(); }
  });
});

test("pending report summaries are allowlisted, customer-scoped and detached from stored snapshots", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    try {
      const original = entry();
      const staged = store.stage([
        { ...original, summary: { ...original.summary, ...{ privateNote: "not-list-metadata" } } },
        entry("customer-b", "b"),
      ]);
      const pending = store.pending("customer-a");
      assert.deepEqual(pending, [{ ...staged[0], summary: original.summary }]);
      assert.ok(!JSON.stringify(pending).includes("not-list-metadata"));
      pending[0].summary.title = "Changed by caller";
      assert.deepEqual(store.pending("customer-a")[0].summary, original.summary);
      assert.deepEqual(store.pending("unknown-customer"), []);
      assert.deepEqual(await store.catalog.list("customer-a"), []);
    } finally { store.close(); }
  });
});

test("staging batches are atomic, validated, insert-only and customer-keyed", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    try {
      approveSyntheticIncidents(store, [entry()]);
      assert.throws(() => store.stage([entry("customer-b", "b"), entry()]));
      assert.deepEqual(await store.catalog.list("customer-b"), []);
      assert.throws(() => store.stage([{ ...entry("customer-b"), report: { html: "tampered", sha256: entry().report!.sha256 } }]), /integrity/);
      assert.throws(() => store.stage([{ ...entry(), customer: "../customer" }]), /Invalid/);
      assert.throws(() => store.stage([{ ...entry(), report: { html: "x".repeat(2 * 1024 * 1024 + 1), sha256: "0".repeat(64) } }]), /integrity/);
      approveSyntheticIncidents(store, [entry("customer-b")]);
      assert.equal((await store.catalog.list("customer-b")).length, 1);
      assert.equal(await store.catalog.report("customer-a", entry().summary.id), html);
    } finally { store.close(); }
  });
});

test("review history survives reopening, is scoped and bounded, and supports exact older outcome lookup", async () => {
  await fixture(async (path) => {
    let store = openDiagnosticStore(path);
    const writer = new DatabaseSync(path);
    try {
      const entries = Array.from({ length: 52 }, (_, index) => ({
        ...entry(), summary: { ...entry().summary, id: "incident-" + index.toString(16).padStart(32, "0") },
      }));
      const staged = store.stage([...entries, entry("customer-b", "b"), entry("customer-a", "f")]);
      for (const [index, candidate] of staged.slice(0, 53).entries()) {
        store.review(candidate.id, { decision: index % 2 ? "reject" : "approve",
          reviewer: "reviewer", reason: "<script>literal reason</script>", sha256: candidate.sha256 });
        writer.prepare("UPDATE incident_reviews SET decided_at = ? WHERE candidate = ?").run(
          index === 0 ? "2026-10-21T12:00:00Z" : "2026-10-22T12:00:00Z", candidate.id);
      }
      store.close();
      store = openDiagnosticStore(path);
      const history = store.history("customer-a");
      assert.equal(history.reviews.length, 50);
      assert.equal(history.truncated, true);
      const expectedIds = staged.slice(1, 52).map((candidate) => candidate.id).sort().slice(0, 50);
      assert.deepEqual(history.reviews.map((review) => review.id), expectedIds);
      const exact = store.history("customer-a", staged[0].id);
      assert.equal(exact.truncated, false);
      assert.deepEqual(exact.reviews, [{
        ...staged[0], decision: "approve", reviewer: "reviewer", reason: "<script>literal reason</script>",
        decidedAt: "2026-10-21T12:00:00Z", summary: entries[0].summary,
      }]);
      exact.reviews[0].summary.title = "caller mutation";
      assert.equal(store.history("customer-a", staged[0].id).reviews[0].summary.title, entries[0].summary.title);
      assert.equal(store.history("customer-b").reviews.length, 1);
      for (const id of [staged[52].id, staged[53].id, "00000000-0000-0000-0000-000000000000"]) {
        assert.deepEqual(store.history("customer-a", id), { reviews: [], truncated: false });
      }
      assert.deepEqual(store.history("unknown-customer"), { reviews: [], truncated: false });
      assert.ok(!JSON.stringify(history).includes(html));
      assert.deepEqual(Object.keys(history.reviews[0]).sort(),
        ["id", "sha256", "decision", "reviewer", "reason", "decidedAt", "summary"].sort());
    } finally { writer.close(); store.close(); }
  });
});

test("review history fails explicitly on stored snapshot or receipt corruption", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    const writer = new DatabaseSync(path);
    try {
      const [candidate] = store.stage([entry()]);
      store.review(candidate.id, { decision: "reject", reviewer: "reviewer", reason: "Reviewed", sha256: candidate.sha256 });
      const original = writer.prepare("SELECT entry FROM report_candidates WHERE id = ?").get(candidate.id)?.entry;
      assert.ok(typeof original === "string");
      writer.prepare("UPDATE report_candidates SET entry = ? WHERE id = ?").run(
        JSON.stringify({ ...entry(), summary: { ...entry().summary, title: "Unreviewed mutation" } }), candidate.id);
      assert.throws(() => store.history("customer-a"), /integrity/);
      assert.throws(() => store.history("customer-a", candidate.id), /integrity/);
      writer.prepare("UPDATE report_candidates SET entry = ? WHERE id = ?").run(original, candidate.id);
      for (const [column, value, restore] of [
        ["sha256", "0".repeat(64), candidate.sha256], ["reason", " ", "Reviewed"],
        ["reviewer", "", "reviewer"], ["decided_at", "invalid", new Date().toISOString()],
      ]) {
        writer.prepare(`UPDATE incident_reviews SET ${column} = ? WHERE candidate = ?`).run(value, candidate.id);
        assert.throws(() => store.history("customer-a"), /integrity/);
        writer.prepare(`UPDATE incident_reviews SET ${column} = ? WHERE candidate = ?`).run(restore, candidate.id);
      }
    } finally { writer.close(); store.close(); }
  });
});

test("stored report tampering, malformed entries and customer mismatches fail closed", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    const writer = new DatabaseSync(path);
    try {
      approveSyntheticIncidents(store, [entry()]);
      for (const altered of [
        { ...entry(), report: { html: "tampered", sha256: entry().report!.sha256 } },
        { ...entry(), customer: "customer-b" },
        { ...entry(), summary: { ...entry().summary, title: "Unreviewed title change" } },
        { ...entry(), summary: null },
        null,
      ]) {
        writer.prepare("UPDATE incidents SET entry = ?").run(JSON.stringify(altered));
        await assert.rejects(store.catalog.report("customer-a", entry().summary.id));
        await assert.rejects(store.catalog.list("customer-a"));
      }
    } finally { writer.close(); store.close(); }
  });
});

test("audit resolves only after commit and rejects contention, duplicates and closed storage", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    const reader = new DatabaseSync(path);
    try {
      await store.audit(event());
      assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total, 1);
      await assert.rejects(store.audit(event()));
      reader.exec("BEGIN IMMEDIATE");
      try { await assert.rejects(store.audit(event("locked-request")), /locked/); }
      finally { reader.exec("ROLLBACK"); }
      assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total, 1);
    } finally { reader.close(); store.close(); }
    await assert.rejects(store.audit(event("closed-request")));
    await assert.rejects(store.catalog.list("customer-a"));
  });
});

test("invalid paths, corrupt files and unsupported schema versions fail explicitly", async () => {
  assert.throws(() => openDiagnosticStore(":memory:"), /absolute/);
  await fixture(async (path) => {
    await writeFile(path, "not a SQLite database");
    assert.throws(() => openDiagnosticStore(path));
  });
  await fixture(async (path) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 99");
    db.close();
    assert.throws(() => openDiagnosticStore(path), /Unsupported/);
  });
  await fixture(async (path) => {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE unrelated (value TEXT)");
    db.close();
    assert.throws(() => openDiagnosticStore(path), /nonempty unversioned/);
  });
});

test("live SQLite backup restores customer reports and exact audit history after source removal", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    let directory: string;
    try {
      approveSyntheticIncidents(store, [entry(), entry("customer-b", "b")]);
      await store.audit(event());
      directory = await backupDiagnosticStore(path, dirname(path));
      await store.audit(event("after-backup"));
    } finally { store.close(); }
    await rm(path);
    const restoredPath = await restoreDiagnosticStore(directory, dirname(path));
    const restored = openDiagnosticStore(restoredPath);
    try {
      assert.deepEqual(await restored.catalog.list("customer-a"), [entry().summary]);
      assert.deepEqual(await restored.catalog.list("customer-b"), [entry("customer-b", "b").summary]);
      assert.equal(await restored.catalog.report("customer-a", entry().summary.id), html);
      assert.equal(await restored.catalog.report("customer-b", entry().summary.id), undefined);
      const reader = new DatabaseSync(restoredPath, { readOnly: true });
      try {
        assert.deepEqual(reader.prepare("SELECT request_id, outcome, status FROM access_audit").all()
          .map((row) => ({ ...row })), [{ request_id: "request-a", outcome: event().outcome, status: 200 }]);
      } finally { reader.close(); }
      await restored.audit(event("after-restore"));
    } finally { restored.close(); }
    const second = await restoreDiagnosticStore(directory, dirname(path));
    assert.notEqual(second, restoredPath);
    const reader = new DatabaseSync(second, { readOnly: true });
    try { assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total, 1); }
    finally { reader.close(); }
  });
});

test("tampered, incomplete and malformed backup artifacts are refused without publishing a restore", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    approveSyntheticIncidents(store, [entry()]);
    const directory = await backupDiagnosticStore(path, dirname(path));
    store.close();
    const manifestPath = join(directory, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    for (const altered of ["{}", "null", "{", JSON.stringify({ ...JSON.parse(original), incidents: 99 })]) {
      await writeFile(manifestPath, altered);
      await assert.rejects(restoreDiagnosticStore(directory, dirname(path)));
      assert.ok(!(await readdir(dirname(path))).some((name) => name.startsWith("diagnostic-restore-")));
    }
    await writeFile(manifestPath, original);
    const backupPath = join(directory, "diagnostics.sqlite");
    const writer = new DatabaseSync(backupPath);
    try { writer.prepare("UPDATE incidents SET entry = ?").run("null"); }
    finally { writer.close(); }
    const alteredHash = createHash("sha256").update(await readFile(backupPath)).digest("hex");
    await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(original), sha256: alteredHash }));
    await assert.rejects(restoreDiagnosticStore(directory, dirname(path)), /Invalid incident/);
    await writeFile(manifestPath, original);
    await writeFile(backupPath, "incomplete or tampered bytes");
    await assert.rejects(restoreDiagnosticStore(directory, dirname(path)), /checksum/);
    await rm(backupPath);
    await assert.rejects(restoreDiagnosticStore(directory, dirname(path)), /ENOENT/);
    await rm(manifestPath);
    await assert.rejects(restoreDiagnosticStore(directory, dirname(path)), /ENOENT/);
    assert.ok(!(await readdir(dirname(path))).some((name) => name.startsWith("diagnostic-restore-")));
  });
});

test("backup rejects corrupt reports and unsupported databases and cleans up failed output", async () => {
  await fixture(async (path) => {
    const store = openDiagnosticStore(path);
    approveSyntheticIncidents(store, [entry()]);
    store.close();
    const writer = new DatabaseSync(path);
    try {
      writer.prepare("UPDATE incidents SET entry = ?").run(JSON.stringify({
        ...entry(), report: { html: "tampered", sha256: entry().report!.sha256 },
      }));
      await assert.rejects(backupDiagnosticStore(path, dirname(path)), /integrity/);
      writer.exec("PRAGMA user_version = 99");
      await assert.rejects(backupDiagnosticStore(path, dirname(path)), /schema/);
      assert.deepEqual(await readdir(dirname(path)), ["diagnostics.sqlite"]);
    } finally { writer.close(); }
  });
});

test("backup and restore never create missing sources or accept relative paths", async () => {
  await fixture(async (path) => {
    await assert.rejects(backupDiagnosticStore(path, dirname(path)));
    assert.deepEqual(await readdir(dirname(path)), []);
    await assert.rejects(backupDiagnosticStore("relative.sqlite", dirname(path)), /absolute/);
    await assert.rejects(backupDiagnosticStore(path, "."), /absolute/);
    await assert.rejects(restoreDiagnosticStore(".", dirname(path)), /absolute/);
    await assert.rejects(restoreDiagnosticStore(dirname(path), "."), /absolute/);
    assert.deepEqual(await readdir(dirname(path)), []);
  });
});

test("staged and rejected reports stay hidden; approvals bind the exact reviewed snapshot", async () => {
    await fixture(async (path) => {
      let store = openDiagnosticStore(path);
      try {
        const [pending] = store.stage([entry()]);
        const [rejected] = store.stage([entry("customer-b", "b")]);
        assert.deepEqual(await store.catalog.list("customer-a"), []);
        assert.equal(await store.catalog.report("customer-a", entry().summary.id), undefined);
        assert.deepEqual(store.pending("customer-a"), [{ ...pending, summary: entry().summary }]);
        assert.deepEqual(store.candidate(pending.id), { entry: entry(), sha256: pending.sha256 });
        const review = { reviewer: "engineer-123", reason: "Reviewed redaction and scope", sha256: pending.sha256, decision: "approve" as const };
        assert.throws(() => store.review(pending.id, { ...review, sha256: "0".repeat(64) }), /hash/);
        assert.throws(() => store.review(pending.id, { ...review, reason: " " }), /requires/);
        assert.throws(() => store.review(pending.id, { ...review, reviewer: "" }), /requires/);
        assert.throws(() => store.review("unknown", review), /not_found/);
        store.review(rejected.id, { ...review, sha256: rejected.sha256, decision: "reject", reason: "Out of scope" });
        assert.deepEqual(await store.catalog.list("customer-b"), []);
        assert.equal(await store.catalog.report("customer-b", entry("customer-b", "b").summary.id), undefined);
        assert.throws(() => store.review(rejected.id, { ...review, sha256: rejected.sha256 }));
        store.close();
        store = openDiagnosticStore(path);
        assert.deepEqual(store.pending("customer-a"), [{ ...pending, summary: entry().summary }]);
        store.review(pending.id, review);
        assert.deepEqual(store.pending("customer-a"), []);
        assert.equal(await store.catalog.report("customer-a", entry().summary.id), html);
        assert.throws(() => store.review(pending.id, review));
        const reader = new DatabaseSync(path, { readOnly: true });
        try {
          assert.deepEqual(reader.prepare("SELECT reviewer, reason, sha256 FROM incident_reviews WHERE candidate = ?").get(pending.id),
            Object.assign(Object.create(null), { reviewer: review.reviewer, reason: review.reason, sha256: pending.sha256 }));
        } finally { reader.close(); }
      } finally { store.close(); }
    });
  });

  test("review receipt failure rolls back publication and leaves the candidate pending", async () => {
    await fixture(async (path) => {
      const store = openDiagnosticStore(path);
      const writer = new DatabaseSync(path);
      try {
        const [pending] = store.stage([entry()]);
        writer.exec(`CREATE TRIGGER fail_review BEFORE INSERT ON incident_reviews
          BEGIN SELECT RAISE(ABORT, 'Synthetic review persistence failure'); END`);
        assert.throws(() => store.review(pending.id, {
          sha256: pending.sha256, decision: "approve", reviewer: "engineer", reason: "Synthetic review",
        }), /persistence failure/);
        assert.deepEqual(await store.catalog.list("customer-a"), []);
        assert.deepEqual(store.pending("customer-a"), [{ ...pending, summary: entry().summary }]);
        assert.equal(writer.prepare("SELECT count(*) AS total FROM incident_reviews").get()?.total, 0);
        writer.exec(`DROP TRIGGER fail_review;
          CREATE TRIGGER fail_publication BEFORE INSERT ON incidents
          BEGIN SELECT RAISE(ABORT, 'Synthetic publication failure'); END`);
        assert.throws(() => store.review(pending.id, {
          sha256: pending.sha256, decision: "approve", reviewer: "engineer", reason: "Synthetic review",
        }), /publication failure/);
        assert.equal(writer.prepare("SELECT count(*) AS total FROM incident_reviews").get()?.total, 0);
        assert.deepEqual(store.pending("customer-a"), [{ ...pending, summary: entry().summary }]);
      } finally { writer.close(); store.close(); }
    });
  });

  test("tampered candidate snapshots and missing approval receipts fail closed", async () => {
    await fixture(async (path) => {
      const store = openDiagnosticStore(path);
      const writer = new DatabaseSync(path);
      try {
        const [pending] = store.stage([entry()]);
        const original = writer.prepare("SELECT entry FROM report_candidates").get()?.entry;
        assert.equal(typeof original, "string");
        writer.prepare("UPDATE report_candidates SET entry = ?").run(JSON.stringify({ ...entry(), summary: { ...entry().summary, title: "Changed scope" } }));
        assert.throws(() => store.candidate(pending.id), /integrity/);
        assert.throws(() => store.review(pending.id, { sha256: pending.sha256, decision: "approve", reviewer: "engineer", reason: "Review" }), /hash/);
        writer.prepare("UPDATE report_candidates SET entry = ?").run(String(original));
        store.review(pending.id, { sha256: pending.sha256, decision: "approve", reviewer: "engineer", reason: "Review" });
        writer.exec("DELETE FROM incident_reviews");
        await assert.rejects(store.catalog.report("customer-a", entry().summary.id), /approval integrity/);
        await assert.rejects(backupDiagnosticStore(path, dirname(path)), /approval integrity/);
      } finally { writer.close(); store.close(); }
    });
  });

  test("schema-1 migration preserves legacy reports as pending rather than inventing approval", async () => {
    await fixture(async (path) => {
      const legacy = new DatabaseSync(path);
      legacy.exec(`CREATE TABLE incidents (customer TEXT, incident TEXT, entry TEXT);
        CREATE TABLE access_audit (sequence INTEGER PRIMARY KEY, request_id TEXT, timestamp TEXT,
          customer TEXT, subject TEXT, outcome TEXT, status INTEGER, basis TEXT, operation TEXT, incident TEXT);
        PRAGMA user_version = 1;`);
      legacy.prepare("INSERT INTO incidents VALUES (?, ?, ?)").run("customer-a", entry().summary.id, JSON.stringify(entry()));
      legacy.prepare("INSERT INTO access_audit (request_id, outcome, status) VALUES (?, ?, ?)").run("legacy-request", "legacy-access", 200);
      legacy.close();
      const directory = await backupDiagnosticStore(path, dirname(path));
      const recoveredPath = await restoreDiagnosticStore(directory, dirname(path));
      const store = openDiagnosticStore(recoveredPath);
      try {
        assert.deepEqual(await store.catalog.list("customer-a"), []);
        const [pending] = store.pending("customer-a");
        assert.ok(pending);
        assert.deepEqual(store.candidate(pending.id)?.entry, entry());
        store.review(pending.id, { sha256: pending.sha256, decision: "approve", reviewer: "engineer", reason: "Explicit legacy review" });
        assert.equal(await store.catalog.report("customer-a", entry().summary.id), html);
        const reader = new DatabaseSync(recoveredPath, { readOnly: true });
        try {
          assert.equal(reader.prepare("PRAGMA user_version").get()?.user_version, 2);
          assert.equal(reader.prepare("SELECT request_id FROM access_audit").get()?.request_id, "legacy-request");
        } finally { reader.close(); }
      } finally { store.close(); }
    });
  });

  test("backup and restore preserve pending and rejected candidates without publishing them", async () => {
    await fixture(async (path) => {
      const store = openDiagnosticStore(path);
      let directory: string;
      let pendingId: string;
      try {
        const [pending] = store.stage([entry()]);
        pendingId = pending.id;
        const [rejected] = store.stage([entry("customer-b", "b")]);
        store.review(rejected.id, { decision: "reject", reviewer: "engineer", reason: "Out of scope", sha256: rejected.sha256 });
        directory = await backupDiagnosticStore(path, dirname(path));
      } finally { store.close(); }
      const recoveredPath = await restoreDiagnosticStore(directory, dirname(path));
      const recovered = openDiagnosticStore(recoveredPath);
      try {
        assert.equal(recovered.pending("customer-a")[0].id, pendingId);
        assert.deepEqual(recovered.pending("customer-b"), []);
        assert.deepEqual(await recovered.catalog.list("customer-a"), []);
        assert.deepEqual(await recovered.catalog.list("customer-b"), []);
      } finally { recovered.close(); }
    });
  });
