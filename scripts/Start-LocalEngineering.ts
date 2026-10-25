import { createInterface } from "node:readline";
import { localEngineeringRoot, startLocalEngineering } from "../src/local-engineering.ts";

const args = process.argv.slice(2);
if (args.some((arg) => !["--stage-captured-reports", "--with-agents", "--with-simulation", "--with-history"].includes(arg))) throw new Error("Unknown local engineering argument");
const app = await startLocalEngineering(localEngineeringRoot, args.includes("--stage-captured-reports"), args.includes("--with-agents"), args.includes("--with-simulation"), args.includes("--with-history"));
console.log(`Local engineering ready: ${app.origin}/engineering/reviews/customer-a`);
console.log(`Customer B (metadata-only Bob): ${app.origin}/engineering/reviews/customer-b`);
console.log(`Persistent database: ${app.databasePath}`);
console.log(`New captured candidates staged: ${app.staged}; no reports automatically approved.`);
if (app.withAgents) console.log(`Agent reservations (synthetic Alice only; phone disabled): ${app.origin}/agent/customer-a`);
if (app.withSimulation) console.log(`Booking SIMULATION ONLY (synthetic Alice; no real taxi): ${app.origin}/simulation/customer-a`);
if (app.withHistory) console.log(`Read-only history (explicit configured members only): ${app.origin}/engineering/history/customer-a`);
console.log("Synthetic credentials: .local-proof\\identity\\accounts.json (do not share).");
console.log("Type stop then Enter, or press Ctrl+C, to shut down. Local HTTP proof only.");
const input = createInterface({ input: process.stdin });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  input.close();
  process.stdin.pause();
  process.stdin.destroy();
  process.off("SIGINT", stopSignal);
  process.off("SIGTERM", stopSignal);
  try { await app.stop(); console.log("Local engineering stopped; database preserved."); }
  catch (error) { console.error(error instanceof Error ? error.message : "Local shutdown failed"); process.exitCode = 1; }
}
input.on("line", (line) => {
  if (line.trim() === "stop") void stop();
  else console.log("Type stop then Enter to shut down.");
});
function stopSignal() { void stop(); }
process.on("SIGINT", stopSignal);
process.on("SIGTERM", stopSignal);
