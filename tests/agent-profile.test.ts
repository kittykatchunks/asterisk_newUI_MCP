import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentDirectory, type AgentDirectory } from "../src/agent-directory.ts";
import { createDiagnosticApi, type AccessAudit } from "../src/diagnostic-api.ts";

const assignment = { issuer: "https://identity.example", subject: "alice", customer: "customer-a",
  extension: "1001", displayName: "Alice <agent>" };

test("agent directory binds issuer, subject and customer and copies provisioned data", () => {
  const mutable = { ...assignment };
  const directory = createAgentDirectory([mutable, { ...assignment, customer: "customer-b", extension: "2001" }]);
  mutable.extension = "9999";
  assert.deepEqual(directory.profile(assignment.issuer, "alice", "customer-a"),
    { extension: "1001", displayName: "Alice <agent>" });
  assert.equal(directory.profile("https://foreign.example", "alice", "customer-a"), undefined);
  assert.equal(directory.profile(assignment.issuer, "bob", "customer-a"), undefined);
  assert.equal(directory.profile(assignment.issuer, "alice", "customer-unknown"), undefined);
  const result = directory.profile(assignment.issuer, "alice", "customer-b");
  assert.ok(result);
  result.extension = "9999";
  assert.equal(directory.profile(assignment.issuer, "alice", "customer-b")?.extension, "2001");
  for (const invalid of [{ extension: "sip:1001" }, { extension: "" }, { displayName: "\nAgent" },
    { extension: "1".repeat(17) }, { subject: "" }, { customer: "../customer" }, { displayName: "x".repeat(129) }]) {
    assert.throws(() => createAgentDirectory([{ ...assignment, ...invalid }]), /Invalid/);
  }
  assert.throws(() => createAgentDirectory([assignment, assignment]), /duplicate/);
  assert.equal(createAgentDirectory([{ ...assignment, extension: "1".repeat(16), displayName: "x".repeat(128) }])
    .profile(assignment.issuer, "alice", "customer-a")?.extension.length, 16);
});

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("agent profile requires explicit membership permission and own assignment, with audit before disclosure", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const identity = createServer((_request, response) => response.end(JSON.stringify({ keys: [{ ...jwk, kid: "agent-test" }] })));
  const issuer = await listen(identity);
  const events: AccessAudit[] = [];
  const errors: unknown[] = [];
  let failAudit = false;
  let mode = "valid";
  let lookups = 0;
  const directory = createAgentDirectory([{ ...assignment, issuer },
    { ...assignment, issuer, subject: "bob", customer: "customer-b", extension: "2001" }]);
  const source: AgentDirectory = { profile(...args) {
    lookups++;
    if (mode === "failed") throw new Error("Synthetic directory failure");
    if (mode === "invalid") return { extension: "sip:private", displayName: "private" };
    const profile = directory.profile(...args);
    return profile ? { ...profile, secret: "must-not-leak" } : undefined;
  } };
  const now = Date.now() / 1000;
  const config = {
    issuer, audience: "diagnostic-api", jwksUrl: `${issuer}/jwks`, allowLoopbackHttpForTests: true,
    memberships: [
      { issuer, subject: "alice", customer: "customer-a", permissions: ["agent:access" as const] },
      { issuer, subject: "bob", customer: "customer-b", permissions: ["agent:access" as const] },
      { issuer, subject: "unassigned", customer: "customer-a", permissions: ["agent:access" as const] },
      { issuer, subject: "reader", customer: "customer-a", permissions: ["diagnostics:read" as const] },
    ],
    supportGrants: [{ issuer, subject: "support", customer: "customer-a", permissions: ["agent:access" as const],
      startsAt: now - 1, expiresAt: now + 120, reason: "Test", contractReference: "Test" }],
  };
  const api = createDiagnosticApi(config, async (event) => {
    if (failAudit) throw new Error("Synthetic audit failure");
    events.push(event);
  }, (error) => errors.push(error), undefined, undefined, undefined, undefined, undefined, source);
  const unavailable = createDiagnosticApi(config, async () => {}, (error) => errors.push(error));
  try {
    const base = await listen(api);
    const missing = await listen(unavailable);
    const token = async (subject: string) => new SignJWT({ roles: ["platform-admin"], extension: "9999" })
      .setProtectedHeader({ alg: "RS256", kid: "agent-test" }).setIssuer(issuer).setAudience("diagnostic-api")
      .setSubject(subject).setIssuedAt().setExpirationTime("2m").sign(keys.privateKey);
    const read = async (subject?: string, customer = "customer-a", method = "GET", origin = base) =>
      fetch(`${origin}/api/customers/${customer}/agent/profile?subject=bob&extension=9999`, {
        method, headers: subject ? { Authorization: `Bearer ${await token(subject)}` } : {},
      });
    for (const subject of [undefined, "reader", "support"]) assert.equal((await read(subject)).status, subject ? 403 : 401);
    assert.equal((await read("alice", "customer-b")).status, 403);
    assert.equal(lookups, 0, "Denied requests must not inspect the directory");
    const allowed = await read("alice");
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get("cache-control"), "no-store");
    const body = await allowed.json();
    assert.deepEqual(body, { requestId: allowed.headers.get("x-request-id"), customer: "customer-a",
      agent: { extension: "1001", displayName: "Alice <agent>" } });
    assert.equal(events.at(-1)?.operation, "agent-profile");
    assert.equal(events.at(-1)?.subject, "alice");
    assert.equal(events.at(-1)?.requestId, body.requestId);
    assert.equal((await fetch(`${base}/api/customers/customer-a/diagnostics`, {
      headers: { Authorization: `Bearer ${await token("alice")}` },
    })).status, 403, "Agent permission must not grant diagnostics access");
    assert.equal((await (await read("bob", "customer-b")).json()).agent.extension, "2001");
    assert.equal((await read("unassigned")).status, 404);
    const post = await read("alice", "customer-a", "POST");
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
    assert.equal((await read("alice", "customer-a", "GET", missing)).status, 503);
    for (mode of ["failed", "invalid"]) {
      const failed = await read("alice");
      assert.equal(failed.status, 503);
      assert.ok(!(await failed.text()).includes("private"));
    }
    mode = "valid";
    failAudit = true;
    const blocked = await read("alice");
    assert.equal(blocked.status, 503);
    assert.ok(!(await blocked.text()).includes("1001"));
    failAudit = false;
    assert.equal((await read("alice")).status, 200);
    assert.equal(errors.length, 3);
  } finally { await close(api); await close(unavailable); await close(identity); }
});
