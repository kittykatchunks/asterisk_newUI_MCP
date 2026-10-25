import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { openCelHistory } from "../src/cel-history.ts";
import { inspectHistoryMarker } from "../src/history-markers.ts";

const [action, database, customer, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts\\Manage-HistoryManifest.ts <register|list|resolve|marker> <absolute-history-database> <customer> " +
  "[register: <absolute-manifest-json>; list: <after-id> <limit>; resolve: <cel|queue> <source> <generation> <offset>; " +
  "marker: <cel-source> <generation> <offset>]";
if (!database || !isAbsolute(database) || !customer || !["register", "list", "resolve", "marker"].includes(action) ||
    args.length !== ({ register: 1, list: 2, resolve: 4, marker: 3 }[action])) throw new Error(usage);
function number(text: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(usage);
  return Number(text);
}
const store = openCelHistory(database, { readOnly: action !== "register" });
try {
  let result;
  if (action === "register") {
    if (!isAbsolute(args[0])) throw new Error(usage);
    const file = await open(args[0], "r");
    let value: unknown;
    try {
      if (!(await file.stat()).isFile()) throw new Error("Manifest JSON must be a regular local file");
      const bytes = Buffer.alloc(65537);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 65536) throw new Error("Manifest JSON exceeds 64 KiB");
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
    } finally { await file.close(); }
    if (typeof value !== "object" || value === null || !("customer" in value) || value.customer !== customer) {
      throw new Error("Manifest customer does not match requested scope");
    }
    result = store.manifests.register(value);
  } else if (action === "list") {
    result = store.manifests.list(customer, number(args[0]), number(args[1]));
  } else if (action === "resolve") {
    if (args[0] !== "cel" && args[0] !== "queue") throw new Error(usage);
    result = store.manifests.resolve(customer, args[0], args[1], args[2], number(args[3]));
  } else {
    result = inspectHistoryMarker(store, customer, args[0], args[1], number(args[2]));
  }
  console.log(JSON.stringify(result));
} finally { store.close(); }
