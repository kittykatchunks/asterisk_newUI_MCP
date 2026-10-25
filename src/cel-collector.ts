import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { CelAttemptConflict, CelPrefixError, CEL_SNAPSHOT_LIMIT, type openCelHistory } from "./cel-history.ts";

export async function readCelSnapshot(path: string) {
  if (!isAbsolute(path)) throw new Error("CEL snapshot requires an absolute local path");
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("CEL snapshot must be a regular local file");
    const bytes = Buffer.alloc(CEL_SNAPSHOT_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > CEL_SNAPSHOT_LIMIT) throw new Error("CEL snapshot exceeds 8 MiB");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}

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
