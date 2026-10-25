import { inspectConfigurationBinding, readConfigurationBinding } from "../src/configuration-inspector.ts";
import { configurationReview, compareConfigurationReview, parseConfigurationReview } from "../src/configuration-review.ts";
import { openConfigurationStore } from "../src/configuration-store.ts";

async function main() {
  const [action, database, bindingPath, customer, runtime, revisionText, ...args] = process.argv.slice(2);
  if (!["approve", "check"].includes(action) || !/^[1-9][0-9]*$/.test(revisionText ?? "") ||
      !Number.isSafeInteger(Number(revisionText)) || args.length !== (action === "approve" ? 4 : 0)) {
    throw new Error("Usage: node scripts\\Review-ConfigurationInspection.ts <approve|check> <absolute-db> <absolute-binding> <customer> <runtime> <revision> [approve: <draft-hash> <validation-hash> <operator> <reason>]. Offline review only, no runtime apply authorization.");
  }
  const scope = { customer, runtime }, revision = Number(revisionText);
  const binding = await readConfigurationBinding(bindingPath);
  const store = openConfigurationStore(database, { readOnly: action === "check" });
  try {
    const before = store.read(scope, revision);
    if (action === "approve") {
      if (before.draft.sha256 !== args[0] || before.validation?.sha256 !== args[1] || before.approval) {
        throw new Error("Exact validated unapproved draft required");
      }
    } else if (!before.approval?.document.inspectionReview) {
      throw new Error("Approval has no bound inspection review; ordinary offline approval cannot be upgraded");
    }
    const observed = await inspectConfigurationBinding(binding, scope);
    const result = action === "approve" ?
      store.approve(scope, revision, args[0], args[1], { operator: args[2], reason: args[3] }, configurationReview(binding, observed)) :
      compareConfigurationReview(parseConfigurationReview(before.approval!.document.inspectionReview), binding, observed, scope);
    console.log(JSON.stringify({ offlineReviewOnly: true, executorEnabled: false, runtimeApplyAuthorized: false, result }));
  } finally { store.close(); }
}
await main().catch((error: unknown) => {
  console.error(JSON.stringify({ status: "review-failed", executorEnabled: false, runtimeApplyAuthorized: false,
    error: error instanceof Error ? error.message : "Unknown inspection review failure" }));
  process.exitCode = 1;
});
