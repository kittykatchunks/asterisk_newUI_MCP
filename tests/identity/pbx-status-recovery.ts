import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import type { PbxStatus } from "../../src/pbx-status.ts";

const execute = promisify(execFile);
const compose = join(localEngineeringRoot, "compose.status-proof.yaml");
const docker = async (...args: string[]) => execute("docker", ["compose", "-f", compose, ...args],
  { timeout: 15000, maxBuffer: 65536 });
const source = await loadLocalPbxStatus(localEngineeringRoot);
assert.ok(source);
assert.equal((await source.status("customer-a")).activeCalls, 0);
assert.equal((await source.status("customer-b")).activeCalls, 0);

// The owning PowerShell fixture has already established exclusive ownership.
try {
  await docker("stop", "--timeout", "5", "customer-a");
  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const [unavailable, unaffected]: [PromiseSettledResult<PbxStatus>, PromiseSettledResult<PbxStatus>] = await Promise.allSettled([
      source.status("customer-a"), source.status("customer-b"),
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
console.log("PASS customer A outage stays unavailable and bounded, customer B remains reachable, same AMI source recovers after restart");
