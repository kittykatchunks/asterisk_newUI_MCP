import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

export const HISTORY_SNAPSHOT_LIMIT = 8 * 1024 * 1024;
export const HISTORY_RECORD_LIMIT = 64 * 1024;
export const historySha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
export function historyIdentifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value)) {
    throw new Error("History scope requires bounded lowercase customer/source/generation identifiers");
  }
}
export function historyInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
export function historyDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
export async function readHistorySnapshot(path: string) {
  if (!isAbsolute(path)) throw new Error("History snapshot requires an absolute local path");
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile()) throw new Error("History snapshot must be a regular local file");
    const bytes = Buffer.alloc(HISTORY_SNAPSHOT_LIMIT + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > HISTORY_SNAPSHOT_LIMIT) throw new Error("History snapshot exceeds 8 MiB");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
