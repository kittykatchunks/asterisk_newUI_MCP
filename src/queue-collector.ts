import type { DatabaseSync } from "node:sqlite";
import type { openCelHistory } from "./cel-history.ts";
import { QueuePrefixError, type QueueSource, type QueueCheckpoint } from "./queue-history.ts";
import { historyIdentifier as identifier, historyInteger as integer } from "./history-evidence.ts";
import { collectionFileConfig, collectionTimestamp as timestamp, collectionTransitionContext as transitionContext,
  collectionState, collectionHealth, collectHistoryOnce, type HistoryCollectionFailure } from "./history-collection.ts";

export interface QueueCollectorConfig extends QueueSource { path: string; staleAfterMs: number }
export class QueueAttemptConflict extends Error {}
export function createQueueCollectorSchema(db: DatabaseSync) {
  db.exec(`CREATE TABLE queue_collectors (
    source TEXT PRIMARY KEY, customer TEXT NOT NULL, generation TEXT NOT NULL,
    path TEXT NOT NULL, stale_after_ms INTEGER NOT NULL, revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, outcome TEXT NOT NULL, attempted_at INTEGER, succeeded_at INTEGER,
    failure TEXT, pending_bytes INTEGER NOT NULL,
    FOREIGN KEY(source,generation) REFERENCES queue_sources(source,generation)
  ) STRICT;
  CREATE TABLE queue_collection_gaps (
    id INTEGER PRIMARY KEY, customer TEXT NOT NULL, source TEXT NOT NULL,
    from_generation TEXT NOT NULL, to_generation TEXT NOT NULL,
    last_success_at INTEGER, observed_at INTEGER NOT NULL, operator TEXT NOT NULL, reason TEXT NOT NULL
  ) STRICT;
  CREATE INDEX queue_gap_scope ON queue_collection_gaps(customer,source,id);
  PRAGMA user_version=5;`);
}
export function validateQueueCollectorSchema(db: DatabaseSync) {
  db.prepare(`SELECT source,customer,generation,path,stale_after_ms,revision,updated_at,outcome,
    attempted_at,succeeded_at,failure,pending_bytes FROM queue_collectors LIMIT 0`);
  db.prepare(`SELECT id,customer,source,from_generation,to_generation,last_success_at,observed_at,
    operator,reason FROM queue_collection_gaps LIMIT 0`);
}
function config(value: QueueCollectorConfig) {
  identifier(value.customer); identifier(value.source); identifier(value.generation);
  collectionFileConfig(value.path, value.staleAfterMs);
}
function stored(row: Record<string, unknown>) {
  const { source, customer, generation, path, stale_after_ms: staleAfterMs } = row;
  identifier(source); identifier(customer); identifier(generation);
  if (typeof path !== "string" || typeof staleAfterMs !== "number") throw new Error("Invalid stored queue collector configuration");
  collectionFileConfig(path, staleAfterMs);
  return { kind: "queue" as const, timeBasis: "unix" as const, source, customer, generation, path, staleAfterMs, ...collectionState(row) };
}
export function createQueueCollectors<T extends { pendingBytes: number }>(
  db: DatabaseSync, enabled: boolean, readOnly: boolean,
  adapter: { ensureSource: (source: QueueSource) => void; checkpoint: (customer: string, source: string, generation: string) => QueueCheckpoint;
    ingest: (source: QueueSource, bytes: Uint8Array) => T },
) {
  function available() { if (!enabled) throw new Error("Queue collectors require schema 5; migrate with a trusted history writer"); }
  function get(customer: string, source: string) {
    available(); identifier(customer); identifier(source);
    const row = db.prepare("SELECT * FROM queue_collectors WHERE customer=? AND source=?").get(customer, source);
    if (!row) throw new Error("Queue collector not found for customer");
    const current = stored(row);
    if (current.customer !== customer || current.source !== source) throw new Error("Queue collector scope mismatch");
    adapter.checkpoint(customer, source, current.generation);
    return current;
  }
  function transaction<R>(write: boolean, action: () => R): R {
    if (write && readOnly) throw new Error("Queue collection mutation requires a writable history store");
    if (!write && db.isTransaction) return action();
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  function attempt(customer: string, source: string, revision: number) {
    const current = get(customer, source);
    if (current.revision !== revision || current.outcome !== "collecting") throw new QueueAttemptConflict("Queue collection attempt superseded or already completed");
    return current;
  }
  return {
    supported: enabled,
    configure(value: QueueCollectorConfig, now = Date.now()) {
      available(); config(value); timestamp(now);
      return transaction(true, () => {
        const row = db.prepare("SELECT * FROM queue_collectors WHERE source=?").get(value.source);
        if (row) {
          const current = get(value.customer, value.source);
          if (current.generation !== value.generation || current.path !== value.path || current.staleAfterMs !== value.staleAfterMs) {
            throw new Error("Queue collector configuration is immutable; only generation can transition explicitly");
          }
          return current;
        }
        adapter.ensureSource(value);
        db.prepare("INSERT INTO queue_collectors VALUES(?,?,?,?,?,0,?,'never',NULL,NULL,NULL,0)")
          .run(value.source, value.customer, value.generation, value.path, value.staleAfterMs, now);
        return get(value.customer, value.source);
      });
    },
    begin(customer: string, source: string, now = Date.now()) {
      available(); timestamp(now);
      return transaction(true, () => {
        const current = get(customer, source);
        if (now < current.updatedAt) throw new Error("Queue collection clock moved backwards");
        if (!Number.isSafeInteger(current.revision + 1)) throw new Error("Queue collection revision exhausted");
        db.prepare("UPDATE queue_collectors SET revision=revision+1,outcome='collecting',attempted_at=?,updated_at=?,failure=NULL WHERE source=?")
          .run(now, now, source);
        return get(customer, source);
      });
    },
    complete(customer: string, source: string, revision: number, bytes: Uint8Array, now = Date.now()) {
      available(); timestamp(now);
      return transaction(true, () => {
        const current = attempt(customer, source, revision);
        if (now < current.updatedAt) throw new Error("Queue collection clock moved backwards");
        const result = adapter.ingest(current, bytes);
        db.prepare("UPDATE queue_collectors SET outcome='success',succeeded_at=?,updated_at=?,failure=NULL,pending_bytes=? WHERE source=?")
          .run(now, now, result.pendingBytes, source);
        return { ...result, revision };
      });
    },
    fail(customer: string, source: string, revision: number, failure: HistoryCollectionFailure, now = Date.now()) {
      available(); timestamp(now);
      if (!["source-unavailable", "prefix-discontinuity", "collection-failed"].includes(failure)) throw new Error("Invalid queue collection failure code");
      return transaction(true, () => {
        const current = attempt(customer, source, revision);
        if (now < current.updatedAt) throw new Error("Queue collection clock moved backwards");
        db.prepare("UPDATE queue_collectors SET outcome='failure',updated_at=?,failure=? WHERE source=?").run(now, failure, source);
      });
    },
    status(customer: string, source: string, now = Date.now()) {
      available(); timestamp(now);
      return transaction(false, () => {
        const current = get(customer, source);
        const count = db.prepare("SELECT count(*) AS count FROM queue_collection_gaps WHERE customer=? AND source=?").get(customer, source)?.count;
        if (!integer(count)) throw new Error("Invalid queue collection gap count");
        return { ...current, ...collectionHealth(current, now), gapCount: count,
          coverage: count > 0 ? "unknown-gap-recorded" : "unverified",
          checkpoint: adapter.checkpoint(customer, source, current.generation) };
      });
    },
    transition(customer: string, source: string, generation: string, operator: string, reason: string, now = Date.now()) {
      available(); identifier(generation); timestamp(now); transitionContext(operator, reason);
      return transaction(true, () => {
        const current = get(customer, source);
        if (now < current.updatedAt) throw new Error("Queue transition clock moved backwards");
        if (!Number.isSafeInteger(current.revision + 1)) throw new Error("Queue collection revision exhausted");
        if (db.prepare("SELECT source FROM queue_sources WHERE source=? AND generation=?").get(source, generation)) {
          throw new Error("Queue transition requires a fresh unused generation");
        }
        adapter.ensureSource({ customer, source, generation });
        const gap = db.prepare(`INSERT INTO queue_collection_gaps
          (customer,source,from_generation,to_generation,last_success_at,observed_at,operator,reason) VALUES(?,?,?,?,?,?,?,?)`)
          .run(customer, source, current.generation, generation, current.succeededAt, now, operator, reason);
        db.prepare(`UPDATE queue_collectors SET generation=?,revision=revision+1,updated_at=?,outcome='never',
          attempted_at=NULL,succeeded_at=NULL,failure=NULL,pending_bytes=0 WHERE source=?`).run(generation, now, source);
        return { kind: "queue", gapId: Number(gap.lastInsertRowid), coverage: "unknown-gap-recorded",
          previousGeneration: current.generation, generation };
      });
    },
    sources(customer: string) {
      available(); identifier(customer);
      const rows = db.prepare("SELECT source FROM queue_collectors WHERE customer=? ORDER BY source LIMIT 21").all(customer);
      if (rows.length > 20) throw new Error("Projection queue collector source limit exceeded (20)");
      return rows.map((row) => { identifier(row.source); get(customer, row.source); return row.source; });
    },
    gaps(customer: string, source: string, afterId = 0, limit = 100) {
      get(customer, source);
      if (!integer(afterId) || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid queue gap page");
      const rows = db.prepare("SELECT * FROM queue_collection_gaps WHERE customer=? AND source=? AND id>? ORDER BY id LIMIT ?")
        .all(customer, source, afterId, limit + 1);
      const gaps = rows.slice(0, limit).map((row) => {
        if (!integer(row.id) || row.id < 1 || row.customer !== customer || row.source !== source ||
            !integer(row.observed_at) || (row.last_success_at !== null && !integer(row.last_success_at)) ||
            typeof row.operator !== "string" || typeof row.reason !== "string") throw new Error("Invalid stored queue collection gap");
        identifier(row.from_generation); identifier(row.to_generation);
        timestamp(row.observed_at);
        if (row.last_success_at !== null) timestamp(row.last_success_at);
        transitionContext(row.operator, row.reason);
        if (row.from_generation === row.to_generation || (row.last_success_at !== null && row.last_success_at > row.observed_at)) {
          throw new Error("Invalid stored queue gap interval");
        }
        return { kind: "queue" as const, id: row.id, customer, source, previousGeneration: row.from_generation,
          generation: row.to_generation, lastSuccessAt: row.last_success_at, observedAt: row.observed_at,
          operator: row.operator, reason: row.reason, coverage: "unknown" };
      });
      return { kind: "queue", gaps, nextAfterId: rows.length > limit ? gaps.at(-1)!.id : null };
    },
  };
}
export async function collectQueueOnce(store: ReturnType<typeof openCelHistory>, customer: string, source: string) {
  const collectors = store.queue.collectors;
  return collectHistoryOnce(() => collectors.begin(customer, source),
    (revision, bytes) => collectors.complete(customer, source, revision, bytes),
    (revision, failure) => collectors.fail(customer, source, revision, failure),
    (error) => error instanceof QueueAttemptConflict, (error) => error instanceof QueuePrefixError);
}
