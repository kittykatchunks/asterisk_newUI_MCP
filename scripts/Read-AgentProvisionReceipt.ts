import { isAbsolute } from "node:path";
import { openAgentStore } from "../src/agent-store.ts";

const [database, id, ...extra] = process.argv.slice(2);
if (!database || !isAbsolute(database) || !id || extra.length) {
  throw new Error("Usage: node scripts\\Read-AgentProvisionReceipt.ts <absolute-agent-database> <receipt-uuid>");
}
const store = openAgentStore(database, { readOnly: true });
try {
  const receipt = store.receipt(id);
  if (!receipt) throw new Error("Agent provisioning receipt not found; absence does not prove a batch failed");
  console.log(JSON.stringify(receipt));
} finally { store.close(); }
