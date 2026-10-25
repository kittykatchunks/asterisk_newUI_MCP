import { isAbsolute } from "node:path";
import { historyInteger as integer, HISTORY_SNAPSHOT_LIMIT, readHistorySnapshot } from "./history-evidence.ts";

export type HistoryCollectionFailure = "source-unavailable" | "prefix-discontinuity" | "collection-failed";
export function collectionFileConfig(path: string, staleAfterMs: number) {
  if (typeof path !== "string" || !isAbsolute(path) || path.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(path) || !Number.isSafeInteger(staleAfterMs) ||
      staleAfterMs < 1000 || staleAfterMs > 86400000) {
    throw new Error("History collector requires an absolute local path and freshness threshold of 1s to 24h");
  }
}
export function collectionTimestamp(value: number) {
  if (!integer(value) || value > 8640000000000000) throw new Error("Invalid history collection timestamp");
}
export function collectionTransitionContext(operator: string, reason: string) {
  for (const [text, maximum] of [[operator, 200], [reason, 2000]] as const) {
    if (typeof text !== "string" || !text.trim() || text.length > maximum || /[\x00-\x1f\x7f]/.test(text)) {
      throw new Error("History transition requires a bounded operator reference and reason");
    }
  }
}
export interface CollectionState {
  revision: number; updatedAt: number; outcome: "never" | "collecting" | "success" | "failure";
  attemptedAt: number | null; succeededAt: number | null; failure: HistoryCollectionFailure | null; pendingBytes: number;
}
export function collectionState(row: Record<string, unknown>): CollectionState {
  const { revision, updated_at: updatedAt, outcome, attempted_at: attemptedAt,
    succeeded_at: succeededAt, failure, pending_bytes: pendingBytes } = row;
  if (!integer(revision) || !integer(updatedAt) ||
      (outcome !== "never" && outcome !== "collecting" && outcome !== "success" && outcome !== "failure") ||
      (attemptedAt !== null && !integer(attemptedAt)) || (succeededAt !== null && !integer(succeededAt)) ||
      !integer(pendingBytes) || pendingBytes > HISTORY_SNAPSHOT_LIMIT ||
      (failure !== null && failure !== "source-unavailable" && failure !== "prefix-discontinuity" && failure !== "collection-failed")) {
    throw new Error("Invalid stored history collector state");
  }
  collectionTimestamp(updatedAt);
  if (attemptedAt !== null) collectionTimestamp(attemptedAt);
  if (succeededAt !== null) collectionTimestamp(succeededAt);
  if ((outcome === "never" && (attemptedAt !== null || succeededAt !== null || failure !== null)) ||
      (outcome !== "never" && attemptedAt === null) ||
      (outcome === "success" && (succeededAt !== updatedAt || failure !== null)) ||
      (outcome === "failure") !== (failure !== null) ||
      (succeededAt !== null && (attemptedAt === null || succeededAt > updatedAt ||
        (outcome === "success" ? succeededAt < attemptedAt : succeededAt > attemptedAt))) ||
      (attemptedAt !== null && attemptedAt > updatedAt)) throw new Error("Inconsistent stored history collector state");
  return { revision, updatedAt, outcome, attemptedAt, succeededAt, failure, pendingBytes };
}
export function collectionHealth(current: CollectionState & { staleAfterMs: number }, now: number) {
  collectionTimestamp(now);
  const ageMs = current.succeededAt === null ? null : now - current.succeededAt;
  const status = now < current.updatedAt ? "clock-skew" : current.outcome === "never" ? "never-collected" :
    current.outcome === "failure" ? "unhealthy" : current.outcome === "collecting" ?
      now - current.attemptedAt! >= current.staleAfterMs ? "stale" : "collecting" :
      ageMs! >= current.staleAfterMs ? "stale" : current.pendingBytes > 0 ? "pending" : "healthy";
  return { status, ageMs };
}
export async function collectHistoryOnce<T>(
  begin: () => { path: string; revision: number },
  complete: (revision: number, bytes: Uint8Array) => T,
  fail: (revision: number, failure: HistoryCollectionFailure) => void,
  conflict: (error: unknown) => boolean, discontinuity: (error: unknown) => boolean,
) {
  const attempt = begin();
  try { return complete(attempt.revision, await readHistorySnapshot(attempt.path)); }
  catch (error) {
    if (conflict(error)) throw error;
    const failure = discontinuity(error) ? "prefix-discontinuity" :
      error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(String(error.code)) ?
        "source-unavailable" : "collection-failed";
    try { fail(attempt.revision, failure); }
    catch (recordError) {
      throw new AggregateError([error, recordError], "History collection failed and its failure status could not be recorded");
    }
    throw error;
  }
}
