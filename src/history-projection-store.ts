import { isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildHistoryProjection, projectionScope, PROJECTION_ALGORITHM, PROJECTION_DOCUMENT_LIMIT,
  type ProjectionScope } from "./history-projection.ts";
import type { openCelHistory } from "./cel-history.ts";
import { historyInteger as integer, historyDigest as digest, historySha256 as sha256 } from "./history-evidence.ts";

const applicationId = 0x4a50524a;
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function openHistoryProjections(path: string, options: { readOnly?: boolean } = {}) {
  if (!isAbsolute(path)) throw new Error("Projections require an absolute dedicated database path");
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  try {
    db.exec("PRAGMA busy_timeout=1000;");
    if (!options.readOnly) db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    db.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const identity = db.prepare("PRAGMA application_id").get()?.application_id;
      if (version === 0 && identity === 0 && !options.readOnly &&
          !db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        db.exec(`CREATE TABLE projection_revisions (
          id INTEGER PRIMARY KEY, customer TEXT NOT NULL, runtime TEXT NOT NULL, epoch TEXT NOT NULL,
          algorithm TEXT NOT NULL, input_sha256 TEXT NOT NULL, document TEXT NOT NULL,
          sha256 TEXT NOT NULL, created_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX projection_scope ON projection_revisions(customer,runtime,epoch,id);
        PRAGMA application_id=${applicationId}; PRAGMA user_version=1;`);
      } else if (version !== 1 || identity !== applicationId) throw new Error("Not a supported journey projection database");
      db.prepare("SELECT id,customer,runtime,epoch,algorithm,input_sha256,document,sha256,created_at FROM projection_revisions LIMIT 0");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { db.close(); throw error; }
  function decode(row: Record<string, unknown>, scope: ProjectionScope) {
    if (!integer(row.id) || row.id < 1 || row.customer !== scope.customer || row.runtime !== scope.runtime ||
        row.epoch !== scope.epoch || typeof row.algorithm !== "string" ||
        ![PROJECTION_ALGORITHM, "marked-caller-v1", "marked-caller-v2", "marked-caller-v3"].includes(row.algorithm) ||
        !digest(row.sha256) || !digest(row.input_sha256) || typeof row.document !== "string" ||
        Buffer.byteLength(row.document) > PROJECTION_DOCUMENT_LIMIT || sha256(Buffer.from(row.document)) !== row.sha256 ||
        typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
        new Date(row.created_at).toISOString() !== row.created_at) throw new Error("Corrupt journey projection revision");
    const document: unknown = JSON.parse(row.document);
    if (!object(document) || document.algorithm !== row.algorithm || !object(document.scope) ||
        document.scope.customer !== scope.customer || document.scope.runtime !== scope.runtime || document.scope.epoch !== scope.epoch ||
        !object(document.input) || document.input.algorithm !== row.algorithm ||
        JSON.stringify(document.input.scope) !== JSON.stringify(document.scope) ||
        !Array.isArray(document.input.checkpoints) || !Array.isArray(document.input.manifests) ||
        !Array.isArray(document.input.coverage) || !Array.isArray(document.journeys) || !Array.isArray(document.issues) ||
        !object(document.quality) || document.quality.completeness !== "unverified" ||
        sha256(Buffer.from(JSON.stringify(document.input))) !== row.input_sha256) {
      throw new Error("Corrupt journey projection document/input");
    }
    return { id: row.id, scope, algorithm: row.algorithm, inputSha256: row.input_sha256,
      sha256: row.sha256, createdAt: row.created_at, document };
  }
  function latest(scope: ProjectionScope) {
    projectionScope(scope);
    const row = db.prepare(`SELECT * FROM projection_revisions WHERE customer=? AND runtime=? AND epoch=? ORDER BY id DESC LIMIT 1`)
      .get(scope.customer, scope.runtime, scope.epoch);
    if (!row) throw new Error("Journey projection not found for customer/runtime/epoch");
    return decode(row, scope);
  }
  return {
    rebuild(history: ReturnType<typeof openCelHistory>, scope: ProjectionScope) {
      if (options.readOnly) throw new Error("Projection rebuild requires a writable projection database");
      projectionScope(scope);
      // Serialize before reading history so a delayed rebuilder cannot publish
      // an older snapshot over a newer completed revision.
      db.exec("BEGIN IMMEDIATE");
      try {
        const built = buildHistoryProjection(history, scope);
        const row = db.prepare(`SELECT * FROM projection_revisions WHERE customer=? AND runtime=? AND epoch=? ORDER BY id DESC LIMIT 1`)
          .get(scope.customer, scope.runtime, scope.epoch);
        if (row) {
          const previous = decode(row, scope);
          if (previous.inputSha256 === built.inputSha256 && previous.sha256 === built.sha256) {
            db.exec("COMMIT"); return { ...previous, reused: true };
          }
        }
        const result = db.prepare(`INSERT INTO projection_revisions
          (customer,runtime,epoch,algorithm,input_sha256,document,sha256,created_at) VALUES(?,?,?,?,?,?,?,?)`)
          .run(scope.customer, scope.runtime, scope.epoch, PROJECTION_ALGORITHM, built.inputSha256,
            JSON.stringify(built.document), built.sha256, new Date().toISOString());
        const published = decode(db.prepare("SELECT * FROM projection_revisions WHERE id=?").get(result.lastInsertRowid)!, scope);
        db.exec("COMMIT");
        return { ...published, reused: false };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    read(scope: ProjectionScope, id?: number) {
      projectionScope(scope);
      if (id === undefined) return latest(scope);
      if (!integer(id) || id < 1) throw new Error("Invalid projection revision ID");
      const row = db.prepare("SELECT * FROM projection_revisions WHERE customer=? AND runtime=? AND epoch=? AND id=?")
        .get(scope.customer, scope.runtime, scope.epoch, id);
      if (!row) throw new Error("Journey projection revision not found for scope");
      return decode(row, scope);
    },
    revisions(scope: ProjectionScope, afterId = 0, limit = 100) {
      projectionScope(scope);
      if (!integer(afterId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid projection revision page");
      const rows = db.prepare(`SELECT * FROM projection_revisions
        WHERE customer=? AND runtime=? AND epoch=? AND id>? ORDER BY id LIMIT ?`)
        .iterate(scope.customer, scope.runtime, scope.epoch, afterId, limit + 1);
      const revisions: Omit<ReturnType<typeof decode>, "document">[] = [];
      let hasMore = false;
      for (const row of rows) {
        if (revisions.length === limit) { hasMore = true; break; }
        const { document: _document, ...metadata } = decode(row, scope);
        revisions.push(metadata);
      }
      return { revisions, nextAfterId: hasMore ? revisions.at(-1)!.id : null };
    },
    close() { db.close(); },
  };
}
export function distinctProjectionPaths(historyPath: string, projectionPath: string) {
  if (!isAbsolute(historyPath) || !isAbsolute(projectionPath) ||
      resolve(historyPath).toLowerCase() === resolve(projectionPath).toLowerCase()) {
    throw new Error("Raw history and derived projection databases require distinct absolute paths");
  }
}
