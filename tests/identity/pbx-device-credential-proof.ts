import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createSocket } from "node:dgram";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { openAgentDeviceLeaseStore } from "../../src/agent-device-lease.ts";
import { loadLocalPbxStatus, localEngineeringRoot } from "../../src/local-engineering.ts";
import { createSipRegistrationClient } from "./sip-registration-client.ts";

const execute = promisify(execFile);
const compose = join(localEngineeringRoot, "compose.status-proof.yaml");
const root = join(localEngineeringRoot, ".local-proof", "pbx-status");
const directory = await mkdtemp(join(tmpdir(), "asterisk-sip-lease-"));
let now = Date.now();
const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"), { now: () => now });
const source = await loadLocalPbxStatus(localEngineeringRoot, true);
assert.ok(source);
const customers = ["customer-a", "customer-b"] as const;
const originals = new Map<string, string>();
const sockets: ReturnType<typeof createSocket>[] = [];
const cli = async (customer: string, command: string) =>
  (await execute("docker", ["compose", "-f", compose, "exec", "-T", customer, "asterisk", "-rx", command],
    { timeout: 10000, maxBuffer: 65536 })).stdout;
const reload = async (customer: string) => {
  const output = await cli(customer, "module reload res_pjsip.so");
  assert.match(output, /reloaded successfully/i, "Owned PBX must accept configuration reload");
};
async function observe(customer: string, username: string, present: boolean, timeout = 5000) {
  const deadline = performance.now() + timeout;
  do {
    const snapshot = await source!.endpoints(customer);
    const endpoint = snapshot.endpoints.find((entry) => entry.id === username);
    assert.equal(snapshot.endpoints.find((entry) => entry.id === `${customer}-static`)?.hasContacts, true);
    if (present ? endpoint?.hasContacts === true : endpoint === undefined) return;
    await delay(200);
  } while (performance.now() < deadline);
  assert.fail("Temporary lease endpoint did not reach its expected observed state");
}
function render(username: string, secret: string) {
  assert.match(username, /^lease-[0-9a-f-]{36}$/);
  assert.match(secret, /^[0-9a-f]{64}$/);
  return `
[${username}]
type = endpoint
context = lease-proof-no-calls
disallow = all
allow = ulaw
aors = ${username}
auth = ${username}-auth
rewrite_contact = yes
[${username}-auth]
type = auth
auth_type = userpass
username = ${username}
password = ${secret}
[${username}]
type = aor
max_contacts = 1
minimum_expiration = 5
maximum_expiration = 5
default_expiration = 5
`;
}
try {
  for (const customer of customers) {
    originals.set(customer, await readFile(join(root, `${customer}-pjsip.conf`), "utf8"));
  }
  for (const [index, customer] of customers.entries()) {
    const foreign = customers[1 - index];
    const owner = { issuer: "https://lease-proof.example", subject: "synthetic-agent", customer,
      sessionId: randomBytes(32).toString("base64url"), sessionExpiresAt: now + 900000, deviceId: randomUUID() };
    const socket = createSocket("udp4");
    socket.bind(0, "127.0.0.1");
    await once(socket, "listening");
    sockets.push(socket);
    const localPort = socket.address().port;
    const transport = (port: number) => () => ({ socket, localPort, destinationPort: port });
    let previous: { username: string; secret: string } | undefined;
    for (const termination of ["release", "expiry"] as const) {
      const lease = leases.acquire(owner);
      const credential = { username: `lease-${lease.id}`, secret: randomBytes(32).toString("hex") };
      if (previous) {
        assert.notEqual(credential.username, previous.username);
        assert.notEqual(credential.secret, previous.secret);
      }
      const client = createSipRegistrationClient(credential, transport(15060 + index));
      assert.ok([401, 403].includes((await client.register(5)).code),
        "An unprovisioned lease identity must receive an authentication denial");
      // Fixture-only privileged provisioning; application AMI accounts are unchanged.
      await writeFile(join(root, `${customer}-pjsip.conf`), originals.get(customer)! + render(credential.username, credential.secret));
      await reload(customer);
      const foreignClient = createSipRegistrationClient(credential, transport(15060 + (1 - index)));
      assert.ok([401, 403].includes((await foreignClient.register(5)).code), "Lease credential must fail authentication on the foreign PBX");
      assert.ok([401, 403].includes((await client.register(5, previous?.secret ?? randomBytes(32).toString("hex"))).code));
      if (previous) {
        const retired = createSipRegistrationClient(previous, transport(15060 + index));
        assert.ok([401, 403].includes((await retired.register(5)).code), "New issuance must not resurrect the prior identity");
      }
      const accepted = await client.register(5);
      assert.equal(accepted.code, 200);
      assert.ok(accepted.contactExpiry !== undefined && accepted.contactExpiry >= 4 && accepted.contactExpiry <= 5);
      await observe(customer, credential.username, true);
      assert.ok(!(await source.endpoints(foreign)).endpoints.some((entry) => entry.id === credential.username));
      if (termination === "release") leases.release(owner, lease.id);
      else {
        now = lease.expiresAt;
        assert.throws(() => leases.renew(owner, lease.id), /device_lease_not_owned/);
      }
      await writeFile(join(root, `${customer}-pjsip.conf`), originals.get(customer)!);
      await reload(customer);
      await observe(customer, credential.username, false);
      assert.ok([401, 403].includes((await client.register(5)).code), "Removed per-lease credentials must receive an authentication denial");
      const cleanupDeadline = performance.now() + 40000;
      let contacts = await cli(customer, "pjsip show contacts");
      while (contacts.includes(credential.username) && performance.now() < cleanupDeadline) {
        await delay(250);
        contacts = await cli(customer, "pjsip show contacts");
      }
      assert.ok(!contacts.includes(credential.username), "Retired contact must disappear within the five-second lifetime plus cleanup bound");
      assert.ok(contacts.includes(`${customer}-static`), "Revocation must preserve the unrelated static contact");
      previous = credential;
      console.log(`PASS ${customer}: per-lease SIP identity, foreign/wrong-secret denial, ${termination}-driven fixture revocation, retired REGISTER denied and bounded contact cleanup`);
    }
  }
} finally {
  try {
    for (const [customer, original] of originals) {
      await writeFile(join(root, `${customer}-pjsip.conf`), original);
      await reload(customer);
    }
  } finally {
    for (const socket of sockets) socket.close();
    leases.close();
    await rm(directory, { recursive: true });
  }
}
