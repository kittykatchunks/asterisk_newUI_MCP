import { isAbsolute } from "node:path";
import { openCelHistory } from "../src/cel-history.ts";
import { readHistorySnapshot } from "../src/history-evidence.ts";

const [action, database, customer, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts\\Manage-QueueHistory.ts <import|sources|events|call> <absolute-history-database> <customer> " +
  "[import: <source> <generation> <absolute-snapshot>; sources: <after-source|-> <after-generation|-> <limit>; " +
  "events: <source> <generation> <after-offset|-1> <limit>; call: <source> <generation> <call-id> <after-offset|-1> <limit>]";
if (!database || !customer || !isAbsolute(database) || !["import", "sources", "events", "call"].includes(action) ||
    args.length !== ({ import: 3, sources: 3, events: 4, call: 5 }[action])) throw new Error(usage);
const store = openCelHistory(database, { readOnly: action !== "import" });
try {
  let result;
  if (action === "import") {
    const [source, generation, path] = args;
    result = store.queue.ingest({ customer, source, generation }, await readHistorySnapshot(path));
  } else if (action === "sources") {
    if (!/^[1-9][0-9]*$/.test(args[2]) || (args[0] === "-") !== (args[1] === "-")) throw new Error(usage);
    result = store.queue.sources(customer,
      args[0] === "-" ? undefined : { source: args[0], generation: args[1] }, Number(args[2]));
  } else {
    const [source, generation] = args;
    const offset = args[action === "call" ? 3 : 2];
    const limit = args[action === "call" ? 4 : 3];
    if (!/^(?:-1|0|[1-9][0-9]*)$/.test(offset) || !/^[1-9][0-9]*$/.test(limit)) throw new Error(usage);
    result = store.queue.read({ customer, source, generation, afterOffset: Number(offset), limit: Number(limit),
      ...(action === "call" ? { callId: args[2] } : {}) });
  }
  console.log(JSON.stringify(result));
} finally { store.close(); }
