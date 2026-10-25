import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HISTORY_SNAPSHOT_LIMIT, HISTORY_RECORD_LIMIT, historySha256 as sha256,
  historyIdentifier as identifier, historyInteger as integer, historyDigest as digest } from "./history-evidence.ts";
import { createQueueHistory, createQueueSchema, validateQueueSchema } from "./queue-history.ts";
import { createHistoryManifests, createManifestSchema, validateManifestSchema } from "./history-manifest.ts";

export const CEL_SNAPSHOT_LIMIT = HISTORY_SNAPSHOT_LIMIT;
const recordLimit = HISTORY_RECORD_LIMIT;
const applicationId = 0x43454c48;
const names = ["event", "sourceTimestamp", "channel", "uniqueid", "linkedid", "context", "extension", "extra"] as const;
export type CelFields = Record<typeof names[number], string>;
export interface CelSource {
  customer: string;
  source: string;
  generation: string;
  timeBasis: string;
}
export interface CelCheckpoint extends CelSource {
  consumedBytes: number;
  prefixSha256: string;
  records: number;
}
export interface CelEvent extends CelFields {
  offset: number;
  endOffset: number;
  rawRecord: string;
  sha256: string;
  ingestedAt: string;
}
export interface CelRead {
  customer: string;
  source: string;
  generation: string;
  afterOffset?: number;
  limit?: number;
  uniqueid?: string;
}
export class CelPrefixError extends Error {}
export class CelAttemptConflict extends Error {}
export interface CelCollectorConfig extends CelSource {
  path: string;
  staleAfterMs: number;
}
type CollectionOutcome = "never" | "collecting" | "success" | "failure";
export type CelCollectionFailure = "source-unavailable" | "prefix-discontinuity" | "collection-failed";
interface CollectorRow extends CelCollectorConfig {
  revision: number;
  updatedAt: number;
  outcome: CollectionOutcome;
  attemptedAt: number | null;
  succeededAt: number | null;
  failure: CelCollectionFailure | null;
  pendingBytes: number;
}
function collectorConfig(value: CelCollectorConfig) {
  sourceInput(value);
  if (typeof value.path !== "string" || !isAbsolute(value.path) || value.path.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(value.path) || !Number.isSafeInteger(value.staleAfterMs) ||
      value.staleAfterMs < 1000 || value.staleAfterMs > 86400000) {
    throw new Error("CEL collector requires an absolute local path and freshness threshold of 1s to 24h");
  }
}
function collectorRow(row: Record<string, unknown>): CollectorRow {
  const config = { customer: row.customer, source: row.source, generation: row.generation,
    timeBasis: row.time_basis, path: row.path, staleAfterMs: row.stale_after_ms };
  if (typeof config.customer !== "string" || typeof config.source !== "string" ||
      typeof config.generation !== "string" || typeof config.timeBasis !== "string" ||
      typeof config.path !== "string" || typeof config.staleAfterMs !== "number" ||
      !integer(row.revision) || !integer(row.updated_at) || !["never", "collecting", "success", "failure"].includes(String(row.outcome)) ||
      (row.attempted_at !== null && !integer(row.attempted_at)) ||
      (row.succeeded_at !== null && !integer(row.succeeded_at)) ||
      !integer(row.pending_bytes) || row.pending_bytes > CEL_SNAPSHOT_LIMIT ||
      (row.failure !== null && !["source-unavailable", "prefix-discontinuity", "collection-failed"].includes(String(row.failure)))) {
    throw new Error("Invalid stored CEL collector");
  }
  const outcome = row.outcome as CollectionOutcome;
  const attemptedAt = row.attempted_at as number | null;
  const succeededAt = row.succeeded_at as number | null;
  if ((outcome === "never" && (attemptedAt !== null || succeededAt !== null || row.failure !== null)) ||
      (outcome !== "never" && attemptedAt === null) ||
      (outcome === "success" && (succeededAt !== row.updated_at || row.failure !== null)) ||
      (outcome === "failure") !== (row.failure !== null) ||
      (succeededAt !== null && (attemptedAt === null || succeededAt > row.updated_at ||
        (outcome === "success" ? succeededAt < attemptedAt : succeededAt > attemptedAt))) ||
      (attemptedAt !== null && attemptedAt > row.updated_at)) {
    throw new Error("Inconsistent stored CEL collector state");
  }
  const value = { customer: config.customer, source: config.source, generation: config.generation,
    timeBasis: config.timeBasis, path: config.path, staleAfterMs: config.staleAfterMs };
  collectorConfig(value);
  return { ...value, revision: row.revision, updatedAt: row.updated_at, outcome, attemptedAt, succeededAt,
    failure: row.failure as CelCollectionFailure | null, pendingBytes: row.pending_bytes };
}
function timestamp(value: number) {
  if (!integer(value) || value > 8640000000000000) throw new Error("Invalid CEL collection timestamp");
}
function transitionContext(operator: string, reason: string) {
  for (const [text, maximum] of [[operator, 200], [reason, 2000]] as const) {
    if (typeof text !== "string" || !text.trim() || text.length > maximum || /[\x00-\x1f\x7f]/.test(text)) {
      throw new Error("CEL transition requires a bounded operator reference and reason");
    }
  }
}
function sourceInput(value: CelSource) {
  identifier(value.customer); identifier(value.source); identifier(value.generation);
  if (typeof value.timeBasis !== "string" || value.timeBasis.length > 100 || !value.timeBasis.trim()) {
    throw new Error("CEL source requires an explicit IANA time basis (or UTC)");
  }
  // Validate the operator declaration; source timestamps remain original text.
  new Intl.DateTimeFormat("en-GB", { timeZone: value.timeBasis });
}
function parseRecord(raw: Uint8Array): CelFields {
  if (raw.byteLength > recordLimit) throw new Error("CEL record exceeds 64 KiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (!text.endsWith("\n")) throw new Error("CEL record requires a complete line terminator");
  const line = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
  const fields: string[] = [];
  let field = "";
  let state: "start" | "plain" | "quoted" | "closed" = "start";
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (state === "quoted") {
      if (char === '"') {
        if (line[index + 1] === '"') { field += '"'; index++; }
        else state = "closed";
      } else field += char;
    } else if (char === ",") {
      fields.push(field); field = ""; state = "start";
    } else if (state === "start" && char === '"') {
      state = "quoted";
    } else if (state === "closed" || char === '"' || char === "\r" || char === "\n") {
      throw new Error("Malformed CEL CSV quoting");
    } else {
      state = "plain"; field += char;
    }
  }
  if (state === "quoted") throw new Error("Unterminated CEL CSV quote");
  fields.push(field);
  if (fields.length !== names.length || fields.some((value, index) =>
    index < 7 ? value.length > 1024 || /[\x00-\x1f\x7f]/.test(value) : /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) ||
      !fields[0] || !fields[1] || !fields[2] || !fields[3] || !fields[4]) {
    throw new Error("Invalid eight-field CEL evidence record");
  }
  return { event: fields[0], sourceTimestamp: fields[1], channel: fields[2], uniqueid: fields[3],
    linkedid: fields[4], context: fields[5], extension: fields[6], extra: fields[7] };
}
function completeRecords(bytes: Uint8Array, start: number) {
  const records: { offset: number; end: number; raw: Uint8Array; fields: CelFields }[] = [];
  let offset = start;
  let state: "start" | "plain" | "quoted" | "closed" | "cr" = "start";
  for (let index = start; index < bytes.length; index++) {
    if (index - offset >= recordLimit) throw new Error("CEL record exceeds 64 KiB");
    const byte = bytes[index];
    if (state === "quoted") {
      if (byte === 34) state = "closed";
      continue;
    }
    if (state === "cr" && byte !== 10) throw new Error("Malformed CEL CSV line terminator");
    if (byte === 34) {
      if (state !== "start" && state !== "closed") throw new Error("Malformed CEL CSV quoting");
      state = "quoted";
    } else if (byte === 10) {
      const raw = bytes.slice(offset, index + 1);
      records.push({ offset, end: index + 1, raw, fields: parseRecord(raw) });
      if (records.length > 50000) throw new Error("CEL snapshot exceeds 50,000 new records");
      offset = index + 1;
      state = "start";
    } else if (byte === 13) {
      state = "cr";
    } else if (byte === 44) {
      state = "start";
    } else if (state === "closed") {
      throw new Error("Malformed CEL CSV quoting");
    } else {
      state = "plain";
    }
  }
  return { records, consumed: offset };
}
function checkpoint(row: Record<string, unknown>): CelCheckpoint {
  const value = { customer: row.customer, source: row.source, generation: row.generation, timeBasis: row.time_basis };
  if (typeof value.customer !== "string" || typeof value.source !== "string" ||
      typeof value.generation !== "string" || typeof value.timeBasis !== "string" ||
      !integer(row.consumed_bytes) || !digest(row.prefix_sha256) || !integer(row.records)) {
    throw new Error("Invalid stored CEL source checkpoint");
  }
  sourceInput({ customer: value.customer, source: value.source, generation: value.generation, timeBasis: value.timeBasis });
  return { customer: value.customer, source: value.source, generation: value.generation,
    timeBasis: value.timeBasis, consumedBytes: row.consumed_bytes, prefixSha256: row.prefix_sha256, records: row.records };
}

