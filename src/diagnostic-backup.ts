import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { assertApprovedIncident } from "./incidents.ts";
import { assertIncidentApproval } from "./diagnostic-store.ts";

interface BackupManifest {
  version: 1 | 2;
  createdAt: string;
  sha256: string;
  incidents: number;
  auditRecords: number;
  candidates?: number;
  reviews?: number;
}

function absolute(path: string) {
  if (!isAbsolute(path)) throw new Error("Diagnostic backup paths must be absolute local paths");
}

async function digest(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function inspect(db: DatabaseSync) {
  const schema = db.prepare("PRAGMA user_version").get()?.user_version;
  if (schema !== 1 && schema !== 2 && schema !== 3) {
    throw new Error("Unsupported diagnostic backup schema");
  }
  const checks = db.prepare("PRAGMA integrity_check").all();
  if (checks.length !== 1 || checks[0].integrity_check !== "ok") {
    throw new Error("Diagnostic backup database integrity check failed");
  }
  let incidents = 0;
  for (const row of db.prepare("SELECT customer, incident, entry FROM incidents").iterate()) {
    if (typeof row.entry !== "string") throw new Error("Invalid stored incident");
    const entry: unknown = JSON.parse(row.entry);
    assertApprovedIncident(entry);
    if (entry.customer !== row.customer || entry.summary.id !== row.incident) {
      throw new Error("Stored incident provenance mismatch");
    }
    if (schema === 2 || schema === 3) assertIncidentApproval(db, entry.customer, entry.summary.id, row.entry);
    incidents++;
  }
  db.prepare(`SELECT sequence, request_id, timestamp, customer, subject, outcome, status,
    basis, operation, incident FROM access_audit LIMIT 0`);
  if (schema === 3) db.prepare("SELECT booking_operation FROM access_audit LIMIT 0");
  const auditRecords = db.prepare("SELECT count(*) AS total FROM access_audit").get()?.total;
  if (typeof auditRecords !== "number" || !Number.isSafeInteger(auditRecords)) {
    throw new Error("Invalid diagnostic audit count");
  }
  if (schema === 1) return { incidents, auditRecords };
  let candidates = 0;
  let reviews = 0;
  for (const row of db.prepare(`SELECT c.*, r.decision, r.reviewer, r.reason, r.sha256 AS reviewed_hash, r.decided_at
      FROM report_candidates c LEFT JOIN incident_reviews r ON r.candidate = c.id`).iterate()) {
    if (typeof row.entry !== "string") throw new Error("Invalid stored candidate");
    const entry: unknown = JSON.parse(row.entry);
    assertApprovedIncident(entry);
    if (typeof row.id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(row.id) ||
        entry.customer !== row.customer || entry.summary.id !== row.incident ||
        row.sha256 !== createHash("sha256").update(row.entry).digest("hex") ||
        typeof row.staged_at !== "string" || !Number.isFinite(Date.parse(row.staged_at))) {
      throw new Error("Candidate integrity check failed");
    }
    if (row.decision !== null) {
      if (!["approve", "reject"].includes(String(row.decision)) || row.reviewed_hash !== row.sha256 ||
          typeof row.reviewer !== "string" || !row.reviewer.trim() || row.reviewer.length > 200 ||
          typeof row.reason !== "string" || !row.reason.trim() || row.reason.length > 2000 ||
          typeof row.decided_at !== "string" || !Number.isFinite(Date.parse(row.decided_at))) {
        throw new Error("Review integrity check failed");
      }
      const published = db.prepare("SELECT entry FROM incidents WHERE customer = ? AND incident = ?")
        .get(entry.customer, entry.summary.id);
      if (row.decision === "approve" && published?.entry !== row.entry) {
        throw new Error("Approved candidate publication mismatch");
      }
      if (row.decision === "reject" && published) throw new Error("Rejected candidate was published");
      reviews++;
    } else if (db.prepare("SELECT 1 FROM incidents WHERE customer = ? AND incident = ?").get(entry.customer, entry.summary.id)) {
      throw new Error("Pending candidate was published");
    }
    candidates++;
  }
  if (db.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Orphaned incident review");
  return { incidents, auditRecords, candidates, reviews };
}

function inspectFile(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return inspect(db); }
  finally { db.close(); }
}

function manifest(value: unknown): BackupManifest {
  if (typeof value !== "object" || value === null ||
      !("version" in value) || (value.version !== 1 && value.version !== 2) ||
      !("createdAt" in value) || typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      !("sha256" in value) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) ||
      !("incidents" in value) || typeof value.incidents !== "number" || !Number.isSafeInteger(value.incidents) || value.incidents < 0 ||
      !("auditRecords" in value) || typeof value.auditRecords !== "number" || !Number.isSafeInteger(value.auditRecords) || value.auditRecords < 0) {
    throw new Error("Invalid diagnostic backup manifest");
  }
  if (value.version === 2 && (!("candidates" in value) || typeof value.candidates !== "number" ||
      !Number.isSafeInteger(value.candidates) || value.candidates < 0 ||
      !("reviews" in value) || typeof value.reviews !== "number" ||
      !Number.isSafeInteger(value.reviews) || value.reviews < 0)) {
    throw new Error("Invalid diagnostic backup workflow counts");
  }
  return {
    version: value.version, createdAt: value.createdAt, sha256: value.sha256,
    incidents: value.incidents, auditRecords: value.auditRecords,
    ...(value.version === 2 && "candidates" in value && typeof value.candidates === "number" &&
      "reviews" in value && typeof value.reviews === "number" ? { candidates: value.candidates, reviews: value.reviews } : {}),
  };
}

// Only newly allocated directories are written or removed; live databases are
// never restore destinations. The parent directories must be operator-controlled.
export async function backupDiagnosticStore(sourcePath: string, parentDirectory: string): Promise<string> {
  absolute(sourcePath);
  absolute(parentDirectory);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(parentDirectory, "diagnostic-backup-"));
    const path = join(directory, "diagnostics.sqlite");
    await backup(source, path);
    const counts = inspectFile(path);
    const record: BackupManifest = {
      version: counts.candidates === undefined ? 1 : 2,
      createdAt: new Date().toISOString(), sha256: await digest(path), ...counts,
    };
    await writeFile(join(directory, "manifest.json"), JSON.stringify(record) + "\n", { flag: "wx" });
    return directory;
  } catch (error) {
    if (directory) await rm(directory, { recursive: true });
    throw error;
  } finally { source.close(); }
}

export async function restoreDiagnosticStore(backupDirectory: string, parentDirectory: string): Promise<string> {
  absolute(backupDirectory);
  absolute(parentDirectory);
  const record = manifest(JSON.parse(await readFile(join(backupDirectory, "manifest.json"), "utf8")));
  const directory = await mkdtemp(join(parentDirectory, "diagnostic-restore-"));
  try {
    const path = join(directory, "diagnostics.sqlite");
    await copyFile(join(backupDirectory, "diagnostics.sqlite"), path, constants.COPYFILE_EXCL);
    if (await digest(path) !== record.sha256) throw new Error("Diagnostic backup checksum mismatch");
    const counts = inspectFile(path);
    if (counts.incidents !== record.incidents || counts.auditRecords !== record.auditRecords ||
        counts.candidates !== record.candidates || counts.reviews !== record.reviews) {
      throw new Error("Diagnostic backup record count mismatch");
    }
    return path;
  } catch (error) {
    await rm(directory, { recursive: true });
    throw error;
  }
}
