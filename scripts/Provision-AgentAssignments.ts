import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { assertAgentAssignment } from "../src/agent-directory.ts";
import { openAgentStore } from "../src/agent-store.ts";

const [database, input, operator, reason, ...extra] = process.argv.slice(2);
if (!database || !input || !operator || !reason || extra.length || !isAbsolute(database) || !isAbsolute(input)) {
  throw new Error("Usage: node scripts\\Provision-AgentAssignments.ts <absolute-agent-database> <absolute-assignments-json> <operator-reference> <reason>");
}
const assignments: unknown = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(assignments)) throw new Error("Agent provisioning input must be a JSON array");
for (const assignment of assignments) assertAgentAssignment(assignment);
const store = openAgentStore(database);
try {
  console.log(JSON.stringify(store.provision(assignments, { operator, reason })));
} finally { store.close(); }
