import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentDirectory, type AgentDirectory } from "../src/agent-directory.ts";
import { openAgentDeviceLeaseStore, type AgentDeviceLeaseStore } from "../src/agent-device-lease.ts";
import { createDiagnosticApi, type AccessAudit } from "../src/diagnostic-api.ts";

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

test("device lease API requires a scoped CSRF session, membership, assignment and audited ownership", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-device-http-"));
  let time = Date.now();
  const leases = openAgentDeviceLeaseStore(join(directory, "leases.sqlite"), { now: () => time });
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let issuerUrl = "";
  let nonce = "";
  const sign = (subject: string, audience: string, claims = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "device-http" }).setIssuer(issuerUrl)
    .setSubject(subject).setAudience(audience).setIssuedAt().setExpirationTime("2m").sign(keys.privateKey);
  const identity = createServer(async (request, response) => {
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "device-http" }] })); return;
    }
    if (request.url !== "/token") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const subject = new URLSearchParams(body).get("code")!;
    response.end(JSON.stringify({ access_token: await sign(subject, "api"),
      id_token: await sign(subject, "client", { nonce }) }));
  });
  const holder = createServer();
  const events: AccessAudit[] = [];
  const errors: unknown[] = [];
  let auditFailure: string | undefined;
  let entered: (() => void) | undefined;
  let gate: Promise<void> | undefined;
  let storeFailure = false;
  let mutations = 0;
  let profileMode = "valid";
  try {
    issuerUrl = await listen(identity);
    const origin = await listen(holder);
    const config = {
      issuer: issuerUrl, audience: "api", jwksUrl: issuerUrl + "/jwks", allowLoopbackHttpForTests: true,
      memberships: [
        { issuer: issuerUrl, subject: "alice", customer: "customer-a", permissions: ["agent:access" as const] },
        { issuer: issuerUrl, subject: "alice", customer: "customer-b", permissions: ["agent:access" as const] },
        { issuer: issuerUrl, subject: "unassigned", customer: "customer-a", permissions: ["agent:access" as const] },
        { issuer: issuerUrl, subject: "reader", customer: "customer-a", permissions: ["diagnostics:read" as const] },
      ],
      supportGrants: [{ issuer: issuerUrl, subject: "support", customer: "customer-a",
        permissions: ["agent:access" as const], startsAt: time / 1000 - 1, expiresAt: time / 1000 + 120,
        reason: "Synthetic", contractReference: "Synthetic" }],
    };
    const assignments = createAgentDirectory(["customer-a", "customer-b"].map((customer) =>
      ({ issuer: issuerUrl, subject: "alice", customer, extension: "1001", displayName: "Alice" })));
    const agents: AgentDirectory = { profile(...args) {
      if (profileMode === "failed") throw new Error("Synthetic private directory failure");
      if (profileMode === "invalid") return { extension: "private", displayName: "" };
      return assignments.profile(...args);
    } };
    const source: AgentDeviceLeaseStore = {
      current(owner, id) { return leases.current(owner, id); },
      acquire(owner) { mutations++; if (storeFailure) throw new Error("Synthetic private SQLite failure"); return leases.acquire(owner); },
      renew(owner, id) { mutations++; return leases.renew(owner, id); },
      release(owner, id) { mutations++; leases.release(owner, id); },
      close() {},
    };
    const audit = async (event: AccessAudit) => {
      if (event.outcome === auditFailure) throw new Error("Synthetic audit failure");
      if (event.outcome === "agent_device_acquire_requested" && gate) {
        entered?.(); await gate;
      }
      assert.ok(!events.some((record) => record.requestId === event.requestId), "Audit IDs must remain unique");
      events.push(event);
    };
    const sessionConfig = {
      origin, issuer: issuerUrl, authorizationEndpoint: issuerUrl + "/authorize",
      tokenEndpoint: issuerUrl + "/token", jwksUrl: issuerUrl + "/jwks",
      clientId: "client", clientSecret: "synthetic-client-secret", audience: "api", allowLoopbackHttpForTests: true,
    };
    let api = createDiagnosticApi(config, audit, (error) => errors.push(error),
      undefined, undefined, sessionConfig, undefined, undefined, agents, source);
    holder.on("request", (request, response) => api.emit("request", request, response));
    const login = async (subject = "alice", customer = "customer-a") => {
      const start = await fetch(`${origin}/auth/login?customer=${customer}&workspace=agent`, { redirect: "manual" });
      const location = new URL(start.headers.get("location")!);
      nonce = location.searchParams.get("nonce")!;
      const completed = await fetch(`${origin}/auth/callback?state=${location.searchParams.get("state")}&code=${subject}`, {
        redirect: "manual", headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] },
      });
      assert.equal(completed.status, 302);
      const cookie = completed.headers.getSetCookie().find((value) => value.startsWith("asterisk-test-session="))!.split(";")[0];
      const info = await (await fetch(origin + "/auth/session", { headers: { Cookie: cookie } })).json();
      return { cookie, csrf: info.csrf as string, expiresAt: info.expiresAt as string };
    };
    type Login = Awaited<ReturnType<typeof login>>;
    const call = (session?: Login, action = "", body: unknown = { deviceId: randomUUID() },
      options: { customer?: string; headers?: Record<string, string>; method?: string; raw?: string } = {}) =>
      fetch(`${origin}/api/customers/${options.customer ?? "customer-a"}/agent/device-lease${action ? "/" + action : ""}`, {
        method: options.method ?? "POST",
        headers: { "Content-Type": "application/json",
          ...(session ? { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } : {}),
          ...options.headers },
        ...((options.method ?? "POST") !== "GET" ? { body: options.raw ?? JSON.stringify(body) } : {}),
      });
    const logout = (session: Login) => fetch(origin + "/auth/logout", { method: "POST",
      headers: { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } });
    assert.equal((await call()).status, 401);
    assert.equal((await call(undefined, "", undefined, { headers: { Authorization: `Bearer ${await sign("alice", "api")}` } })).status, 401);
    const alice = await login();
    const invalidHeaders: Record<string, string>[] = [
      { "X-CSRF-Token": "" }, { Origin: "https://foreign.example" }, { "Sec-Fetch-Site": "cross-site" },
      { Authorization: `Bearer ${await sign("alice", "api")}` },
    ];
    for (const headers of invalidHeaders) assert.equal((await call(alice, "", undefined, { headers })).status, 403);
    assert.equal((await call(alice, "", undefined, { customer: "customer-b" })).status, 403,
      "Even multi-customer members must use a session bound to the requested customer");
    for (const subject of ["reader", "support", "unassigned"]) {
      assert.equal((await call(await login(subject))).status, subject === "unassigned" ? 404 : 403);
    }
    assert.equal(mutations, 0);
    const get = await call(alice, "", undefined, { method: "GET" });
    assert.equal(get.status, 405); assert.equal(get.headers.get("allow"), "POST");
    for (const body of [null, [], {}, { deviceId: "bad" }, { deviceId: randomUUID(), subject: "bob" },
      { deviceId: randomUUID(), sessionId: "forged" }, { deviceId: randomUUID(), leaseId: randomUUID() }]) {
      assert.equal((await call(alice, "", body)).status, 400);
    }
    assert.equal((await call(alice, "renew", { deviceId: randomUUID() })).status, 400);
    assert.equal((await call(alice, "release", { deviceId: randomUUID(), leaseId: "bad" })).status, 400);
    assert.equal((await call(alice, "", {}, { raw: "{" })).status, 400);
    assert.equal((await call(alice, "", {}, { raw: "x".repeat(1025) })).status, 413);
    assert.equal((await call(alice, "", {}, { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await call(alice, "", {}, { headers: { "Content-Encoding": "gzip" } })).status, 415);
    const input = { deviceId: randomUUID() };
    const exactJson = JSON.stringify(input);
    const exact = await call(alice, "", input, { raw: exactJson + " ".repeat(1024 - Buffer.byteLength(exactJson)) });
    assert.equal(exact.status, 200, "A valid body at the exact byte limit must succeed");
    const exactLease = (await exact.json()).lease;
    assert.equal((await call(alice, "release", { ...input, leaseId: exactLease.id })).status, 200);
    const timeout = await new Promise<{ status: number | undefined; code: string }>((resolve, reject) => {
      const request = httpRequest(origin + "/api/customers/customer-a/agent/device-lease", {
        method: "POST", headers: { Cookie: alice.cookie, Origin: origin,
          "X-CSRF-Token": alice.csrf, "Content-Type": "application/json" },
      }, (response) => {
        let text = "";
        response.on("data", (chunk) => { text += chunk; });
        response.once("end", () => {
          try { resolve({ status: response.statusCode, code: JSON.parse(text).code }); }
          catch (error) { reject(error); }
          finally { request.destroy(); }
        });
        response.once("error", reject);
      });
      request.once("error", reject);
      request.write('{"deviceId":');
    });
    assert.deepEqual(timeout, { status: 408, code: "device_lease_body_timeout" });
    const acquired = await call(alice, "", input);
    assert.equal(acquired.status, 200);
    assert.equal(acquired.headers.get("cache-control"), "no-store");
    const body = await acquired.json();
    assert.deepEqual(Object.keys(body).sort(), ["customer", "lease", "requestId"]);
    assert.deepEqual(Object.keys(body.lease).sort(), ["expiresAt", "id"]);
    assert.equal(body.requestId, acquired.headers.get("x-request-id"));
    assert.equal(body.customer, "customer-a");
    assert.equal(body.lease.expiresAt, time + 60000);
    assert.ok(body.lease.expiresAt <= Date.parse(alice.expiresAt));
    assert.equal(events.at(-1)?.outcome, "agent_device_acquire_requested");
    assert.equal(events.at(-1)?.subject, "alice");
    assert.equal(events.at(-1)?.requestId, body.requestId);
    assert.deepEqual((await (await call(alice, "", input)).json()).lease, body.lease);
    const second = await login();
    assert.equal((await call(second, "", input)).status, 409, "Same device, different session must conflict");
    assert.equal((await call(alice)).status, 409);
    const owned = { ...input, leaseId: body.lease.id };
    for (const action of ["renew", "release"]) {
      assert.equal((await call(second, action, owned)).status, 409);
      assert.equal((await call(alice, action, { ...owned, deviceId: randomUUID() })).status, 409);
    }
    time += 1000;
    const renewed = await (await call(alice, "renew", owned)).json();
    assert.equal(renewed.lease.id, body.lease.id);
    assert.equal(renewed.lease.expiresAt, time + 60000);
    assert.equal((await call(alice, "release", owned)).status, 200);
    assert.equal((await call(alice, "renew", owned)).status, 409);
    const replacement = await (await call(second, "", input)).json();
    assert.notEqual(replacement.lease.id, body.lease.id);
    assert.equal((await call(alice, "release", owned)).status, 409);
    assert.equal((await call(second, "release", { ...input, leaseId: replacement.lease.id })).status, 200);
    for (profileMode of ["failed", "invalid"]) {
      const failed = await call(alice, "", input);
      assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes("private"));
    }
    profileMode = "valid";
    auditFailure = "agent_device_acquire_requested";
    const before = mutations;
    assert.equal((await call(alice, "", input)).status, 503);
    assert.equal(mutations, before, "Intent audit failure must prevent any lease mutation");
    auditFailure = undefined;
    const recovered = await (await call(alice, "", input)).json();
    assert.ok(recovered.lease.id);
    assert.equal((await call(alice, "release", { ...input, leaseId: recovered.lease.id })).status, 200);
    storeFailure = true;
    const unavailable = await call(alice, "", input);
    assert.equal(unavailable.status, 503); assert.ok(!(await unavailable.text()).includes("private"));
    storeFailure = false;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    gate = new Promise<void>((resolve) => { resume = resolve; });
    const count = mutations;
    const held = call(alice, "", input);
    await waiting;
    assert.equal((await logout(alice)).status, 200);
    resume();
    assert.equal((await held).status, 401);
    assert.equal(mutations, count, "Logout while audit waits must fence the pending acquisition");
    gate = undefined;
    assert.equal((await call(alice, "renew", owned)).status, 401);
    assert.equal((await call(second, "", input)).status, 200);
    time += 60000;
    assert.equal((await call(second, "", { deviceId: randomUUID() })).status, 200, "Expiry allows a replacement device");
    assert.ok(!JSON.stringify(events).includes(alice.cookie.split("=")[1]));
    assert.ok(!JSON.stringify(events).includes(input.deviceId));
    assert.equal(errors.length, 4);
    api = createDiagnosticApi(config, audit, (error) => errors.push(error),
      undefined, undefined, sessionConfig, undefined, undefined, agents);
    assert.equal((await call(await login(), "", input)).status, 503);
    api = createDiagnosticApi(config, audit, (error) => errors.push(error),
      undefined, undefined, sessionConfig, undefined, undefined, undefined, source);
    assert.equal((await call(await login(), "", input)).status, 503);
    api = createDiagnosticApi(config, audit, (error) => errors.push(error),
      undefined, undefined, undefined, undefined, undefined, agents, source);
    assert.equal((await call()).status, 401);
    assert.equal((await call(undefined, "", input, {
      headers: { Authorization: `Bearer ${await sign("alice", "api")}` },
    })).status, 401);
  } finally { await close(holder); await close(identity); leases.close(); await rm(directory, { recursive: true }); }
});
