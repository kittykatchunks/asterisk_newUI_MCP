import { createServer } from "node:http";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { createDiagnosticApi } from "../../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../../src/diagnostic-store.ts";

const store = openDiagnosticStore(process.argv[2]);
const holder = createServer();
holder.listen(0, "127.0.0.1");
await once(holder, "listening");
const address = holder.address();
if (!address || typeof address === "string") throw new Error("No management proof address");
const origin = `http://127.0.0.1:${address.port}`;
// No login is attempted: an actual page and unauthenticated session response
// prove application readiness without starting a separate identity deployment.
const issuer = "http://127.0.0.1:1";
const api = createDiagnosticApi({
  issuer, audience: "outage-proof", jwksUrl: `${issuer}/jwks`,
  allowLoopbackHttpForTests: true, memberships: [], supportGrants: [],
}, store.audit, (_error, requestId) => {
  console.error(`Management outage fixture failed; request ${requestId}`);
  process.exitCode = 1;
}, store.catalog, store, {
  origin, issuer, authorizationEndpoint: `${issuer}/authorize`, tokenEndpoint: `${issuer}/token`,
  jwksUrl: `${issuer}/jwks`, clientId: "synthetic-outage", clientSecret: "synthetic-unused",
  audience: "outage-proof", allowLoopbackHttpForTests: true,
});
holder.on("request", (request, response) => api.emit("request", request, response));
console.log(JSON.stringify({ origin, pid: process.pid }));
const input = createInterface({ input: process.stdin });
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  input.close();
  process.stdin.destroy();
  holder.closeAllConnections();
  await new Promise<void>((resolve, reject) => holder.close((error) => error ? reject(error) : resolve()));
  store.close();
}
input.on("line", (line) => {
  if (line === "stop") void stop().catch((error: unknown) => {
    console.error(error instanceof Error ? error.name : "ShutdownError");
    process.exitCode = 1;
  });
});
input.on("close", () => { if (!stopping) void stop(); });
