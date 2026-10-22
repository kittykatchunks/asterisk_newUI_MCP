import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAmiStatusSource, type AmiConnection } from "../../src/pbx-status.ts";
import { localEngineeringRoot } from "../../src/local-engineering.ts";

const directory = join(localEngineeringRoot, ".local-proof", "pbx-status");
assert.equal(process.env.NODE_EXTRA_CA_CERTS, join(directory, "trusted.pem"));
assert.notEqual(process.env.NODE_TLS_REJECT_UNAUTHORIZED, "0");
const readConnections = async (name: string): Promise<AmiConnection[]> =>
  JSON.parse(await readFile(join(directory, name), "utf8"));
const connections = (await readConnections("connections.json")).map((config) => ({ ...config, port: config.port + 10, tls: true }));
const endpointConnections = (await readConnections("endpoint-connections.json"))
  .map((config) => ({ ...config, port: config.port + 10, tls: true }));
assert.deepEqual(connections.map((config) => config.customer), ["customer-a", "customer-b"]);
const core = createAmiStatusSource(connections);
const endpoints = createAmiStatusSource(endpointConnections);

for (const connection of connections) {
  const customer = connection.customer;
  assert.equal((await core.status(customer)).activeCalls, 0);
  const snapshot = await endpoints.endpoints(customer);
  assert.deepEqual(snapshot.endpoints.map((endpoint) => [endpoint.id, endpoint.hasContacts]),
    [[`${customer}-offline`, false], [`${customer}-static`, true]]);
  await assert.rejects(core.endpoints(customer), /action was denied/, "TLS must preserve reporting-only authority");
  const other = connections.find((item) => item.customer !== customer);
  assert.ok(other);
  const wrongSecret = createAmiStatusSource([{ ...connection, secret: other.secret }]);
  await assert.rejects(wrongSecret.status(customer), /action was denied/, "TLS must preserve per-customer authentication");
  assert.equal((await core.status(customer)).activeCalls, 0, "Denied enumeration must release the same adapter's in-flight guard");
}
await assert.rejects(core.status("customer-unknown"), /not configured/);

const env = { ...process.env };
delete env.NODE_EXTRA_CA_CERTS;
const worker = `
  import assert from "node:assert/strict";
  import { once } from "node:events";
  import { connect } from "node:tls";
  import { createAmiStatusSource } from "./src/pbx-status.ts";
  const connections = JSON.parse(process.env.AMI_TLS_CONFIG);
  for (const config of connections) {
    const socket = connect({ host: config.host, port: config.port, rejectUnauthorized: true });
    socket.setTimeout(3000, () => socket.destroy(new Error("Real AMI TLS diagnostic timed out")));
    try {
      await assert.rejects(once(socket, "secureConnect"),
        (error) => error.code === "DEPTH_ZERO_SELF_SIGNED_CERT");
    } finally { socket.destroy(); }
    const source = createAmiStatusSource([config]);
    for (const method of ["status", "endpoints", "status"]) {
      await assert.rejects(source[method](config.customer),
        (error) => error.message === "PBX status connection failed");
    }
  }
`;
await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", worker], {
  cwd: localEngineeringRoot, env: { ...env, AMI_TLS_CONFIG: JSON.stringify(connections) }, timeout: 25000,
});
console.log("PASS real Asterisk TLS: both customers' core/endpoint reads, reporting-only denial, foreign-secret denial and missing-trust rejection; no verification bypass");
