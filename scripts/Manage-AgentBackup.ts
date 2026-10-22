import { backupAgentStore, restoreAgentStore } from "../src/agent-backup.ts";

const [operation, source, parent, ...extra] = process.argv.slice(2);
if (!source || !parent || extra.length || !["backup", "restore"].includes(operation ?? "")) {
  throw new Error("Usage: node scripts\\Manage-AgentBackup.ts <backup|restore> <absolute-source> <absolute-output-parent>");
}
const path = operation === "backup" ? await backupAgentStore(source, parent) : await restoreAgentStore(source, parent);
console.log(JSON.stringify({ operation, path }));
