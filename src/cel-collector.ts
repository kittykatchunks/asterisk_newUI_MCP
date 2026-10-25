import { CelAttemptConflict, CelPrefixError, type openCelHistory } from "./cel-history.ts";
import { readHistorySnapshot as readCelSnapshot } from "./history-evidence.ts";
import { collectHistoryOnce } from "./history-collection.ts";

export { readCelSnapshot };

export async function collectCelOnce(
  store: ReturnType<typeof openCelHistory>, customer: string, source: string,
) {
  return collectHistoryOnce(() => store.beginCollection(customer, source),
    (revision, bytes) => store.completeCollection(customer, source, revision, bytes),
    (revision, failure) => store.failCollection(customer, source, revision, failure),
    (error) => error instanceof CelAttemptConflict, (error) => error instanceof CelPrefixError);
}
