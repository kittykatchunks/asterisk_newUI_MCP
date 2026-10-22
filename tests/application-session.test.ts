import assert from "node:assert/strict";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createDiagnosticApi } from "../src/diagnostic-api.ts";
import type { AccessAudit } from "../src/diagnostic-api.ts";
import { createApplicationSessions } from "../src/application-session.ts";
import { createAccessVerifier } from "../src/access.ts";
import { openAgentDeviceLeaseStore } from "../src/agent-device-lease.ts";
import { createAuthorisedProvisioningTransport } from "../src/agent-provisioning-authorisation.ts";
import { createAgentProvisioningDispatcher } from "../src/agent-provisioning-dispatcher.ts";
import { openAgentProvisioningStore, openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test listener");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("server sessions bind state/cookie/nonce, rotate identifiers, expire, and gate login/logout on audit", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let nonce = "";
  let expired = false;
  let invalidNonce = false;
  let exchangeRejected = false;
  let exchanges = 0;
  let issuerUrl = "";
  const issuer = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "session-key", alg: "RS256", use: "sig" }] }));
      return;
    }
    if (request.url !== "/token" || request.method !== "POST") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parameters = new URLSearchParams(body);
    assert.equal(parameters.get("client_secret"), "synthetic-client-secret");
    assert.equal(parameters.get("grant_type"), "authorization_code");
    assert.ok(parameters.get("code_verifier"));
    exchanges++;
    if (exchangeRejected) { response.writeHead(400).end("{}"); return; }
    const sign = async (audience: string, claims: Record<string, string>) => new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "session-key" }).setSubject("alice")
      .setIssuer(issuerUrl).setAudience(audience).setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (expired ? 2 : 120)).sign(keys.privateKey);
    response.end(JSON.stringify({
      access_token: await sign("diagnostic-api", {}),
      id_token: await sign("application-client", { nonce: invalidNonce ? "invalid" : nonce }),
    }));
  });
  let api: Server | undefined;
  let holder: Server | undefined;
  const audit: AccessAudit[] = [];
  const errors: unknown[] = [];
  let auditFailure = false;
  try {
    issuerUrl = await listen(issuer);
    // Allocate the port before configuring the exact origin, then reuse its
    // bound listener for the server factory's request handler.
    holder = createServer();
    const origin = await listen(holder);
    const sessionConfig = {
      origin, issuer: issuerUrl, authorizationEndpoint: issuerUrl + "/authorize",
      tokenEndpoint: issuerUrl + "/token", jwksUrl: issuerUrl + "/jwks",
      clientId: "application-client", clientSecret: "synthetic-client-secret",
      audience: "diagnostic-api", allowLoopbackHttpForTests: true,
    };
    api = createDiagnosticApi({
      issuer: issuerUrl, jwksUrl: issuerUrl + "/jwks", audience: "diagnostic-api",
      allowLoopbackHttpForTests: true,
      memberships: [{ issuer: issuerUrl, subject: "alice", customer: "customer-a", permissions: ["diagnostics:read"] }],
      supportGrants: [],
    }, async (event) => {
      if (auditFailure) throw new Error("Synthetic application audit failure");
      audit.push(event);
    }, (error) => errors.push(error), undefined, undefined, sessionConfig);
    holder.on("request", (request, response) => api!.emit("request", request, response));
    const begin = async (headers: Record<string, string> = {}, workspace = "reviews") => {
      const response = await fetch(origin + `/auth/login?customer=customer-a&workspace=${encodeURIComponent(workspace)}`, { headers, redirect: "manual" });
      assert.equal(response.status, 302);
      const authorization = new URL(response.headers.get("location")!);
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.ok(authorization.searchParams.get("code_challenge"));
      nonce = authorization.searchParams.get("nonce")!;
      return {
        callback: origin + "/auth/callback?code=synthetic-code&state=" + authorization.searchParams.get("state"),
        cookie: response.headers.get("set-cookie")!.split(";")[0],
      };
    };
    const complete = async (login: Awaited<ReturnType<typeof begin>>, sessionCookie = "") => fetch(login.callback, {
      redirect: "manual", headers: { Cookie: [login.cookie, sessionCookie].filter(Boolean).join("; ") },
    });
    const sessionCookie = (response: Response) => {
      const value = response.headers.getSetCookie().find((cookie) => cookie.startsWith("asterisk-test-session="));
      assert.ok(value);
      assert.match(value, /HttpOnly; SameSite=Lax/);
      return value.split(";")[0];
    };
    assert.equal((await fetch(origin + "/auth/login?customer=../other")).status, 400);
    assert.equal((await fetch(origin + "/auth/login?customer=customer-a&workspace=https://foreign.example")).status, 400);
    assert.equal((await fetch(origin + "/auth/login?customer=customer-a", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(origin + "/auth/logout")).status, 405);
    assert.equal((await fetch(origin + "/auth/session")).status, 401);
    assert.equal((await fetch(origin + "/auth/callback?state=unknown&code=x")).status, 400);
    const unbound = await begin();
    assert.equal((await fetch(unbound.callback)).status, 400);
    assert.equal((await complete(unbound)).status, 400);
    assert.equal(exchanges, 0);
    invalidNonce = true;
    assert.equal((await complete(await begin())).status, 401);
    invalidNonce = false;
    exchangeRejected = true;
    assert.equal((await complete(await begin())).status, 401);
    exchangeRejected = false;
    auditFailure = true;
    const blocked = await complete(await begin());
    assert.equal(blocked.status, 503);
    assert.ok(!blocked.headers.getSetCookie().some((cookie) => cookie.startsWith("asterisk-test-session=")));
    auditFailure = false;
    const firstLogin = await begin();
    const first = await complete(firstLogin);
    assert.equal(first.status, 302);
    assert.equal(first.headers.get("location"), "/engineering/reviews/customer-a");
    const firstCookie = sessionCookie(first);
    assert.equal((await complete(firstLogin)).status, 400);
    const second = await complete(await begin({}, "agent"), firstCookie);
    assert.equal(second.headers.get("location"), "/agent/customer-a");
    const secondCookie = sessionCookie(second);
    assert.notEqual(firstCookie, secondCookie);
    assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: firstCookie } })).status, 401);
    const bootstrap = await fetch(origin + "/auth/session", { headers: { Cookie: secondCookie } });
    assert.equal(bootstrap.status, 200);
    const info = await bootstrap.json();
    assert.ok(info.csrf);
    assert.equal(info.customer, "customer-a");
    assert.ok(!JSON.stringify(info).includes("eyJ"));
    assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: secondCookie, "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await fetch(origin + "/api/customers/customer-a/diagnostics", { headers: { Cookie: secondCookie } })).status, 200);
    assert.equal((await fetch(origin + "/api/customers/customer-b/diagnostics", { headers: { Cookie: secondCookie } })).status, 403);
    assert.equal((await fetch(origin + "/api/customers/customer-a/diagnostics", {
      headers: { Cookie: secondCookie, Authorization: "Bearer ambiguous" },
    })).status, 403);
    const invalidCsrfHeaders: Record<string, string>[] = [
      { Cookie: secondCookie, Origin: origin },
      { Cookie: secondCookie, Origin: "https://untrusted.invalid", "X-CSRF-Token": info.csrf },
      { Cookie: secondCookie, Origin: origin, "X-CSRF-Token": "wrong" },
    ];
    for (const headers of invalidCsrfHeaders) assert.equal((await fetch(origin + "/auth/logout", { method: "POST", headers })).status, 403);
    const logoutHeaders = { Cookie: secondCookie, Origin: origin, "X-CSRF-Token": info.csrf };
    auditFailure = true;
    assert.equal((await fetch(origin + "/auth/logout", { method: "POST", headers: logoutHeaders })).status, 503);
    auditFailure = false;
    assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: secondCookie } })).status, 200);
    assert.equal((await fetch(origin + "/auth/logout", { method: "POST", headers: logoutHeaders })).status, 200);
    assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: secondCookie } })).status, 401);
    expired = true;
    const short = await complete(await begin());
    const shortCookie = sessionCookie(short);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: shortCookie } })).status, 401);
    assert.ok(errors.length === 2);
    assert.ok(!JSON.stringify(audit).includes("synthetic-client-secret"));
    const backendHolder = createServer();
    const backendOrigin = await listen(backendHolder);
    const backendSessions = createApplicationSessions({ ...sessionConfig, origin: backendOrigin });
    backendHolder.on("request", (request, response) => {
      void backendSessions.handle(request, response, randomBytes(16).toString("hex"), async () => {})
        .catch((error) => { errors.push(error); response.writeHead(500).end(); });
    });
    try {
      const loginBackend = async (oldCookie = "") => {
        const login = await fetch(backendOrigin + "/auth/login?customer=customer-a&workspace=agent", { redirect: "manual" });
        assert.equal(login.status, 302);
        const authorization = new URL(login.headers.get("location")!);
        nonce = authorization.searchParams.get("nonce")!;
        const loginCookie = login.headers.get("set-cookie")!.split(";")[0];
        const callback = await fetch(backendOrigin + "/auth/callback?code=fixture&state=" + authorization.searchParams.get("state"), {
          redirect: "manual", headers: { Cookie: [loginCookie, oldCookie].filter(Boolean).join("; ") },
        });
        assert.equal(callback.status, 302);
        const cookie = sessionCookie(callback);
        return { cookie, owner: { issuer: issuerUrl, subject: "alice", customer: "customer-a",
          sessionId: cookie.slice(cookie.indexOf("=") + 1) } };
      };
      expired = false;
      const original = await loginBackend();
      const identity = backendSessions.lookupIdentity(original.owner);
      assert.ok(identity);
      assert.deepEqual(Object.keys(identity).sort(), ["customer", "expiresAt", "sessionId", "subject"]);
      identity.subject = "mutated";
      assert.equal(backendSessions.lookupIdentity(original.owner)?.subject, "alice");
      const verifyAgent = createAccessVerifier({
        issuer: issuerUrl, jwksUrl: issuerUrl + "/jwks", audience: "diagnostic-api",
        allowLoopbackHttpForTests: true,
        memberships: [{ issuer: issuerUrl, subject: "alice", customer: "customer-a", permissions: ["agent:access"] }],
        supportGrants: [],
      });
      const signal = AbortSignal.timeout(10000);
      assert.deepEqual(await backendSessions.verifyAgentAccess(original.owner, verifyAgent, signal),
        { allowed: true, subject: "alice", basis: "membership" });
      const directory = await mkdtemp(join(tmpdir(), "asterisk-session-dispatch-"));
      const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"));
      const provisioning = openAgentProvisioningStore(join(directory, "backend.sqlite"));
      const binding = { customer: "customer-a", epoch: randomUUID() };
      const worker = openAgentProvisioningJournal(join(directory, "worker.sqlite"), binding);
      try {
        const owner = { ...original.owner, deviceId: randomUUID(), sessionExpiresAt: identity.expiresAt };
        const lease = leases.acquire(owner);
        const generationId = randomUUID();
        provisioning.enrol(binding.customer, binding.epoch);
        provisioning.enqueue({ version: 1, ...binding, operationId: randomUUID(), revision: 1,
          leaseId: lease.id, notAfter: lease.expiresAt, action: "prepare",
          payload: { generationId, extension: "1001" } },
        { requestId: randomUUID(), actor: "fixture", reason: "Session-backed dispatch" });
        const guarded = createAuthorisedProvisioningTransport({
          async report(id) { return worker.report(id); },
          async accept(intent) {
            worker.accept(intent.command, intent.context);
            return worker.report(intent.command.operationId)!;
          },
        }, binding, {
          resolve() { return { owner, generationId, extension: "1001" }; },
          session: backendSessions.lookupIdentity,
          agentAccess: (owner, signal) => backendSessions.verifyAgentAccess(owner, verifyAgent, signal),
          agents: { profile() { return { extension: "1001", displayName: "Alice" }; } }, leases,
        });
        assert.equal((await createAgentProvisioningDispatcher(provisioning, binding, guarded).dispatch()).state, "accepted");
        assert.deepEqual(leases.current(owner, lease.id), lease);
      } finally {
        worker.close(); provisioning.close(); leases.close();
        await rm(directory, { recursive: true });
      }
      const noAgent = createAccessVerifier({
        issuer: issuerUrl, jwksUrl: issuerUrl + "/jwks", audience: "diagnostic-api",
        allowLoopbackHttpForTests: true, memberships: [], supportGrants: [],
      });
      assert.deepEqual(await backendSessions.verifyAgentAccess(original.owner, noAgent, signal),
        { allowed: false, status: 403, code: "customer_access_denied" });
      for (const access of [
        { allowed: true as const, subject: "bob", basis: "membership" as const },
        { allowed: true as const, subject: "alice", basis: "support-grant" as const },
      ]) {
        assert.equal((await backendSessions.verifyAgentAccess(original.owner, async () => access, signal)).allowed, false);
      }
      await assert.rejects(backendSessions.verifyAgentAccess(original.owner, async () => {
        throw new Error("fixture verifier failure");
      }, signal), /fixture verifier failure/);
      await assert.rejects(backendSessions.verifyAgentAccess(original.owner, verifyAgent,
        AbortSignal.abort(new Error("fixture cancelled"))), /fixture cancelled/);
      const cancelled = new AbortController();
      await assert.rejects(backendSessions.verifyAgentAccess(original.owner, async () => {
        cancelled.abort(new Error("fixture cancelled during verification"));
        return { allowed: true, subject: "alice", basis: "membership" };
      }, cancelled.signal), /cancelled during verification/);
      assert.deepEqual(await backendSessions.verifyAgentAccess(original.owner, async () => ({
        allowed: false, status: 503, code: "identity_verification_unavailable",
      }), signal), { allowed: false, status: 503, code: "identity_verification_unavailable" });
      for (const owner of [
        { ...original.owner, issuer: "https://foreign.invalid" }, { ...original.owner, subject: "bob" },
        { ...original.owner, customer: "customer-b" },
        { ...original.owner, sessionId: randomBytes(32).toString("base64url") },
      ]) {
        assert.equal(backendSessions.lookupIdentity(owner), undefined);
        assert.deepEqual(await backendSessions.verifyAgentAccess(owner, async () => assert.fail("Foreign owner cannot verify"), signal),
          { allowed: false, status: 401, code: "application_session_required" });
      }
      assert.throws(() => backendSessions.lookupIdentity({ ...original.owner, sessionId: "invalid" }), /Invalid application session ID/);
      let completeRotation!: () => void;
      const rotationGate = new Promise<void>((resolve) => { completeRotation = resolve; });
      const duringRotation = backendSessions.verifyAgentAccess(original.owner, async (...args) => {
        const access = await verifyAgent(...args); await rotationGate; return access;
      }, signal);
      const rotated = await loginBackend(original.cookie);
      completeRotation();
      assert.equal((await duringRotation).allowed, false, "Rotation during verification must fence success");
      assert.equal(backendSessions.lookupIdentity(original.owner), undefined);
      assert.ok(backendSessions.lookupIdentity(rotated.owner));
      const restarted = createApplicationSessions({ ...sessionConfig, origin: backendOrigin });
      assert.equal(restarted.lookupIdentity(rotated.owner), undefined,
        "A fresh process-local session store cannot recover old browser sessions");
      const boot = await fetch(backendOrigin + "/auth/session", { headers: { Cookie: rotated.cookie } });
      const bootInfo = await boot.json();
      assert.equal(bootInfo.sessionId, undefined, "Backend lookup must not change browser bootstrap output");
      let completeLogout!: () => void;
      const logoutGate = new Promise<void>((resolve) => { completeLogout = resolve; });
      const duringLogout = backendSessions.verifyAgentAccess(rotated.owner, async (...args) => {
        const access = await verifyAgent(...args); await logoutGate; return access;
      }, signal);
      const logout = await fetch(backendOrigin + "/auth/logout", { method: "POST", headers: {
        Cookie: rotated.cookie, Origin: backendOrigin, "X-CSRF-Token": bootInfo.csrf,
      } });
      assert.equal(logout.status, 200);
      completeLogout();
      assert.equal((await duringLogout).allowed, false, "Logout during verification must fence success");
      assert.equal(backendSessions.lookupIdentity(rotated.owner), undefined);
      expired = true;
      const shortBackend = await loginBackend();
      assert.ok(backendSessions.lookupIdentity(shortBackend.owner));
      let completeExpiry!: () => void;
      const expiryGate = new Promise<void>((resolve) => { completeExpiry = resolve; });
      const duringExpiry = backendSessions.verifyAgentAccess(shortBackend.owner, async (...args) => {
        const access = await verifyAgent(...args); await expiryGate; return access;
      }, signal);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      completeExpiry();
      assert.equal((await duringExpiry).allowed, false, "Expiry during verification must fence success");
      assert.equal(backendSessions.lookupIdentity(shortBackend.owner), undefined);
    } finally { await close(backendHolder); }
    const secure = createApplicationSessions({ ...sessionConfig, origin: origin.replace("http:", "https:") });
    const secureHolder = createServer((request, response) => {
      request.headers.host = new URL(origin).host;
      void secure.handle(request, response, "secure-cookie-check", async () => {}).catch(() => response.writeHead(500).end());
    });
    const secureOrigin = await listen(secureHolder);
    try {
      const response = await fetch(secureOrigin + "/auth/login?customer=customer-a", {
        redirect: "manual",
      });
      assert.equal(response.status, 302);
      assert.match(response.headers.get("set-cookie") ?? "", /^__Host-asterisk-login=.*; Path=\/; HttpOnly; SameSite=Lax; Secure$/);
    } finally { await close(secureHolder); }
    assert.throws(() => createApplicationSessions({ ...sessionConfig, allowLoopbackHttpForTests: false }), /HTTPS/);
    assert.throws(() => createApplicationSessions({ ...sessionConfig, tokenEndpoint: "https://other.invalid/token" }), /origin mismatch/);
    assert.throws(() => createApplicationSessions({ ...sessionConfig, clientSecret: "" }), /confidential/);
  } finally {
    if (holder) await close(holder);
    await close(issuer);
  }
});
