import { openCelHistory } from "../src/cel-history.ts";
import { buildHistoryProjection } from "../src/history-projection.ts";
import { distinctProjectionPaths, openHistoryProjections } from "../src/history-projection-store.ts";

const [action, historyPath, projectionPath, customer, runtime, epoch, ...args] = process.argv.slice(2);
const usage = "Usage: node scripts\\Manage-HistoryProjection.ts <rebuild|read|stored|revisions> <absolute-history-db> " +
  "<absolute-projection-db> <customer> <runtime> <epoch> [read/stored: <latest|revision-id>; revisions: <after-id> <limit>]";
if (!["rebuild", "read", "stored", "revisions"].includes(action) || !historyPath || !projectionPath || !customer || !runtime || !epoch ||
    args.length !== ({ rebuild: 0, read: 1, stored: 1, revisions: 2 }[action])) throw new Error(usage);
distinctProjectionPaths(historyPath, projectionPath);
function number(text: string) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(Number(text))) throw new Error(usage);
  return Number(text);
}
const projections = openHistoryProjections(projectionPath, { readOnly: action !== "rebuild" });
try {
  const scope = { customer, runtime, epoch };
  if (action === "revisions") console.log(JSON.stringify(projections.revisions(scope, number(args[0]), number(args[1]))));
  else if (action === "stored") {
    console.log(JSON.stringify({ ...projections.read(scope, args[0] === "latest" ? undefined : number(args[0])),
      freshness: { state: "not-checked", meaning: "Stored immutable revision only; current raw history was not read" } }));
  } else {
    const history = openCelHistory(historyPath, { readOnly: true });
    try {
      if (action === "rebuild") console.log(JSON.stringify(projections.rebuild(history, scope)));
      else {
        const revision = projections.read(scope, args[0] === "latest" ? undefined : number(args[0]));
        const current = buildHistoryProjection(history, scope);
        const checkedAt = Date.now();
        const collectorHealth = history.readSnapshot(() => current.document.input.coverage.map((source) => {
          const status = source.kind === "cel" ? history.collectorStatus(customer, source.source, checkedAt) :
            history.queue.collectors.status(customer, source.source, checkedAt);
          return { kind: source.kind, source: source.source, status: status.status, revision: status.revision,
            ageMs: status.ageMs, coverage: status.coverage };
        }));
        console.log(JSON.stringify({ ...revision, freshness: {
          state: revision.inputSha256 === current.inputSha256 ? "inputs-match" : "inputs-changed",
          checkedAt: new Date(checkedAt).toISOString(), currentInputSha256: current.inputSha256,
          meaning: "Local committed evidence only; not remote PBX freshness or completeness",
        }, currentCoverage: current.document.input.coverage,
        currentQueueCollectionCapability: current.document.input.queueCollectionCapability,
        currentQuality: current.document.quality, collectorHealth }));
      }
    } finally { history.close(); }
  }
} finally { projections.close(); }
