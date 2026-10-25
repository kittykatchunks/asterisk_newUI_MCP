import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { ConfigurationValidationError } from "../src/configuration-model.ts";
import { ConfigurationConflict, openConfigurationStore } from "../src/configuration-store.ts";

async function main() {
  const [action, database, customer, runtime, ...args] = process.argv.slice(2);
  const counts: Record<string, number> = { draft: 4, read: 1, validate: 4, approve: 5, claim: 6,
    operation: 1, cancel: 3, uncertain: 3 };
  const usage = "Usage: node scripts\\Manage-ConfigurationDraft.ts <action> <absolute-db> <customer> <runtime> " +
    "[draft: <absolute-model-json> <base-0> <operator> <reason>; read: <revision>; " +
    "validate: <revision> <draft-hash> <operator> <reason>; approve: <revision> <draft-hash> <validation-hash> <operator> <reason>; " +
    "claim: <revision> <approval-hash> <base-0> <operation-uuid> <operator> <reason>; " +
    "operation: <uuid>; cancel/uncertain: <uuid> <operator> <reason>]. Offline only; no runtime executor.";
  if (!Object.hasOwn(counts, action) || !database || !isAbsolute(database) || args.length !== counts[action]) throw new Error(usage);
  function number(text: string) {
    if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(usage);
    return Number(text);
  }
  async function model(path: string) {
    if (!isAbsolute(path)) throw new Error("Model input requires an absolute local file");
    const file = await open(path, "r");
    try {
      if (!(await file.stat()).isFile()) throw new Error("Model input must be a regular local file");
      const buffer = Buffer.alloc(4097);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 4096) throw new ConfigurationValidationError("input-size", "$", "Configuration model requires at most 4096 UTF-8 bytes");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
    } finally { await file.close(); }
  }
  const scope = { customer, runtime };
  const text = action === "draft" ? await model(args[0]) : undefined;
  const store = openConfigurationStore(database, { readOnly: action === "read" || action === "operation" });
  try {
    let result;
    switch (action) {
      case "draft": result = store.createDraft(scope, text!, number(args[1]), { operator: args[2], reason: args[3] }); break;
      case "read": result = store.read(scope, number(args[0])); break;
      case "validate": result = store.validate(scope, number(args[0]), args[1], { operator: args[2], reason: args[3] }); break;
      case "approve": result = store.approve(scope, number(args[0]), args[1], args[2], { operator: args[3], reason: args[4] }); break;
      case "claim": result = store.claim(scope, number(args[0]), args[1], number(args[2]), args[3], { operator: args[4], reason: args[5] }); break;
      case "operation":
        result = store.operation(scope, args[0]);
        if (!result) throw new Error("Configuration operation not found for scope");
        break;
      case "cancel":
      case "uncertain":
        result = store.finishOffline(scope, args[0], action === "cancel" ? "cancelled-before-effects" : "uncertain",
          { operator: args[1], reason: args[2] });
        break;
    }
    console.log(JSON.stringify({ offlineOnly: true, executorEnabled: false, runtimeStatus: "not-inspected", result }));
  } finally { store.close(); }
}
await main().catch((error: unknown) => {
  console.error(JSON.stringify({ offlineOnly: true, executorEnabled: false, error: {
    code: error instanceof ConfigurationValidationError ? "validation-failed" :
      error instanceof ConfigurationConflict ? "configuration-conflict" : "configuration-failed",
    message: error instanceof Error ? error.message : "Unknown configuration failure",
    ...(error instanceof ConfigurationValidationError ? { issues: error.issues } : {}),
  } }));
  process.exitCode = 1;
});
