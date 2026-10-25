import type { DatabaseSync } from "node:sqlite";
import { HISTORY_SNAPSHOT_LIMIT, HISTORY_RECORD_LIMIT, historySha256 as sha256,
  historyIdentifier as identifier, historyInteger as integer, historyDigest as digest } from "./history-evidence.ts";

export interface QueueSource {
  customer: string;
  source: string;
  generation: string;
}
export interface QueueCheckpoint extends QueueSource {
  kind: "queue";
  timeBasis: "unix";
  consumedBytes: number;
  prefixSha256: string;
  records: number;
}
export interface QueueFields {
  sourceTimestamp: string;
  callId: string;
  queue: string;
  member: string;
  event: string;
  parameters: string[];
}
export interface QueueEvent extends QueueFields {
  offset: number;
  endOffset: number;
  rawRecord: string;
  sha256: string;
  ingestedAt: string;
}
export interface QueueRead extends QueueSource {
  afterOffset?: number;
  limit?: number;
  callId?: string;
}
export class QueuePrefixError extends Error {}
function scope(value: QueueSource) {
  identifier(value.customer); identifier(value.source); identifier(value.generation);
}
function parse(raw: Uint8Array): QueueFields {
  if (raw.byteLength > HISTORY_RECORD_LIMIT) throw new Error("Queue record exceeds 64 KiB");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  if (!text.endsWith("\n")) throw new Error("Queue record requires a complete line terminator");
  const line = text.slice(0, text.endsWith("\r\n") ? -2 : -1);
  if (/[\x00-\x1f\x7f\ufeff]/.test(line)) throw new Error("Invalid queue record control character or BOM");
  const fields = line.split("|");
  if (fields.length < 5 || fields.length > 261 ||
      fields.slice(0, 5).some((field) => !field || field.length > 1024) ||
      !/^[0-9]{1,16}(?:\.[0-9]{1,9})?$/.test(fields[0]) ||
      !/^[A-Z][A-Z0-9_]{0,127}$/.test(fields[4])) {
    throw new Error("Invalid queue record fields, timestamp, event or parameter count (maximum 256)");
  }
  return { sourceTimestamp: fields[0], callId: fields[1], queue: fields[2],
    member: fields[3], event: fields[4], parameters: fields.slice(5) };
}
function checkpoint(row: Record<string, unknown>): QueueCheckpoint {
  if (typeof row.customer !== "string" || typeof row.source !== "string" || typeof row.generation !== "string" ||
      !integer(row.consumed_bytes) || row.consumed_bytes > HISTORY_SNAPSHOT_LIMIT ||
      !digest(row.prefix_sha256) || !integer(row.records)) throw new Error("Invalid stored queue checkpoint");
  const value = { customer: row.customer, source: row.source, generation: row.generation };
  scope(value);
  return { ...value, kind: "queue", timeBasis: "unix", consumedBytes: row.consumed_bytes,
    prefixSha256: row.prefix_sha256, records: row.records };
}
export function createQueueSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE queue_sources (
    source TEXT NOT NULL, generation TEXT NOT NULL, customer TEXT NOT NULL,
    consumed_bytes INTEGER NOT NULL, prefix_sha256 TEXT NOT NULL,
    PRIMARY KEY(source, generation)
  ) STRICT;
  CREATE TABLE queue_events (
    source TEXT NOT NULL, generation TEXT NOT NULL, offset INTEGER NOT NULL, end_offset INTEGER NOT NULL,
    call_id TEXT NOT NULL, raw BLOB NOT NULL, sha256 TEXT NOT NULL, ingested_at TEXT NOT NULL,
    PRIMARY KEY(source,generation,offset),
    FOREIGN KEY(source,generation) REFERENCES queue_sources(source,generation)
  ) STRICT;
  CREATE INDEX queue_call ON queue_events(source,generation,call_id,offset);
  PRAGMA user_version=3;`);
}
export function validateQueueSchema(db: DatabaseSync) {
  db.prepare("SELECT source,generation,customer,consumed_bytes,prefix_sha256 FROM queue_sources LIMIT 0");
  db.prepare("SELECT source,generation,offset,end_offset,call_id,raw,sha256,ingested_at FROM queue_events LIMIT 0");
}
// Shares the owning history connection so schema migration and close stay centralized.
export function createQueueHistory(db: DatabaseSync, enabled: boolean) {
  function available() {
    if (!enabled) throw new Error("Queue evidence requires schema 3; migrate with a trusted history writer");
  }
  function find(source: string, generation: string) {
    return db.prepare(`SELECT s.*, (SELECT count(*) FROM queue_events e
      WHERE e.source=s.source AND e.generation=s.generation) AS records
      FROM queue_sources s WHERE source=? AND generation=?`).get(source, generation);
  }
  function transaction<T>(write: boolean, action: () => T): T {
    if (!write && db.isTransaction) return action();
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  return {
    ingest(source: QueueSource, snapshot: Uint8Array) {
      available(); scope(source);
      if (!(snapshot instanceof Uint8Array) || snapshot.byteLength > HISTORY_SNAPSHOT_LIMIT) {
        throw new Error("Queue snapshot exceeds 8 MiB or is not bytes");
      }
      return transaction(true, () => {
        const row = find(source.source, source.generation);
        const previous = row ? checkpoint(row) : undefined;
        if (previous && previous.customer !== source.customer) throw new Error("Queue source generation is bound to another customer");
        const start = previous?.consumedBytes ?? 0;
        if (snapshot.length < start || (previous && sha256(snapshot.subarray(0, start)) !== previous.prefixSha256)) {
          throw new QueuePrefixError("Queue source prefix changed or truncated; explicitly provision a new generation");
        }
        if (!previous) db.prepare("INSERT INTO queue_sources VALUES (?,?,?,0,?)")
          .run(source.source, source.generation, source.customer, sha256(new Uint8Array()));
        const insert = db.prepare("INSERT INTO queue_events VALUES (?,?,?,?,?,?,?,?)");
        const ingestedAt = new Date().toISOString();
        let offset = start;
        let inserted = 0;
        for (let index = start; index < snapshot.length; index++) {
          if (index - offset >= HISTORY_RECORD_LIMIT) throw new Error("Queue record exceeds 64 KiB");
          if (snapshot[index] !== 10) continue;
          const raw = snapshot.slice(offset, index + 1);
          const fields = parse(raw);
          if (++inserted > 50000) throw new Error("Queue snapshot exceeds 50,000 new records");
          insert.run(source.source, source.generation, offset, index + 1, fields.callId, raw, sha256(raw), ingestedAt);
          offset = index + 1;
        }
        const prefixSha256 = sha256(snapshot.subarray(0, offset));
        db.prepare("UPDATE queue_sources SET consumed_bytes=?,prefix_sha256=? WHERE source=? AND generation=?")
          .run(offset, prefixSha256, source.source, source.generation);
        return { kind: "queue", timeBasis: "unix", customer: source.customer, source: source.source,
          generation: source.generation, inserted, records: (previous?.records ?? 0) + inserted,
          consumedBytes: offset, pendingBytes: snapshot.length - offset, prefixSha256 };
      });
    },
    sources(customer: string, after: { source: string; generation: string } | undefined = undefined, limit = 100) {
      available(); identifier(customer);
      if (after) { identifier(after.source); identifier(after.generation); }
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid queue source page limit");
      const rows = db.prepare(`SELECT s.*, (SELECT count(*) FROM queue_events e
        WHERE e.source=s.source AND e.generation=s.generation) AS records
        FROM queue_sources s WHERE customer=? AND (source,generation)>(?,?)
        ORDER BY source,generation LIMIT ?`).all(customer, after?.source ?? "", after?.generation ?? "", limit + 1);
      const sources = rows.slice(0, limit).map(checkpoint);
      const last = sources.at(-1);
      return { kind: "queue", sources,
        next: rows.length > limit && last ? { source: last.source, generation: last.generation } : null };
    },
    read(query: QueueRead) {
      available(); scope(query);
      const after = query.afterOffset ?? -1;
      const limit = query.limit ?? 100;
      if ((after !== -1 && !integer(after)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200 ||
          (query.callId !== undefined && (typeof query.callId !== "string" || !query.callId ||
            query.callId.length > 1024 || /[\x00-\x1f\x7f]/.test(query.callId)))) throw new Error("Invalid queue event page/call query");
      return transaction(false, () => {
        const row = find(query.source, query.generation);
        if (!row || row.customer !== query.customer) throw new Error("Queue source not found for customer");
        const source = checkpoint(row);
        const rows = db.prepare(`SELECT * FROM queue_events WHERE source=? AND generation=? AND offset>?
          ${query.callId === undefined ? "" : "AND call_id=?"} ORDER BY offset LIMIT ?`)
          .all(query.source, query.generation, after, ...(query.callId === undefined ? [] : [query.callId]), limit + 1);
        const events = rows.slice(0, limit).map((event): QueueEvent => {
          if (!integer(event.offset) || !integer(event.end_offset) || event.end_offset <= event.offset ||
              event.end_offset > source.consumedBytes || !(event.raw instanceof Uint8Array) ||
              event.raw.length !== event.end_offset - event.offset || !digest(event.sha256) ||
              sha256(event.raw) !== event.sha256 || typeof event.ingested_at !== "string" ||
              !Number.isFinite(Date.parse(event.ingested_at)) ||
              new Date(event.ingested_at).toISOString() !== event.ingested_at) throw new Error("Corrupt stored queue evidence");
          const fields = parse(event.raw);
          if (fields.callId !== event.call_id) throw new Error("Corrupt queue call index");
          return { ...fields, offset: event.offset, endOffset: event.end_offset, sha256: event.sha256,
            rawRecord: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(event.raw), ingestedAt: event.ingested_at };
        });
        return { kind: "queue", source, events, nextAfterOffset: rows.length > limit ? events.at(-1)!.offset : null };
      });
    },
  };
}
