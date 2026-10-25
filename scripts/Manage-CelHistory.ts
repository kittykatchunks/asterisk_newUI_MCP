import { isAbsolute } from "node:path";
import { openCelHistory } from "../src/cel-history.ts";
import { readCelSnapshot } from "../src/cel-collector.ts";

const [action, database, customer, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts\\Manage-CelHistory.ts <import|sources|events|channel> <absolute-dedicated-database> <customer> " +
  "[import: <source> <generation> <IANA-time-basis> <absolute-snapshot>; sources: <after-source|-> <after-generation|-> <limit>; " +
  "events: <source> <generation> <after-offset|-1> <limit>; " +
  "channel: <source> <generation> <uniqueid> <after-offset|-1> <limit>]";
if (!database || !customer || !isAbsolute(database) ||
    !["import", "sources", "events", "channel"].includes(action) ||
    args.length !== ({ import: 4, sources: 3, events: 4, channel: 5 }[action])) throw new Error(usage);
const store = openCelHistory(database, { readOnly: action !== "import" });
try {
  let result;
  if (action === "import") {
    const [source, generation, timeBasis, path] = args;
    if (!isAbsolute(path)) throw new Error(usage);
    result = store.ingest({ customer, source, generation, timeBasis }, await readCelSnapshot(path));
  } else if (action === "sources") {
    if (!/^[1-9][0-9]*$/.test(args[2]) || (args[0] === "-") !== (args[1] === "-")) throw new Error(usage);
    result = store.sources(customer, args[0] === "-" ? undefined : { source: args[0], generation: args[1] }, Number(args[2]));
  } else {
    const [source, generation] = args;
    const offset = args[action === "channel" ? 3 : 2];
    const limit = args[action === "channel" ? 4 : 3];
    if (!/^(?:-1|0|[1-9][0-9]*)$/.test(offset) || !/^[1-9][0-9]*$/.test(limit)) throw new Error(usage);
    result = store.read({ customer, source, generation, afterOffset: Number(offset), limit: Number(limit),
      ...(action === "channel" ? { uniqueid: args[2] } : {}) });
  }
  console.log(JSON.stringify(result));
} finally { store.close(); }