export function openCelHistory(path: string, options: { readOnly?: boolean } = {}) {
  if (!isAbsolute(path)) throw new Error("CEL history requires an absolute dedicated database path");
  const db = new DatabaseSync(path, { readOnly: options.readOnly === true });
  try {
    db.exec("PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    if (!options.readOnly) db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;");
    db.exec(options.readOnly ? "BEGIN" : "BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get()?.user_version;
      const identity = db.prepare("PRAGMA application_id").get()?.application_id;
      if (version === 0 && identity === 0 && !options.readOnly &&
          !db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()) {
        db.exec(`CREATE TABLE cel_sources (
          source TEXT NOT NULL, generation TEXT NOT NULL, customer TEXT NOT NULL, time_basis TEXT NOT NULL,
          consumed_bytes INTEGER NOT NULL, prefix_sha256 TEXT NOT NULL,
          PRIMARY KEY(source, generation)
        ) STRICT;
        CREATE TABLE cel_events (
          source TEXT NOT NULL, generation TEXT NOT NULL, offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
          uniqueid TEXT NOT NULL, raw BLOB NOT NULL, sha256 TEXT NOT NULL, ingested_at TEXT NOT NULL,
          PRIMARY KEY(source, generation, offset),
          FOREIGN KEY(source, generation) REFERENCES cel_sources(source, generation)
        ) STRICT;
        CREATE INDEX cel_channel ON cel_events(source, generation, uniqueid, offset);
        PRAGMA application_id = ${applicationId}; PRAGMA user_version = 1;`);
      } else if (![1, 2, 3, 4].includes(Number(version)) || identity !== applicationId) {
        throw new Error("Not a supported CEL history database");
      }
      if (!options.readOnly && version !== 2 && version !== 3 && version !== 4) {
        db.exec(`CREATE TABLE cel_collectors (
          source TEXT PRIMARY KEY, customer TEXT NOT NULL, generation TEXT NOT NULL,
          time_basis TEXT NOT NULL, path TEXT NOT NULL, stale_after_ms INTEGER NOT NULL,
          revision INTEGER NOT NULL, updated_at INTEGER NOT NULL, outcome TEXT NOT NULL, attempted_at INTEGER, succeeded_at INTEGER,
          failure TEXT, pending_bytes INTEGER NOT NULL,
          FOREIGN KEY(source, generation) REFERENCES cel_sources(source, generation)
        ) STRICT;
        CREATE TABLE cel_collection_gaps (
          id INTEGER PRIMARY KEY, customer TEXT NOT NULL, source TEXT NOT NULL,
          from_generation TEXT NOT NULL, to_generation TEXT NOT NULL,
          last_success_at INTEGER, observed_at INTEGER NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL
        ) STRICT;
        CREATE INDEX cel_gap_scope ON cel_collection_gaps(customer, source, id);
        PRAGMA user_version = 2;`);
      }
      db.prepare("SELECT source, generation, customer, time_basis, consumed_bytes, prefix_sha256 FROM cel_sources LIMIT 0");
      db.prepare("SELECT source, generation, offset, end_offset, uniqueid, raw, sha256, ingested_at FROM cel_events LIMIT 0");
      if (!options.readOnly || version === 2 || version === 3 || version === 4) {
        db.prepare(`SELECT source,customer,generation,time_basis,path,stale_after_ms,revision,updated_at,
          outcome,attempted_at,succeeded_at,failure,pending_bytes FROM cel_collectors LIMIT 0`);
        db.prepare(`SELECT id,customer,source,from_generation,to_generation,last_success_at,observed_at,
          operator,reason FROM cel_collection_gaps LIMIT 0`);
      }
      if (!options.readOnly && version !== 3 && version !== 4) createQueueSchema(db);
      if (!options.readOnly || version === 3 || version === 4) validateQueueSchema(db);
      if (!options.readOnly && version !== 4) createManifestSchema(db);
      if (!options.readOnly || version === 4) validateManifestSchema(db);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { db.close(); throw error; }
  const find = db.prepare(`SELECT s.*, (SELECT count(*) FROM cel_events e
    WHERE e.source=s.source AND e.generation=s.generation) AS records
    FROM cel_sources s WHERE source=? AND generation=?`);
  const schemaVersion = db.prepare("PRAGMA user_version").get()?.user_version;
  const hasCollectors = schemaVersion === 2 || schemaVersion === 3 || schemaVersion === 4;
  function getCollector(customer: string, source: string) {
    identifier(customer); identifier(source);
    if (!hasCollectors) throw new Error("CEL collector requires schema 2; migrate with a trusted writer");
    const row = db.prepare("SELECT * FROM cel_collectors WHERE customer=? AND source=?").get(customer, source);
    if (!row) throw new Error("CEL collector not found for customer");
    const result = collectorRow(row);
    if (result.customer !== customer || result.source !== source) throw new Error("CEL collector scope mismatch");
    return result;
  }
  function transaction<T>(action: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function ensureSource(source: CelSource) {
    const row = find.get(source.source, source.generation);
    if (row) {
      const previous = checkpoint(row);
      if (previous.customer !== source.customer || previous.timeBasis !== source.timeBasis) {
        throw new Error("CEL source generation is already bound to another customer/time basis");
      }
    } else {
      db.prepare("INSERT INTO cel_sources VALUES (?, ?, ?, ?, 0, ?)").run(
        source.source, source.generation, source.customer, source.timeBasis, sha256(new Uint8Array()));
    }
  }
  function ingest(source: CelSource, snapshot: Uint8Array) {
    sourceInput(source);
    if (!(snapshot instanceof Uint8Array) || snapshot.byteLength > CEL_SNAPSHOT_LIMIT) {
      throw new Error("CEL snapshot exceeds 8 MiB or is not bytes");
    }
    const row = find.get(source.source, source.generation);
    const previous = row ? checkpoint(row) : undefined;
    if (previous && (previous.customer !== source.customer || previous.timeBasis !== source.timeBasis)) {
      throw new Error("CEL source generation is already bound to another customer/time basis");
    }
    const start = previous?.consumedBytes ?? 0;
    if (snapshot.length < start || (previous && sha256(snapshot.subarray(0, start)) !== previous.prefixSha256)) {
      throw new CelPrefixError("CEL source prefix changed or truncated; explicitly provision a new generation");
    }
    const parsed = completeRecords(snapshot, start);
    if (!previous) {
      db.prepare("INSERT INTO cel_sources VALUES (?, ?, ?, ?, 0, ?)").run(
        source.source, source.generation, source.customer, source.timeBasis, sha256(new Uint8Array()));
    }
    const insertedAt = new Date().toISOString();
    const insert = db.prepare("INSERT INTO cel_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
    for (const record of parsed.records) {
      insert.run(source.source, source.generation, record.offset, record.end,
        record.fields.uniqueid, record.raw, sha256(record.raw), insertedAt);
    }
    const prefixSha256 = sha256(snapshot.subarray(0, parsed.consumed));
    db.prepare("UPDATE cel_sources SET consumed_bytes=?, prefix_sha256=? WHERE source=? AND generation=?")
      .run(parsed.consumed, prefixSha256, source.source, source.generation);
    return { customer: source.customer, source: source.source, generation: source.generation, timeBasis: source.timeBasis,
      inserted: parsed.records.length, records: (previous?.records ?? 0) + parsed.records.length,
      consumedBytes: parsed.consumed, pendingBytes: snapshot.length - parsed.consumed, prefixSha256 };
  }
  function attempt(customer: string, source: string, revision: number) {
    const current = getCollector(customer, source);
    if (current.revision !== revision || current.outcome !== "collecting") {
      throw new CelAttemptConflict("CEL collection attempt superseded or already completed");
    }
    return current;
  }
  return {
    queue: createQueueHistory(db, schemaVersion === 3 || schemaVersion === 4),
    manifests: createHistoryManifests(db, schemaVersion === 4, options.readOnly === true),
    ingest(source: CelSource, snapshot: Uint8Array) {
      return transaction(() => ingest(source, snapshot));
    },
    configureCollector(config: CelCollectorConfig, now = Date.now()) {
      collectorConfig(config); timestamp(now);
      return transaction(() => {
        const row = db.prepare("SELECT * FROM cel_collectors WHERE source=?").get(config.source);
        if (row) {
          const current = collectorRow(row);
          if (current.customer !== config.customer || current.generation !== config.generation ||
              current.timeBasis !== config.timeBasis || current.path !== config.path ||
              current.staleAfterMs !== config.staleAfterMs) throw new Error("CEL collector configuration is immutable; only generation can transition explicitly");
          return current;
        }
        ensureSource(config);
        db.prepare("INSERT INTO cel_collectors VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'never', NULL, NULL, NULL, 0)")
          .run(config.source, config.customer, config.generation, config.timeBasis, config.path, config.staleAfterMs, now);
        return getCollector(config.customer, config.source);
      });
    },
    beginCollection(customer: string, source: string, now = Date.now()) {
      timestamp(now);
      return transaction(() => {
        const current = getCollector(customer, source);
        if (now < current.updatedAt) throw new Error("CEL collection clock moved backwards");
        if (!Number.isSafeInteger(current.revision + 1)) throw new Error("CEL collection revision exhausted");
        db.prepare(`UPDATE cel_collectors SET revision=revision+1, outcome='collecting', attempted_at=?, updated_at=?, failure=NULL
          WHERE source=?`).run(now, now, source);
        return getCollector(customer, source);
      });
    },
    completeCollection(customer: string, source: string, revision: number, bytes: Uint8Array, now = Date.now()) {
      timestamp(now);
      return transaction(() => {
        const current = attempt(customer, source, revision);
        if (now < current.updatedAt) throw new Error("CEL collection clock moved backwards");
        const result = ingest(current, bytes);
        db.prepare(`UPDATE cel_collectors SET outcome='success', succeeded_at=?, updated_at=?, failure=NULL,
          pending_bytes=? WHERE source=?`).run(now, now, result.pendingBytes, source);
        return { ...result, revision };
      });
    },
    failCollection(customer: string, source: string, revision: number, failure: CelCollectionFailure, now = Date.now()) {
      timestamp(now);
      if (!["source-unavailable", "prefix-discontinuity", "collection-failed"].includes(failure)) throw new Error("Invalid CEL failure code");
      return transaction(() => {
        const current = attempt(customer, source, revision);
        if (now < current.updatedAt) throw new Error("CEL collection clock moved backwards");
        db.prepare("UPDATE cel_collectors SET outcome='failure', updated_at=?, failure=? WHERE source=?")
          .run(now, failure, source);
      });
    },
    collectorStatus(customer: string, source: string, now = Date.now()) {
      timestamp(now);
      db.exec("BEGIN");
      try {
        const current = getCollector(customer, source);
        const ageMs = current.succeededAt === null ? null : now - current.succeededAt;
        const clockSkew = now < current.updatedAt;
        const status = clockSkew ? "clock-skew" : current.outcome === "never" ? "never-collected" :
          current.outcome === "failure" ? "unhealthy" : current.outcome === "collecting" ?
            now - current.attemptedAt! >= current.staleAfterMs ? "stale" : "collecting" :
            ageMs! >= current.staleAfterMs ? "stale" : current.pendingBytes > 0 ? "pending" : "healthy";
        const gapCount = db.prepare("SELECT count(*) AS count FROM cel_collection_gaps WHERE customer=? AND source=?")
          .get(customer, source)?.count;
        if (!integer(gapCount)) throw new Error("Invalid CEL gap count");
        const row = find.get(source, current.generation);
        if (!row) throw new Error("Missing CEL collector checkpoint");
        const result = { ...current, status, ageMs, gapCount, coverage: gapCount > 0 ? "unknown-gap-recorded" : "unverified",
          checkpoint: checkpoint(row) };
        if (result.checkpoint.customer !== customer || result.checkpoint.timeBasis !== current.timeBasis) throw new Error("CEL collector scope mismatch");
        db.exec("COMMIT");
        return result;
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    transitionCollector(customer: string, source: string, generation: string, operator: string, reason: string, now = Date.now()) {
      identifier(generation); timestamp(now);
      transitionContext(operator, reason);
      return transaction(() => {
        const current = getCollector(customer, source);
        if (now < current.updatedAt) throw new Error("CEL transition clock moved backwards");
        if (find.get(source, generation)) throw new Error("CEL transition requires a fresh unused generation");
        if (!Number.isSafeInteger(current.revision + 1)) throw new Error("CEL collection revision exhausted");
        ensureSource({ ...current, generation });
        const gap = db.prepare(`INSERT INTO cel_collection_gaps
          (customer,source,from_generation,to_generation,last_success_at,observed_at,operator,reason)
          VALUES (?,?,?,?,?,?,?,?)`).run(customer, source, current.generation, generation,
            current.succeededAt, now, operator, reason);
        db.prepare(`UPDATE cel_collectors SET generation=?, revision=revision+1, updated_at=?, outcome='never',
          attempted_at=NULL, succeeded_at=NULL, failure=NULL, pending_bytes=0 WHERE source=?`).run(generation, now, source);
        return { gapId: Number(gap.lastInsertRowid), coverage: "unknown-gap-recorded", previousGeneration: current.generation, generation };
      });
    },
    collectionGaps(customer: string, source: string, afterId = 0, limit = 100) {
      getCollector(customer, source);
      if (!integer(afterId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid CEL gap page");
      const rows = db.prepare(`SELECT * FROM cel_collection_gaps WHERE customer=? AND source=? AND id>?
        ORDER BY id LIMIT ?`).all(customer, source, afterId, limit + 1);
      const gaps = rows.slice(0, limit).map((row) => {
        if (!integer(row.id) || row.id === 0 || row.customer !== customer || row.source !== source ||
            typeof row.from_generation !== "string" || typeof row.to_generation !== "string" ||
            !integer(row.observed_at) || (row.last_success_at !== null && !integer(row.last_success_at)) ||
            typeof row.operator !== "string" || typeof row.reason !== "string" || !row.operator.trim() || !row.reason.trim()) {
          throw new Error("Invalid stored CEL collection gap");
        }
        identifier(row.from_generation); identifier(row.to_generation);
        timestamp(row.observed_at);
        if (row.from_generation === row.to_generation ||
            (row.last_success_at !== null && row.last_success_at > row.observed_at)) throw new Error("Invalid stored CEL gap interval");
        transitionContext(row.operator, row.reason);
        return { id: row.id, customer, source, previousGeneration: row.from_generation, generation: row.to_generation,
          lastSuccessAt: row.last_success_at, observedAt: row.observed_at, operator: row.operator, reason: row.reason,
          coverage: "unknown" };
      });
      return { gaps, nextAfterId: rows.length > limit ? gaps.at(-1)!.id : null };
    },
    sources(customer: string, after: { source: string; generation: string } | undefined = undefined, limit = 100) {
      identifier(customer);
      if (after) { identifier(after.source); identifier(after.generation); }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid CEL source page limit");
      const rows = db.prepare(`SELECT s.*, (SELECT count(*) FROM cel_events e
        WHERE e.source=s.source AND e.generation=s.generation) AS records
        FROM cel_sources s WHERE customer=? AND (source, generation) > (?, ?)
        ORDER BY source, generation LIMIT ?`).all(customer, after?.source ?? "", after?.generation ?? "", limit + 1);
      const sources = rows.slice(0, limit).map(checkpoint);
      const last = sources.at(-1);
      return { sources, next: rows.length > limit && last ? { source: last.source, generation: last.generation } : null };
    },
    read(query: CelRead) {
      identifier(query.customer); identifier(query.source); identifier(query.generation);
      const limit = query.limit ?? 100;
      const after = query.afterOffset ?? -1;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
          (after !== -1 && !integer(after)) || (query.uniqueid !== undefined &&
            (typeof query.uniqueid !== "string" || !query.uniqueid || query.uniqueid.length > 1024 ||
              /[\x00-\x1f\x7f]/.test(query.uniqueid)))) throw new Error("Invalid CEL history page/channel query");
      db.exec("BEGIN");
      try {
        const row = find.get(query.source, query.generation);
        if (!row || row.customer !== query.customer) throw new Error("CEL source not found for customer");
        const source = checkpoint(row);
        const rows = db.prepare(`SELECT * FROM cel_events WHERE source=? AND generation=? AND offset>?
          ${query.uniqueid === undefined ? "" : "AND uniqueid=?"} ORDER BY offset LIMIT ?`)
          .all(query.source, query.generation, after, ...(query.uniqueid === undefined ? [] : [query.uniqueid]), limit + 1);
        const hasMore = rows.length > limit;
        const events = rows.slice(0, limit).map((event): CelEvent => {
          if (!integer(event.offset) || !integer(event.end_offset) || event.end_offset <= event.offset ||
              event.end_offset > source.consumedBytes || !(event.raw instanceof Uint8Array) ||
              event.raw.length !== event.end_offset - event.offset || !digest(event.sha256) ||
              sha256(event.raw) !== event.sha256 || typeof event.ingested_at !== "string" ||
              !Number.isFinite(Date.parse(event.ingested_at)) ||
              new Date(event.ingested_at).toISOString() !== event.ingested_at) {
            throw new Error("Corrupt stored CEL evidence");
          }
          const fields = parseRecord(event.raw);
          if (fields.uniqueid !== event.uniqueid) throw new Error("Corrupt CEL channel index");
          return { ...fields, offset: event.offset, endOffset: event.end_offset, sha256: event.sha256,
            rawRecord: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(event.raw), ingestedAt: event.ingested_at };
        });
        db.exec("COMMIT");
        return { source, events, nextAfterOffset: hasMore ? events.at(-1)!.offset : null };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    close() { db.close(); },
  };
}
