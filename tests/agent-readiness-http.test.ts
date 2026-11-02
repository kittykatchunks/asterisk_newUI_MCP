import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createAgentDirectory, type AgentDirectory } from "../src/agent-directory.ts";
import { createDiagnosticApi, type AccessAudit } from "../src/diagnostic-api.ts";
import type { PbxEndpointSource } from "../src/pbx-status.ts";

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

test("agent readiness is session-bound, self-only, read-only and audited", async () => {
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let issuerUrl = "";
  let nonce = "";
  const sign = (subject: string, audience: string, claims = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "readiness-test" }).setIssuer(issuerUrl)
    .setSubject(subject).setAudience(audience).setIssuedAt().setExpirationTime("2m").sign(keys.privateKey);
  const identity = createServer(async (request, response) => {
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "readiness-test" }] })); return;
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
  let time = Date.now();
  let profileFailure = false;
  let snapshotMode: "complete" | "missing" | "invalid" = "complete";
  let auditFailure = false;
  let sourceCalls = 0;
  let sourceEntered: (() => void) | undefined;
  let releaseSource: (() => void) | undefined;
  let holdSource = false;
  try {
    issuerUrl = await listen(identity);
    const origin = await listen(holder);
    const access = {
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
    const directory = createAgentDirectory([
      { issuer: issuerUrl, subject: "alice", customer: "customer-a", extension: "1001", displayName: "Alice" },
    ]);
    const agents: AgentDirectory = { profile(...args) {
      if (profileFailure) throw new Error("Synthetic private directory failure");
      return directory.profile(...args);
    } };
    const source: PbxEndpointSource = {
      async endpoints(customer) {
        sourceCalls++;
        if (holdSource) {
          holdSource = false;
          sourceEntered?.();
          await new Promise<void>((resolve) => { releaseSource = resolve; });
        }
        const checkedAt = new Date(time).toISOString();
        if (snapshotMode === "invalid") {
          return { customer, checkedAt, endpoints: [{ id: "1001", deviceState: "bad\nstate",
            hasContacts: true, activeChannels: 0 }] };
        }
        const endpoints = [
          { id: "1001", deviceState: "Not in use", hasContacts: true, activeChannels: 0 },
          { id: "1002", deviceState: "private endpoint", hasContacts: false, activeChannels: 7 },
        ];
        return { customer, checkedAt, endpoints: snapshotMode === "missing" ? [endpoints[1]] : endpoints };
      },
    };
    const audit = async (event: AccessAudit) => {
      if (auditFailure && event.outcome === "agent_readiness_checked") throw new Error("Synthetic audit failure");
      events.push(event);
    };
    const sessionConfig = {
      origin, issuer: issuerUrl, authorizationEndpoint: issuerUrl + "/authorize",
      tokenEndpoint: issuerUrl + "/token", jwksUrl: issuerUrl + "/jwks",
      clientId: "client", clientSecret: "synthetic-client-secret", audience: "api", allowLoopbackHttpForTests: true,
    };
    const api = createDiagnosticApi(access, audit, (error) => errors.push(error),
      undefined, undefined, sessionConfig, undefined, source, agents);
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
      return { cookie, csrf: info.csrf as string };
    };
    type Login = Awaited<ReturnType<typeof login>>;
    const check = (session?: Login, customer = "customer-a", method = "GET") => fetch(
      `${origin}/api/customers/${customer}/agent/readiness`,
      { method, headers: { ...(session ? { Cookie: session.cookie, Origin: origin,
        "X-CSRF-Token": session.csrf } : {}) } });
    const logout = (session: Login) => fetch(origin + "/auth/logout", { method: "POST",
      headers: { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } });

    assert.equal((await check()).status, 401);
    assert.equal((await check(undefined, "customer-a", "POST")).status, 401);
    const alice = await login();
    assert.equal((await check(alice, "customer-b")).status, 403);
    assert.equal((await check(await login("reader"))).status, 403);
    assert.equal((await check(await login("support"))).status, 403);
    assert.equal((await check(await login("unassigned"))).status, 404);
    assert.equal((await check(alice, "customer-a", "POST")).status, 405);
    assert.equal(sourceCalls, 0, "Denied and wrong-method requests must not query PBX data");

    const response = await check(alice);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await response.json();
    assert.deepEqual(Object.keys(body).sort(),
      ["activeChannels", "checkedAt", "contactObserved", "customer", "deviceState", "extension", "requestId"]);
    assert.equal(body.customer, "customer-a");
    assert.equal(body.extension, "1001");
    assert.equal(body.deviceState, "Not in use");
    assert.equal(body.contactObserved, true);
    assert.equal(body.activeChannels, 0);
    assert.ok(!JSON.stringify(body).includes("1002"));
    assert.equal(events.at(-1)?.operation, "agent-readiness");
    assert.equal(events.at(-1)?.outcome, "agent_readiness_checked");

    snapshotMode = "missing";
    const missing = await (await check(alice)).json();
    assert.equal(missing.extension, "1001");
    assert.equal(missing.deviceState, "Not observed");
    assert.equal(missing.contactObserved, false);
    snapshotMode = "invalid";
    assert.equal((await check(alice)).status, 503);
    assert.equal(errors.length, 1, "Malformed source data is logged without leaking it");
    snapshotMode = "complete";
    profileFailure = true;
    assert.equal((await check(alice)).status, 503);
    assert.equal(errors.length, 2);
    profileFailure = false;
    auditFailure = true;
    assert.equal((await check(alice)).status, 503);
    assert.equal(errors.length, 3);
    auditFailure = false;

    let enteredResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
    sourceEntered = enteredResolve;
    holdSource = true;
    const lateCheck = check(alice);
    await entered;
    await logout(alice);
    releaseSource?.();
    const lateResponse = await lateCheck;
    assert.equal(lateResponse.status, 401, "A session ended during the source query must not receive results");
    assert.ok(!lateResponse.headers.get("content-type")?.includes("text/html"));
    assert.ok(!(await lateResponse.text()).includes("1001"));
    assert.deepEqual(errors.length, 3);
  } finally {
    await close(holder);
    await close(identity);
  }
});
