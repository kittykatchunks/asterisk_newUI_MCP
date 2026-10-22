import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";

const source = await loadLocalPbxStatus(localEngineeringRoot);
assert.ok(source);
for (const customer of ["customer-a", "customer-b"]) {
  const status = await source.status(customer);
  assert.equal(status.customer, customer);
  assert.equal(status.activeCalls, 0);
  assert.match(status.coreStartedAtLocal, /^\d{4}-\d{2}-\d{2} /);
  assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
}
await assert.rejects(source.status("customer-unknown"), /not configured/);
await assert.rejects(source.endpoints("customer-a"), /denied/, "Reporting-only credentials must not gain endpoint action authority");
const endpointSource = await loadLocalPbxStatus(localEngineeringRoot, true);
assert.ok(endpointSource);
for (const customer of ["customer-a", "customer-b"]) {
  const snapshot = await endpointSource.endpoints(customer);
  assert.equal(snapshot.customer, customer);
  assert.equal(snapshot.endpoints.length, 2);
  assert.deepEqual(snapshot.endpoints.map((endpoint) => [endpoint.id, endpoint.hasContacts]),
    [[`${customer}-offline`, false], [`${customer}-static`, true]]);
  assert.ok(snapshot.endpoints.every((endpoint) => endpoint.activeChannels === 0));
  assert.ok(!JSON.stringify(snapshot).includes("sip:"), "Contact addresses must not be disclosed");
}
console.log("PASS separate endpoint credentials enumerate only their own PBX; static contacts are not labelled registrations");

// Independent unauthenticated probe must not obtain CoreStatus.
const socket = connect({ host: "127.0.0.1", port: 15038 });
socket.setTimeout(3000, () => socket.destroy(new Error("Unauthenticated AMI probe timed out")));
await once(socket, "connect");
socket.write("Action: CoreStatus\r\nActionID: denied\r\n\r\n");
let response = "";
for await (const chunk of socket) {
  response += chunk.toString();
  if (response.includes("Response: Error")) { socket.destroy(); break; }
}
assert.match(response, /Response: Error/);

const connections = JSON.parse(await readFile(join(localEngineeringRoot, ".local-proof", "pbx-status", "connections.json"), "utf8"));
const restricted = connect({ host: "127.0.0.1", port: 15038 });
restricted.setTimeout(3000, () => restricted.destroy(new Error("Restricted AMI probe timed out")));
await once(restricted, "connect");
restricted.write(`Action: Login\r\nActionID: login\r\nUsername: status-reader\r\nSecret: ${connections[0].secret}\r\nEvents: off\r\n\r\n`);
let buffer = "";
const denied: string[] = [];
for await (const chunk of restricted) {
  buffer += chunk.toString();
  let boundary: number;
  while ((boundary = buffer.indexOf("\r\n\r\n")) !== -1) {
    const frame = buffer.slice(0, boundary);
    buffer = buffer.slice(boundary + 4);
    if (frame.includes("ActionID: login")) {
      assert.match(frame, /Response: Success/);
      restricted.write("Action: Command\r\nActionID: command\r\nCommand: core show uptime\r\n\r\n");
    } else if (frame.includes("ActionID: command")) {
      assert.match(frame, /Permission denied/i);
      denied.push("Command");
      restricted.write("Action: Originate\r\nActionID: originate\r\n\r\n");
    } else if (frame.includes("ActionID: originate")) {
      assert.match(frame, /Permission denied/i);
      denied.push("Originate");
      restricted.destroy();
    }
  }
  if (denied.length === 2) break;
}
assert.deepEqual(denied, ["Command", "Originate"]);
console.log("PASS two isolated Asterisk 22 AMI core-status checks; unauthenticated, Command and Originate actions denied");
