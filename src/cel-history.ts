import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const CEL_SNAPSHOT_LIMIT = 8 * 1024 * 1024;
const recordLimit = 64 * 1024;
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
const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) {
    throw new Error("CEL scope requires bounded lowercase customer/source/generation identifiers");
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
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function digest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
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
      } else if (version !== 1 || identity !== applicationId) {
        throw new Error("Not a supported CEL history database");
      }
      db.prepare("SELECT source, generation, customer, time_basis, consumed_bytes, prefix_sha256 FROM cel_sources LIMIT 0");
      db.prepare("SELECT source, generation, offset, end_offset, uniqueid, raw, sha256, ingested_at FROM cel_events LIMIT 0");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } catch (error) { db.close(); throw error; }
  const find = db.prepare(`SELECT s.*, (SELECT count(*) FROM cel_events e
    WHERE e.source=s.source AND e.generation=s.generation) AS records
    FROM cel_sources s WHERE source=? AND generation=?`);
  return {
    ingest(source: CelSource, snapshot: Uint8Array) {
      sourceInput(source);
      if (!(snapshot instanceof Uint8Array) || snapshot.byteLength > CEL_SNAPSHOT_LIMIT) {
        throw new Error("CEL snapshot exceeds 8 MiB or is not bytes");
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = find.get(source.source, source.generation);
        const previous = row ? checkpoint(row) : undefined;
        if (previous && (previous.customer !== source.customer || previous.timeBasis !== source.timeBasis)) {
          throw new Error("CEL source generation is already bound to another customer/time basis");
        }
        const start = previous?.consumedBytes ?? 0;
        if (snapshot.length < start || (previous && sha256(snapshot.subarray(0, start)) !== previous.prefixSha256)) {
          throw new Error("CEL source prefix changed or truncated; explicitly provision a new generation");
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
        db.exec("COMMIT");
        return { ...source, inserted: parsed.records.length, records: (previous?.records ?? 0) + parsed.records.length,
          consumedBytes: parsed.consumed, pendingBytes: snapshot.length - parsed.consumed, prefixSha256 };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
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
