import { DatabaseSync } from "node:sqlite";
import { isAbsolute } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertApprovedIncident, createIncidentCatalog } from "./incidents.ts";
import type { ApprovedIncident, IncidentCatalog, IncidentSummary } from "./incidents.ts";
import type { AccessAudit } from "./diagnostic-api.ts";

export interface DiagnosticStore {
  catalog: IncidentCatalog;
  stage(entries: readonly ApprovedIncident[]): { id: string; sha256: string }[];
  pending(customer: string): { id: string; sha256: string; summary: IncidentSummary }[];
  candidate(id: string): { entry: ApprovedIncident; sha256: string } | undefined;
  history(customer: string, candidate?: string): { reviews: RecordedReview[]; truncated: boolean };
  review(id: string, review: IncidentReview, access?: AccessAudit): void;
  audit(event: AccessAudit): Promise<void>;
  close(): void;
}

export interface IncidentReview {
  decision: "approve" | "reject";
  reviewer: string;
  reason: string;
  sha256: string;
}

export interface RecordedReview extends IncidentReview {
  id: string;
  summary: IncidentSummary;
  decidedAt: string;
}

export class ReviewConflict extends Error {
  status: 404 | 409;
  code: string;
  constructor(status: 404 | 409, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function parseEntry(customer: unknown, incident: unknown, json: unknown): ApprovedIncident {
  if (typeof json !== "string") throw new Error("Invalid stored incident");
  const entry: unknown = JSON.parse(json);
  assertApprovedIncident(entry);
  if (entry.customer !== customer || entry.summary.id !== incident) {
    throw new Error("Stored incident provenance mismatch");
  }
  return entry;
}

function entryHash(json: string) {
  return createHash("sha256").update(json).digest("hex");
}

export function assertIncidentApproval(db: DatabaseSync, customer: string, incident: string, json: string) {
  const approval = db.prepare(`SELECT c.entry, c.sha256, r.sha256 AS approved_hash,
      r.reviewer, r.reason, r.decided_at
    FROM report_candidates c JOIN incident_reviews r ON r.candidate = c.id
    WHERE c.customer = ? AND c.incident = ? AND r.decision = 'approve'`).get(customer, incident);
  if (!approval || approval.entry !== json || approval.sha256 !== entryHash(json) ||
      approval.approved_hash !== approval.sha256 ||
      typeof approval.reviewer !== "string" || !approval.reviewer.trim() ||
      typeof approval.reason !== "string" || !approval.reason.trim() ||
      typeof approval.decided_at !== "string" || !Number.isFinite(Date.parse(approval.decided_at))) {
    throw new Error("Incident approval integrity check failed");
  }
}

// Trusted operator methods: callers must authenticate and authorise reviewers.
export function openDiagnosticStore(path: string): DiagnosticStore {
  if (!isAbsolute(path)) throw new Error("Diagnostic database requires an absolute local path");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 250; PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    const version = db.prepare("PRAGMA user_version").get()?.user_version;
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error("Unsupported diagnostic database version");
    if (version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
      throw new Error("Refusing to initialise a nonempty unversioned database");
    }
    if (version === 0) db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS incidents (
        customer TEXT NOT NULL,
        incident TEXT NOT NULL,
        entry TEXT NOT NULL,
        PRIMARY KEY (customer, incident)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS access_audit (
        sequence INTEGER PRIMARY KEY,
        request_id TEXT NOT NULL UNIQUE,
        timestamp TEXT NOT NULL,
        customer TEXT,
        subject TEXT,
        outcome TEXT NOT NULL,
        status INTEGER NOT NULL,
        basis TEXT,
        operation TEXT,
        incident TEXT
      ) STRICT;
      PRAGMA user_version = 1;
      COMMIT;
    `);
    db.prepare("SELECT customer, incident, entry FROM incidents LIMIT 0");
    db.prepare(`SELECT sequence, request_id, timestamp, customer, subject, outcome, status,
      basis, operation, incident FROM access_audit LIMIT 0`);
    if (version === 0 || version === 1) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`
          CREATE TABLE report_candidates (
            id TEXT PRIMARY KEY,
            customer TEXT NOT NULL,
            incident TEXT NOT NULL,
            entry TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            staged_at TEXT NOT NULL,
            UNIQUE(customer, incident)
          ) STRICT;
          CREATE TABLE incident_reviews (
            candidate TEXT PRIMARY KEY REFERENCES report_candidates(id),
            decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject')),
            reviewer TEXT NOT NULL,
            reason TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            decided_at TEXT NOT NULL
          ) STRICT;
        `);
        const insert = db.prepare(`INSERT INTO report_candidates
          (id, customer, incident, entry, sha256, staged_at) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const row of db.prepare("SELECT customer, incident, entry FROM incidents").all()) {
          const entry = parseEntry(row.customer, row.incident, row.entry);
          const json = JSON.stringify(entry);
          insert.run(randomUUID(), entry.customer, entry.summary.id, json, entryHash(json), new Date().toISOString());
        }
        // Legacy imports have no reviewer evidence: preserve them for review,
        // rather than inventing approval or silently grandfathering disclosure.
        db.exec("DELETE FROM incidents; PRAGMA user_version = 2; COMMIT;");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec("PRAGMA foreign_keys = ON");
    db.prepare("SELECT id, customer, incident, entry, sha256, staged_at FROM report_candidates LIMIT 0");
    db.prepare("SELECT candidate, decision, reviewer, reason, sha256, decided_at FROM incident_reviews LIMIT 0");
    if (version !== 3) {
      db.exec(`BEGIN IMMEDIATE;
        ALTER TABLE access_audit ADD COLUMN booking_operation TEXT;
        PRAGMA user_version = 3; COMMIT;`);
    }
    db.prepare("SELECT booking_operation FROM access_audit LIMIT 0");
  } catch (error) {
    db.close();
    throw error;
  }

  const read = (customer: string, incident?: string) => {
    const rows = incident === undefined
      ? db.prepare("SELECT customer, incident, entry FROM incidents WHERE customer = ? ORDER BY incident").all(customer)
      : db.prepare("SELECT customer, incident, entry FROM incidents WHERE customer = ? AND incident = ?").all(customer, incident);
    return rows.map((row) => {
      const entry = parseEntry(row.customer, row.incident, row.entry);
      if (typeof row.entry !== "string") throw new Error("Invalid stored incident");
      assertIncidentApproval(db, entry.customer, entry.summary.id, row.entry);
      return entry;
    });
  };
  const persistAudit = (event: AccessAudit) => {
    db.prepare(`INSERT INTO access_audit
      (request_id, timestamp, customer, subject, outcome, status, basis, operation, incident, booking_operation)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.requestId, event.timestamp, event.customer ?? null, event.subject ?? null,
      event.outcome, event.status, event.basis ?? null, event.operation ?? null, event.incident ?? null,
      event.bookingOperation ?? null,
    );
  };
  return {
    catalog: {
      async list(customer) {
        return createIncidentCatalog(read(customer)).list(customer);
      },
      async report(customer, incident) {
        return createIncidentCatalog(read(customer, incident)).report(customer, incident);
      },
    },
    stage(entries) {
      const snapshot = structuredClone(entries);
      createIncidentCatalog(snapshot);
      db.exec("BEGIN IMMEDIATE");
      try {
        const insert = db.prepare(`INSERT INTO report_candidates
          (id, customer, incident, entry, sha256, staged_at) VALUES (?, ?, ?, ?, ?, ?)`);
        const candidates: { id: string; sha256: string }[] = [];
        for (const entry of snapshot) {
          // Persist only the approved schema, never extra caller fields.
          const json = JSON.stringify({
            customer: entry.customer,
            summary: { id: entry.summary.id, title: entry.summary.title, createdAt: entry.summary.createdAt },
            ...(entry.report ? { report: { html: entry.report.html, sha256: entry.report.sha256 } } : {}),
          });
          const id = randomUUID();
          const sha256 = entryHash(json);
          insert.run(id, entry.customer, entry.summary.id, json, sha256, new Date().toISOString());
          candidates.push({ id, sha256 });
        }
        db.exec("COMMIT");
        return candidates;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    pending(customer) {
      return db.prepare(`SELECT c.* FROM report_candidates c
        LEFT JOIN incident_reviews r ON r.candidate = c.id
        WHERE c.customer = ? AND r.candidate IS NULL ORDER BY c.id`).all(customer).map((row) => {
        const entry = parseEntry(row.customer, row.incident, row.entry);
        if (typeof row.id !== "string" || typeof row.entry !== "string" || row.sha256 !== entryHash(row.entry)) {
          throw new Error("Staged incident integrity check failed");
        }
        return { id: row.id, sha256: entryHash(row.entry),
          summary: { id: entry.summary.id, title: entry.summary.title, createdAt: entry.summary.createdAt } };
      });
    },
    candidate(id) {
      const row = db.prepare("SELECT customer, incident, entry, sha256 FROM report_candidates WHERE id = ?").get(id);
      if (!row) return undefined;
      const entry = parseEntry(row.customer, row.incident, row.entry);
      if (typeof row.entry !== "string" || row.sha256 !== entryHash(row.entry)) {
        throw new Error("Staged incident integrity check failed");
      }
      return { entry, sha256: entryHash(row.entry) };
    },
    history(customer, candidate) {
      const columns = `SELECT c.id, c.customer, c.incident, c.entry, c.sha256,
        r.sha256 AS reviewed_hash, r.decision, r.reviewer, r.reason, r.decided_at
        FROM report_candidates c JOIN incident_reviews r ON r.candidate = c.id`;
      const rows = candidate === undefined
        ? db.prepare(`${columns} WHERE c.customer = ? ORDER BY r.decided_at DESC, c.id LIMIT 51`).all(customer)
        : db.prepare(`${columns} WHERE c.customer = ? AND c.id = ?`).all(customer, candidate);
      const reviews = rows.slice(0, 50).map((row): RecordedReview => {
        const entry = parseEntry(row.customer, row.incident, row.entry);
        if (typeof row.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id) ||
            typeof row.entry !== "string" || row.sha256 !== entryHash(row.entry) || row.reviewed_hash !== row.sha256 ||
            (row.decision !== "approve" && row.decision !== "reject") ||
            typeof row.reviewer !== "string" || !row.reviewer.trim() || row.reviewer.length > 200 ||
            typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 2000 ||
            typeof row.decided_at !== "string" || !Number.isFinite(Date.parse(row.decided_at))) {
          throw new Error("Review history integrity check failed");
        }
        return { id: row.id, sha256: entryHash(row.entry), decision: row.decision, reviewer: row.reviewer,
          reason: row.reason, decidedAt: row.decided_at,
          summary: { id: entry.summary.id, title: entry.summary.title, createdAt: entry.summary.createdAt } };
      });
      return { reviews, truncated: rows.length > 50 };
    },
    review(id, review, access) {
      if (!["approve", "reject"].includes(review.decision) || !review.reviewer.trim() ||
          review.reviewer.length > 200 || !review.reason.trim() || review.reason.length > 2000 ||
          !/^[0-9a-f]{64}$/.test(review.sha256)) {
        throw new Error("Review requires a decision, reviewer, reason and exact candidate hash");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db.prepare("SELECT customer, incident, entry, sha256 FROM report_candidates WHERE id = ?").get(id);
        if (!row || (access && row.customer !== access.customer)) throw new ReviewConflict(404, "review_candidate_not_found");
        parseEntry(row.customer, row.incident, row.entry);
        if (typeof row.entry !== "string" || row.sha256 !== entryHash(row.entry) || row.sha256 !== review.sha256) {
          throw new ReviewConflict(409, "review_candidate_hash_mismatch");
        }
        if (db.prepare("SELECT 1 FROM incident_reviews WHERE candidate = ?").get(id)) {
          throw new ReviewConflict(409, "review_already_decided");
        }
        if (access && (access.subject !== review.reviewer || access.status !== 200 ||
            access.operation !== "review-decision" || access.incident !== row.incident ||
            access.outcome !== `incident_review_${review.decision}`)) {
          throw new Error("Review access audit does not match decision");
        }
        db.prepare(`INSERT INTO incident_reviews
          (candidate, decision, reviewer, reason, sha256, decided_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
          id, review.decision, review.reviewer, review.reason, review.sha256, new Date().toISOString(),
        );
        if (review.decision === "approve") {
          db.prepare("INSERT INTO incidents (customer, incident, entry) VALUES (?, ?, ?)").run(
            row.customer, row.incident, row.entry,
          );
        }
        if (access) persistAudit(access);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async audit(event) {
      persistAudit(event);
    },
    close() { if (db.isOpen) db.close(); },
  };
}
