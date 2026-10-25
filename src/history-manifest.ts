import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { historyIdentifier as identifier, historyInteger as integer, historySha256 as sha256,
  historyDigest, HISTORY_SNAPSHOT_LIMIT, HISTORY_RECORD_LIMIT } from "./history-evidence.ts";

export interface HistoryRange {
  kind: "cel" | "queue";
  source: string;
  generation: string;
  start: number;
  end: number;
}
export interface MarkerRoute {
  context: string;
  extension: string;
  routeRevision: string;
  entryKind: "synthetic" | "external";
}
export interface HistoryManifest {
  customer: string;
  runtime: string;
  epoch: string;
  operator: string;
  reason: string;
  routes: MarkerRoute[];
  ranges: HistoryRange[];
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: string[]) {
  if (Object.keys(value).sort().join(",") !== expected.sort().join(",")) throw new Error("Invalid manifest fields");
}
function text(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("Invalid bounded manifest text");
  }
}
function input(value: unknown): HistoryManifest {
  if (!object(value)) throw new Error("Manifest must be an object");
  keys(value, ["customer", "runtime", "epoch", "operator", "reason", "routes", "ranges"]);
  identifier(value.customer); identifier(value.runtime); identifier(value.epoch);
  text(value.operator, 200); text(value.reason, 2000);
  if (!Array.isArray(value.routes) || value.routes.length > 20 ||
      !Array.isArray(value.ranges) || value.ranges.length < 1 || value.ranges.length > 100) throw new Error("Invalid manifest range/route count");
  const routes = value.routes.map((route: unknown): MarkerRoute => {
    if (!object(route)) throw new Error("Invalid marker route");
    keys(route, ["context", "extension", "routeRevision", "entryKind"]);
    text(route.context, 100); text(route.extension, 100); identifier(route.routeRevision);
    if (route.entryKind !== "synthetic" && route.entryKind !== "external") throw new Error("Invalid entry kind");
    return { context: route.context, extension: route.extension, routeRevision: route.routeRevision, entryKind: route.entryKind };
  });
  if (new Set(routes.map((route) => `${route.context}\0${route.extension}`)).size !== routes.length) throw new Error("Duplicate trusted route");
  const ranges = value.ranges.map((range: unknown): HistoryRange => {
    if (!object(range)) throw new Error("Invalid history range");
    keys(range, ["kind", "source", "generation", "start", "end"]);
    if (range.kind !== "cel" && range.kind !== "queue") throw new Error("Invalid history source kind");
    identifier(range.source); identifier(range.generation);
    if (!integer(range.start) || !integer(range.end) || range.end <= range.start || range.end > HISTORY_SNAPSHOT_LIMIT) {
      throw new Error("Invalid history range extent");
    }
    return { kind: range.kind, source: range.source, generation: range.generation, start: range.start, end: range.end };
  });
  const result = { customer: value.customer, runtime: value.runtime, epoch: value.epoch,
    operator: value.operator, reason: value.reason, routes, ranges };
  if (Buffer.byteLength(JSON.stringify(result)) > 65536) throw new Error("Manifest exceeds 64 KiB");
  return result;
}
export function createManifestSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE history_manifests (
    id INTEGER PRIMARY KEY, customer TEXT NOT NULL, runtime TEXT NOT NULL, epoch TEXT NOT NULL,
    document TEXT NOT NULL, sha256 TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE history_ranges (
    manifest_id INTEGER NOT NULL REFERENCES history_manifests(id), kind TEXT NOT NULL,
    source TEXT NOT NULL, generation TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
    evidence_sha256 TEXT NOT NULL, PRIMARY KEY(kind,source,generation,start)
  ) STRICT;
  CREATE INDEX history_manifest_scope ON history_manifests(customer,id);
  PRAGMA user_version=4;`);
}
export function validateManifestSchema(db: DatabaseSync) {
  db.prepare("SELECT id,customer,runtime,epoch,document,sha256,created_at FROM history_manifests LIMIT 0");
  db.prepare("SELECT manifest_id,kind,source,generation,start,end,evidence_sha256 FROM history_ranges LIMIT 0");
}
export function createHistoryManifests(db: DatabaseSync, enabled: boolean, readOnly: boolean) {
  function available() {
    if (!enabled) throw new Error("History manifests require schema 4; migrate with a trusted writer");
  }
  function readRow(row: Record<string, unknown>) {
    if (!integer(row.id) || row.id < 1 || typeof row.document !== "string" || Buffer.byteLength(row.document) > 65536 ||
        typeof row.sha256 !== "string" || sha256(Buffer.from(row.document)) !== row.sha256 ||
        typeof row.created_at !== "string" || !Number.isFinite(Date.parse(row.created_at)) ||
        new Date(row.created_at).toISOString() !== row.created_at) throw new Error("Corrupt history manifest");
    const manifest = input(JSON.parse(row.document));
    if (manifest.customer !== row.customer || manifest.runtime !== row.runtime || manifest.epoch !== row.epoch ||
        JSON.stringify(manifest) !== row.document) throw new Error("Corrupt manifest scope/document");
    const ranges = db.prepare("SELECT * FROM history_ranges WHERE manifest_id=? LIMIT 101").all(row.id);
    if (ranges.length !== manifest.ranges.length || ranges.some((range) =>
      !manifest.ranges.some((expected) => expected.kind === range.kind && expected.source === range.source &&
        expected.generation === range.generation && expected.start === range.start && expected.end === range.end) ||
      typeof range.evidence_sha256 !== "string" || !/^[0-9a-f]{64}$/.test(range.evidence_sha256))) {
      throw new Error("Corrupt manifest range inventory");
    }
    return { id: row.id, ...manifest, sha256: row.sha256, createdAt: row.created_at };
  }
  function sourceRow(customer: string, kind: string, source: string, generation: string) {
    if (kind !== "cel" && kind !== "queue") throw new Error("Invalid history source kind");
    const row = db.prepare(`SELECT * FROM ${kind === "cel" ? "cel_sources" : "queue_sources"} WHERE source=? AND generation=?`)
      .get(source, generation);
    if (!row || row.customer !== customer) throw new Error("History source not found for customer");
    if (!integer(row.consumed_bytes) || row.consumed_bytes > HISTORY_SNAPSHOT_LIMIT || !historyDigest(row.prefix_sha256)) {
      throw new Error("Corrupt history source checkpoint");
    }
    return row;
  }
  function rangeHash(range: HistoryRange, customer: string) {
    const source = sourceRow(customer, range.kind, range.source, range.generation);
    if (!integer(source.consumed_bytes) || range.end > source.consumed_bytes) throw new Error("Range extends beyond committed evidence");
    const rows = db.prepare(`SELECT offset,end_offset,raw,sha256 FROM ${range.kind === "cel" ? "cel_events" : "queue_events"}
      WHERE source=? AND generation=? AND offset>=? AND offset<? ORDER BY offset`)
      .iterate(range.source, range.generation, range.start, range.end);
    let end = range.start;
    const hash = createHash("sha256");
    let count = 0;
    for (const row of rows) {
      if (row.offset !== end || !integer(row.end_offset) || row.end_offset <= end || row.end_offset > range.end ||
          !(row.raw instanceof Uint8Array) || row.raw.length > HISTORY_RECORD_LIMIT ||
          row.raw.length !== row.end_offset - end || sha256(row.raw) !== row.sha256) {
        throw new Error("Manifest requires contiguous intact record-boundary evidence");
      }
      hash.update(row.raw); end = row.end_offset; count++;
    }
    if (end !== range.end || count === 0) throw new Error("Manifest range must align with complete record boundaries");
    return hash.digest("hex");
  }
  return {
    register(value: unknown) {
      available();
      if (readOnly) throw new Error("Manifest registration requires a writable history store");
      const manifest = input(value);
      const document = JSON.stringify(manifest);
      const digest = sha256(Buffer.from(document));
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db.prepare("SELECT * FROM history_manifests WHERE sha256=?").get(digest);
        if (existing) {
          const result = readRow(existing);
          for (const range of result.ranges) {
            const stored = db.prepare(`SELECT evidence_sha256 FROM history_ranges
              WHERE manifest_id=? AND kind=? AND source=? AND generation=? AND start=? AND end=?`)
              .get(result.id, range.kind, range.source, range.generation, range.start, range.end);
            if (rangeHash(range, result.customer) !== stored?.evidence_sha256) throw new Error("Corrupt replayed manifest evidence");
          }
          db.exec("COMMIT"); return result;
        }
        const id = db.prepare(`INSERT INTO history_manifests(customer,runtime,epoch,document,sha256,created_at)
          VALUES(?,?,?,?,?,?)`).run(manifest.customer, manifest.runtime, manifest.epoch, document, digest, new Date().toISOString()).lastInsertRowid;
        for (const range of manifest.ranges) {
          const hash = rangeHash(range, manifest.customer);
          const prior = db.prepare(`SELECT r.*,m.customer,m.runtime FROM history_ranges r JOIN history_manifests m ON m.id=r.manifest_id
            WHERE kind=? AND source=? AND generation=?`).all(range.kind, range.source, range.generation);
          if (prior.some((row) => row.customer !== manifest.customer || row.runtime !== manifest.runtime)) {
            throw new Error("History source already bound to another runtime/customer");
          }
          if (prior.some((row) => typeof row.start !== "number" || typeof row.end !== "number" ||
              (row.start < range.end && row.end > range.start))) throw new Error("Manifest ranges overlap or are corrupt");
          db.prepare("INSERT INTO history_ranges VALUES(?,?,?,?,?,?,?)")
            .run(id, range.kind, range.source, range.generation, range.start, range.end, hash);
        }
        const result = readRow(db.prepare("SELECT * FROM history_manifests WHERE id=?").get(id)!);
        db.exec("COMMIT"); return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    list(customer: string, afterId = 0, limit = 100) {
      available(); identifier(customer);
      if (!integer(afterId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid manifest page");
      const rows = db.prepare("SELECT * FROM history_manifests WHERE customer=? AND id>? ORDER BY id LIMIT ?")
        .all(customer, afterId, limit + 1);
      const manifests = rows.slice(0, limit).map(readRow);
      return { manifests, nextAfterId: rows.length > limit ? manifests.at(-1)!.id : null };
    },
    resolve(customer: string, kind: "cel" | "queue", source: string, generation: string, offset: number) {
      available(); identifier(customer); identifier(source); identifier(generation);
      if (!integer(offset)) throw new Error("Invalid evidence offset");
      const ownsTransaction = !db.isTransaction;
      if (ownsTransaction) db.exec("BEGIN");
      try {
        const checkpoint = sourceRow(customer, kind, source, generation);
        const event = db.prepare(`SELECT end_offset,raw,sha256 FROM ${kind === "cel" ? "cel_events" : "queue_events"} WHERE source=? AND generation=? AND offset=?`)
          .get(source, generation, offset);
        if (!event) throw new Error("History record not found at offset");
        if (!integer(event.end_offset) || !integer(checkpoint.consumed_bytes) || event.end_offset <= offset ||
            event.end_offset > checkpoint.consumed_bytes || !(event.raw instanceof Uint8Array) ||
            event.raw.length > HISTORY_RECORD_LIMIT || event.raw.length !== event.end_offset - offset ||
            sha256(event.raw) !== event.sha256) throw new Error("Corrupt history record at offset");
        const rows = db.prepare(`SELECT r.*,m.document,m.sha256,m.created_at,m.customer,m.runtime,m.epoch,m.id
          FROM history_ranges r JOIN history_manifests m ON m.id=r.manifest_id
          WHERE r.kind=? AND r.source=? AND r.generation=? AND r.start<=? AND r.end>?`)
          .all(kind, source, generation, offset, offset);
        if (rows.length > 1) throw new Error("Conflicting stored manifest ranges");
        let assignment = null;
        if (rows.length === 1) {
          const row = rows[0];
          const manifest = readRow(row);
          const range = manifest.ranges.find((range) => range.kind === kind && range.source === source &&
            range.generation === generation && range.start === row.start && range.end === row.end);
          if (manifest.customer !== customer || !range || event.end_offset > range.end ||
              rangeHash(range, customer) !== row.evidence_sha256) throw new Error("Corrupt manifest range assignment");
          assignment = { manifestId: manifest.id, manifestSha256: manifest.sha256, runtime: manifest.runtime,
            epoch: manifest.epoch, routes: manifest.routes, range, evidenceSha256: row.evidence_sha256 };
        }
        if (ownsTransaction) db.exec("COMMIT");
        return { customer, kind, source, generation, offset, assignment, status: assignment ? "assigned" : "unassigned" };
      } catch (error) { if (ownsTransaction) db.exec("ROLLBACK"); throw error; }
    },
  };
}
