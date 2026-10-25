import { CelAttemptConflict, CelPrefixError, type openCelHistory } from "./cel-history.ts";
import { readHistorySnapshot as readCelSnapshot } from "./history-evidence.ts";

export { readCelSnapshot };

export async function collectCelOnce(
  store: ReturnType<typeof openCelHistory>, customer: string, source: string,
) {
  const attempt = store.beginCollection(customer, source);
  try {
    const bytes = await readCelSnapshot(attempt.path);
    return store.completeCollection(customer, source, attempt.revision, bytes);
  } catch (error) {
    if (error instanceof CelAttemptConflict) throw error;
    const failure = error instanceof CelPrefixError ? "prefix-discontinuity" :
      error instanceof Error && "code" in error && ["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(String(error.code)) ?
        "source-unavailable" : "collection-failed";
    try { store.failCollection(customer, source, attempt.revision, failure); }
    catch (recordError) {
      throw new AggregateError([error, recordError], "CEL collection failed and its failure status could not be recorded");
    }
    throw error;
  }
}
