import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import type { PbxEndpointSnapshot, PbxStatus } from "../../src/pbx-status.ts";

const execute = promisify(execFile);
const compose = join(localEngineeringRoot, "compose.status-proof.yaml");
const docker = async (...args: string[]) => execute("docker", ["compose", "-f", compose, ...args],
  { timeout: 15000, maxBuffer: 65536 });
const source = await loadLocalPbxStatus(localEngineeringRoot);
const endpoints = await loadLocalPbxStatus(localEngineeringRoot, true);
assert.ok(source);
assert.ok(endpoints);
const assertEndpoints = (snapshot: PbxEndpointSnapshot, customer: string) => {
  assert.equal(snapshot.customer, customer);
  assert.ok(Number.isFinite(Date.parse(snapshot.checkedAt)));
  assert.deepEqual(snapshot.endpoints.map(({ id, hasContacts, activeChannels }) => ({ id, hasContacts, activeChannels })), [
    { id: `${customer}-offline`, hasContacts: false, activeChannels: 0 },
    { id: `${customer}-static`, hasContacts: true, activeChannels: 0 },
  ]);
  assert.ok(!JSON.stringify(snapshot).includes("sip:"), "Recovery must retain contact-address redaction");
};
assert.equal((await source.status("customer-a")).activeCalls, 0);
assert.equal((await source.status("customer-b")).activeCalls, 0);
assertEndpoints(await endpoints.endpoints("customer-a"), "customer-a");
assertEndpoints(await endpoints.endpoints("customer-b"), "customer-b");

// The owning PowerShell fixture has already established exclusive ownership.
try {
  await docker("stop", "--timeout", "5", "customer-a");
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const [unavailable, unaffected, unavailableEndpoints, unaffectedEndpoints]: [
      PromiseSettledResult<PbxStatus>, PromiseSettledResult<PbxStatus>,
      PromiseSettledResult<PbxEndpointSnapshot>, PromiseSettledResult<PbxEndpointSnapshot>,
    ] = await Promise.allSettled([
      source.status("customer-a"), source.status("customer-b"),
      endpoints.endpoints("customer-a"), endpoints.endpoints("customer-b"),
    ]);
    assert.equal(unavailable.status, "rejected", "A stopped core must not yield a stale successful snapshot");
    if (unavailable.status === "rejected") {
      assert.ok(unavailable.reason instanceof Error);
      assert.match(unavailable.reason.message, /PBX status (connection|check)/);
    }
    assert.equal(unaffected.status, "fulfilled", "Customer A's outage must not block customer B");
    if (unaffected.status === "fulfilled") {
      assert.equal(unaffected.value.customer, "customer-b");
      assert.equal(unaffected.value.activeCalls, 0);
    }
    assert.equal(unavailableEndpoints.status, "rejected", "A stopped PBX must not yield stale endpoints or a successful empty list");
    if (unavailableEndpoints.status === "rejected") {
      assert.ok(unavailableEndpoints.reason instanceof Error);
      assert.match(unavailableEndpoints.reason.message, /PBX status (connection|check)/);
    }
    assert.equal(unaffectedEndpoints.status, "fulfilled", "Customer A's outage must not block customer B's endpoint enumeration");
    if (unaffectedEndpoints.status === "fulfilled") assertEndpoints(unaffectedEndpoints.value, "customer-b");
    assert.ok(Date.now() - started < 5000, "Outage checks must stay within the bounded connection deadline");
  }
} finally {
  await docker("start", "customer-a");
}

let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const { stdout } = await docker("exec", "-T", "customer-a", "asterisk", "-rx", "core waitfullybooted");
    if (stdout.includes("fully booted")) { ready = true; break; }
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== 1 ||
        !("stderr" in error) || typeof error.stderr !== "string" ||
        !error.stderr.includes("Unable to connect to remote asterisk")) throw error;
  }
  await delay(1000);
}
assert.ok(ready, "Restarted test PBX must finish booting");
const recovered = await source.status("customer-a");
assert.equal(recovered.customer, "customer-a");
assert.equal(recovered.activeCalls, 0);
assert.equal((await source.status("customer-b")).activeCalls, 0);
assertEndpoints(await endpoints.endpoints("customer-a"), "customer-a");
assertEndpoints(await endpoints.endpoints("customer-b"), "customer-b");
console.log(`PASS customer A core/endpoint outage stays unavailable and bounded, customer B remains reachable, same separate AMI sources recover after restart${process.env.ASTERISK_TEST_AMI_TLS === "1" ? " over verified TLS" : ""}`);
