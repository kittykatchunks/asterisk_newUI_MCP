import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAccessVerifier } from "../src/access.ts";
import { createDiagnosticApi } from "../src/diagnostic-api.ts";
import type { AccessAudit } from "../src/diagnostic-api.ts";
import type { AccessConfig } from "../src/access.ts";

const keys = await generateKeyPair("RS256");
const foreignKeys = await generateKeyPair("RS256");
const audit: AccessAudit[] = [];
const errors: unknown[] = [];
let issuerServer: Server;
let api: Server;
let issuer: string;
let base: string;
let config: AccessConfig;
let auditFailure = false;

async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

before(async () => {
  const jwk = await exportJWK(keys.publicKey);
  issuerServer = createServer((request, response) => {
    if (request.url !== "/jwks") { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] }));
  });
  issuer = await listen(issuerServer);
  const now = Math.floor(Date.now() / 1000);
  config = {
    issuer, audience: "diagnostic-api", jwksUrl: `${issuer}/jwks`,
    allowLoopbackHttpForTests: true,
    memberships: [
      { issuer, subject: "alice", customer: "customer-a", permissions: ["diagnostics:read"] },
      { issuer, subject: "bob", customer: "customer-b", permissions: ["diagnostics:read"] },
    ],
    supportGrants: [
      { issuer, subject: "engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now - 10, expiresAt: now + 120, reason: "Synthetic incident", contractReference: "test-contract" },
      { issuer, subject: "expired-engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now - 100, expiresAt: now - 1, reason: "Expired incident", contractReference: "test-contract" },
      { issuer, subject: "future-engineer", customer: "customer-a", permissions: ["diagnostics:read"],
        startsAt: now + 100, expiresAt: now + 200, reason: "Future incident", contractReference: "test-contract" },
    ],
  };
  api = createDiagnosticApi(config, async (event) => {
    if (auditFailure) throw new Error("Synthetic audit storage failure");
    audit.push(event);
  }, (error) => errors.push(error));
  base = await listen(api);
});

after(async () => {
  await close(api);
  await close(issuerServer);
});

async function token(subject = "alice", overrides: {
  issuer?: string; audience?: string; exp?: number; iat?: number; foreignKey?: boolean;
} = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ roles: ["platform-admin"], customer: "customer-b" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setSubject(subject).setIssuer(overrides.issuer ?? issuer)
    .setAudience(overrides.audience ?? "diagnostic-api")
    .setIssuedAt(overrides.iat ?? now).setExpirationTime(overrides.exp ?? now + 120)
    .sign(overrides.foreignKey ? foreignKeys.privateKey : keys.privateKey);
}

async function access(customer: string, bearer?: string) {
  return fetch(`${base}/api/customers/${customer}/diagnostics`, {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

test("valid OIDC signature and provisioned membership allow only assigned customer", async () => {
  const jwt = await token();
  const allowed = await access("customer-a", jwt);
  assert.equal(allowed.status, 200);
  const body = await allowed.json();
  assert.equal(body.captureEnabled, false);
  assert.equal(body.evidenceServingEnabled, false);
  assert.equal((await access("customer-b", jwt)).status, 403);
  assert.equal((await access("customer-a", await token("bob"))).status, 403);
  assert.equal((await access("customer-b", await token("bob"))).status, 200);
});

test("missing, malformed, expired, future, wrong-issuer/audience/signature tokens fail", async () => {
  assert.equal((await access("customer-a")).status, 401);
  assert.equal((await access("customer-a", "bad.token")).status, 401);
  const now = Math.floor(Date.now() / 1000);
  for (const overrides of [
    { exp: now - 1 }, { iat: now + 100 }, { iat: now - 1000 },
    { issuer: "https://foreign.invalid" }, { audience: "other-api" }, { foreignKey: true },
  ]) {
    assert.equal((await access("customer-a", await token("alice", overrides))).status, 401);
  }
});

test("unknown identity cannot gain privileges from token roles", async () => {
  assert.equal((await access("customer-a", await token("stranger"))).status, 403);
});

test("support elevation is customer-scoped and time-bounded", async () => {
  assert.equal((await access("customer-a", await token("engineer"))).status, 200);
  assert.equal((await access("customer-b", await token("engineer"))).status, 403);
  for (const subject of ["expired-engineer", "future-engineer"]) {
    assert.equal((await access("customer-a", await token(subject))).status, 403);
  }
  assert.ok(audit.some((event) => event.subject === "engineer" && event.basis === "support-grant"));
});

test("audit failure prevents access and logs an explicit operational error", async () => {
  auditFailure = true;
  try {
    const response = await access("customer-a", await token());
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, "diagnostic_access_unavailable");
    assert.equal(errors.length, 1);
  } finally { auditFailure = false; }
});

test("no capture mutation route and no token leakage in audit", async () => {
  const response = await fetch(`${base}/api/customers/customer-a/diagnostics`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal((await fetch(`${base}/api/customers/customer-a/capture`)).status, 404);
  assert.ok(audit.length > 0);
  assert.ok(!JSON.stringify(audit).includes("Bearer"));
  assert.ok(!JSON.stringify(audit).includes("eyJ"));
});

test("unsafe identity URLs and unbounded support grants fail at startup", () => {
  assert.throws(() => createAccessVerifier({ ...config, allowLoopbackHttpForTests: false }), /HTTPS/);
  assert.throws(() => createAccessVerifier({
    ...config, jwksUrl: "http://remote.invalid/jwks",
  }), /HTTPS/);
  assert.throws(() => createAccessVerifier({
    ...config, supportGrants: [{ ...config.supportGrants[0], reason: "" }],
  }), /reason/);
});

test("required expiry claim cannot be omitted", async () => {
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer).setAudience("diagnostic-api").setSubject("alice")
    .setIssuedAt().sign(keys.privateKey);
  assert.equal((await access("customer-a", jwt)).status, 401);
});

test("unavailable JWKS service denies access with an operational response", async () => {
  const temporary = createServer();
  const unavailable = await listen(temporary);
  await close(temporary);
  const verify = createAccessVerifier({ ...config, jwksUrl: `${unavailable}/jwks` });
  const result = await verify(`Bearer ${await token()}`, "customer-a");
  assert.deepEqual(result, {
    allowed: false, status: 503, code: "identity_verification_unavailable",
  });
});

test("later configuration mutation cannot expand existing verifier access", async () => {
  const mutable = structuredClone(config);
  const verify = createAccessVerifier(mutable);
  mutable.memberships = [...mutable.memberships, {
    issuer, subject: "alice", customer: "customer-b", permissions: ["diagnostics:read"],
  }];
  const result = await verify(`Bearer ${await token()}`, "customer-b");
  assert.equal(result.allowed, false);
  if (!result.allowed) assert.equal(result.status, 403);
});
