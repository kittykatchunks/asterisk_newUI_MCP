import { isAbsolute } from "node:path";
import { setTimeout } from "node:timers/promises";
import { openCelHistory } from "../src/cel-history.ts";
import { collectCelOnce } from "../src/cel-collector.ts";

const [action, database, customer, source, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts\\Manage-CelCollector.ts <configure|collect|run|status|transition|gaps> " +
  "<absolute-history-database> <customer> <source> " +
  "[configure: <generation> <IANA-time-basis> <absolute-local-path> <stale-after-ms>; " +
  "run: <interval-ms> <passes>; transition: <new-generation> <operator> <reason>; gaps: <after-id> <limit>]";
if (!database || !isAbsolute(database) || !customer || !source ||
    !["configure", "collect", "run", "status", "transition", "gaps"].includes(action) ||
    args.length !== ({ configure: 4, collect: 0, run: 2, status: 0, transition: 3, gaps: 2 }[action])) throw new Error(usage);
function number(text: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(usage);
  return Number(text);
}
const interval = action === "run" ? number(args[0]) : 0;
const passes = action === "run" ? number(args[1]) : 1;
if (action === "run" && (interval < 100 || interval > 60000 || passes < 1 || passes > 1000)) throw new Error(usage);
const store = openCelHistory(database, { readOnly: action === "status" || action === "gaps" });
try {
  const print = (value: unknown) => console.log(JSON.stringify(value));
  switch (action) {
    case "configure":
      print(store.configureCollector({ customer, source, generation: args[0], timeBasis: args[1],
        path: args[2], staleAfterMs: number(args[3]) }));
      break;
    case "status": print(store.collectorStatus(customer, source)); break;
    case "gaps": print(store.collectionGaps(customer, source, number(args[0]), number(args[1]))); break;
    case "transition": print(store.transitionCollector(customer, source, args[0], args[1], args[2])); break;
    case "collect":
    case "run":
      for (let pass = 0; pass < passes; pass++) {
        if (pass > 0) await setTimeout(interval);
        const result = await collectCelOnce(store, customer, source);
        print({ result, status: store.collectorStatus(customer, source) });
      }
      break;
  }
} finally { store.close(); }
