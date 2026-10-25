import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { AccessConfig } from "../src/access.ts";
import { openBookingSimulation } from "../src/booking-simulation.ts";
import { createDiagnosticApi, type AccessAudit } from "../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../src/diagnostic-store.ts";

const details = { pickup: "customer-a-station", destination: "customer-a-hotel",
  passenger: "Synthetic Alice", contact: "test-contact-alice", passengers: 2 };
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
interface Login { cookie: string; csrf: string }
async function fixture(action: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await action(context); }
  finally { await context.close(); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "simulation-http-"));
  const path = join(directory, "simulation.sqlite");
  const audits = openDiagnosticStore(join(directory, "audit.sqlite"));
  const controls: {
    auditFailure?: string; effectFailure?: boolean; heldOutcome?: string;
    entered?: () => void; gate?: Promise<void>;
  } = {};
  const open = () => openBookingSimulation(path, { afterEffect() {
    if (controls.effectFailure) throw new Error("Synthetic private after-effect failure");
  } });
  let store = open();
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  let issuer = "";
  let nonce = "";
  const sign = (subject: string, audience = "api", claims = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "simulation" }).setIssuer(issuer)
    .setSubject(subject).setAudience(audience).setIssuedAt().setExpirationTime("2m").sign(keys.privateKey);
  const identity = createServer(async (request, response) => {
    if (request.url === "/jwks") {
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "simulation" }] })); return;
    }
    if (request.url !== "/token") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += chunk;
    const subject = new URLSearchParams(body).get("code")!;
    response.end(JSON.stringify({ access_token: await sign(subject),
      id_token: await sign(subject, "client", { nonce }) }));
  });
  const holder = createServer();
  const events: AccessAudit[] = [];
  const errors: unknown[] = [];
  try {
    issuer = await listen(identity);
    const origin = await listen(holder);
    const config: AccessConfig = {
      issuer, audience: "api", jwksUrl: issuer + "/jwks", allowLoopbackHttpForTests: true,
      memberships: [
        ...["alice", "other-agent"].map((subject) => ({ issuer, subject, customer: "customer-a",
          permissions: ["agent:access", "booking:simulate"] as const })),
        { issuer, subject: "alice", customer: "customer-b", permissions: ["agent:access", "booking:simulate"] },
        { issuer, subject: "agent-only", customer: "customer-a", permissions: ["agent:access"] },
        { issuer, subject: "simulation-only", customer: "customer-a", permissions: ["booking:simulate"] },
        { issuer, subject: "reader", customer: "customer-a", permissions: ["diagnostics:read"] },
      ],
      supportGrants: [{ issuer, subject: "support", customer: "customer-a",
        permissions: ["agent:access", "booking:simulate"], startsAt: Date.now() / 1000 - 1,
        expiresAt: Date.now() / 1000 + 120, reason: "Synthetic", contractReference: "Synthetic" }],
    };
    const sessionConfig = { origin, issuer, authorizationEndpoint: issuer + "/authorize",
      tokenEndpoint: issuer + "/token", jwksUrl: issuer + "/jwks", clientId: "client",
      clientSecret: "synthetic-client-secret", audience: "api", allowLoopbackHttpForTests: true };
    const audit = async (event: AccessAudit) => {
      if (event.outcome === controls.auditFailure) throw new Error("Synthetic private audit failure");
      if (event.outcome === controls.heldOutcome && controls.gate) {
        controls.entered?.(); await controls.gate;
      }
      await audits.audit(event);
      events.push(event);
    };
    const build = (enabled = true) => createDiagnosticApi(config, audit, (error) => errors.push(error),
      undefined, undefined, sessionConfig, undefined, undefined, undefined, undefined, enabled ? store : undefined);
    let api = build();
    holder.on("request", (request, response) => api.emit("request", request, response));
    const login = async (subject = "alice", customer = "customer-a", workspace = "agent"): Promise<Login> => {
      const start = await fetch(`${origin}/auth/login?customer=${customer}&workspace=${workspace}`, { redirect: "manual" });
      const location = new URL(start.headers.get("location")!);
      nonce = location.searchParams.get("nonce")!;
      const completed = await fetch(`${origin}/auth/callback?state=${location.searchParams.get("state")}&code=${subject}`, {
        redirect: "manual", headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] },
      });
      assert.equal(completed.status, 302);
      assert.equal(completed.headers.get("location"), workspace === "simulation" ? `/simulation/${customer}` : `/agent/${customer}`);
      const cookie = completed.headers.getSetCookie().find((value) => value.startsWith("asterisk-test-session="))!.split(";")[0];
      const info = await (await fetch(origin + "/auth/session", { headers: { Cookie: cookie } })).json();
      return { cookie, csrf: info.csrf };
    };
    const call = (session: Login | undefined, path = "conversations", body?: unknown,
      options: { method?: string; customer?: string; headers?: Record<string, string>; raw?: string } = {}) =>
      fetch(`${origin}/api/customers/${options.customer ?? "customer-a"}/booking-simulation/${path}`, {
        method: options.method ?? (body === undefined ? "GET" : "POST"),
        headers: { "Content-Type": "application/json",
          ...(session ? { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } : {}),
          ...options.headers },
        ...(body !== undefined ? { body: options.raw ?? JSON.stringify(body) } : {}),
      });
    const result = async (response: Response) => {
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      const value = await response.json();
      assert.equal(value.simulation, true);
      assert.equal(value.requestId, response.headers.get("x-request-id"));
      return value.result;
    };
    const conversation = async (session: Login) => (await result(await call(session, "conversations", {}))).conversation as string;
    const draft = async (session: Login, conversationId?: string) => {
      const id = conversationId ?? await conversation(session);
      return result(await call(session, `conversations/${id}/drafts`, { details }));
    };
    const logout = (session: Login) => fetch(origin + "/auth/logout", { method: "POST",
      headers: { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } });
    return { origin, path, events, errors, controls, login, call, result, conversation, draft, logout, sign,
      get store() { return store; },
      disable() { api = build(false); },
      reopen() { store.close(); store = open(); api = build(); },
      assertSessionRequiredAtStartup() {
        assert.throws(() => createDiagnosticApi(config, audit, () => {},
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, store),
        /requires application sessions/);
      },
      auditRows() {
        const reader = new DatabaseSync(join(directory, "audit.sqlite"), { readOnly: true });
        try { return reader.prepare("SELECT request_id, outcome, booking_operation FROM access_audit").all(); }
        finally { reader.close(); }
      },
      effects() {
        const reader = new DatabaseSync(path, { readOnly: true });
        try { return reader.prepare("SELECT count(*) AS total FROM simulated_dispatch").get()?.total; }
        finally { reader.close(); }
      },
      async close() {
        await close(holder); await close(identity); store.close(); audits.close();
        await rm(directory, { recursive: true });
      },
    };
  } catch (error) {
    if (holder.listening) await close(holder);
    if (identity.listening) await close(identity);
    store.close(); audits.close(); await rm(directory, { recursive: true }); throw error;
  }
}

test("SW-01/02/03: session, two explicit grants, CSRF and persistent owner scope gate the simulation API", { timeout: 15000 }, async () => {
  await fixture(async (c) => {
    c.assertSessionRequiredAtStartup();
    assert.equal((await c.call(undefined)).status, 401);
    assert.equal((await c.call(undefined, "conversations", {}, {
      headers: { Authorization: `Bearer ${await c.sign("alice")}` },
    })).status, 401);
    for (const subject of ["agent-only", "simulation-only", "reader", "support"]) {
      assert.equal((await c.call(await c.login(subject))).status, 403);
    }
    const alice = await c.login();
    assert.equal((await c.call(alice, "conversations", undefined, { headers: { "X-CSRF-Token": "" } })).status, 403,
      "An old tab must not read through a different session cookie");
    const absoluteTarget = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(c.origin, {
        path: `${c.origin}/api/customers/customer-a/booking-simulation/conversations`,
        headers: { Cookie: alice.cookie },
      }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
      request.once("error", reject); request.end();
    });
    assert.equal(absoluteTarget, 403, "Absolute-form request targets must enforce the same read-session binding");
    const rotated = await c.login();
    assert.equal((await c.call(alice, "conversations", undefined, { headers: { Cookie: rotated.cookie } })).status, 403);
    const invalidHeaders: Record<string, string>[] = [
      { "X-CSRF-Token": "" }, { Origin: "https://foreign.example" },
      { "Sec-Fetch-Site": "cross-site" }, { Authorization: `Bearer ${await c.sign("alice")}` },
    ];
    for (const headers of invalidHeaders) assert.equal((await c.call(alice, "conversations", {}, { headers })).status, 403);
    assert.equal((await c.call(alice, "conversations", undefined, { customer: "customer-b" })).status, 403);
    const draft = await c.draft(alice);
    const other = await c.login("other-agent");
    const foreign = await c.login("alice", "customer-b");
    for (const session of [other, foreign]) {
      const options = { customer: session === foreign ? "customer-b" : "customer-a" };
      const listed = await c.result(await c.call(session, "conversations", undefined, options));
      assert.deepEqual(listed.conversations, []);
      assert.equal((await c.call(session, `conversations/${draft.conversation}/drafts`, { details }, options)).status, 404);
      for (const [action, body] of [
        ["", undefined], ["/edit", { details, revision: 1 }], ["/review", { revision: 1 }], ["/confirm", { revision: 1 }],
        ["/submit", { scenario: "accept", revision: 1 }], ["/reconcile", {}], ["/handover", { reason: "human_requested" }],
      ] as const) {
        const denied = await c.call(session, `operations/${draft.id}${action}`, body, options);
        assert.equal(denied.status, 404);
        assert.ok(!(await denied.text()).includes("Synthetic Alice"));
      }
    }
    assert.equal(c.effects(), 0);
    const enabledPage = await fetch(c.origin + "/simulation/customer-a");
    assert.equal(enabledPage.status, 200);
    assert.match(enabledPage.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    assert.match(await enabledPage.text(), /SIMULATION ONLY/);
    const simulationLogin = await c.login("alice", "customer-a", "simulation");
    const navigation = await fetch(c.origin + "/agent/customer-a", { headers: { Cookie: simulationLogin.cookie } });
    assert.match(await navigation.text(), /id="simulation-link"/);
    const deniedNavigation = await fetch(c.origin + "/agent/customer-a", { headers: { Cookie: (await c.login("agent-only")).cookie } });
    assert.ok(!(await deniedNavigation.text()).includes('id="simulation-link"'));
    c.disable();
    assert.equal((await c.call(await c.login())).status, 503);
    assert.equal((await fetch(c.origin + "/simulation/customer-a")).status, 503);
    assert.equal((await fetch(c.origin + "/auth/login?customer=customer-a&workspace=simulation")).status, 503);
    assert.equal(c.errors.length, 0);
  });
});

test("SW-04/05/06/07/08: strict synthetic HTTP workflow retains confirmation, outcomes and explicit restart recovery", { timeout: 15000 }, async () => {
  await fixture(async (c) => {
    let alice = await c.login();
    assert.deepEqual((await c.result(await c.call(alice))).conversations, []);
    const conversation = (await c.result(await c.call(alice, "conversations", {},
      { raw: "{}" + " ".repeat(2046) }))).conversation;
    for (const body of [{ owner: "alice" }, { customer: "customer-a" }, { conversation }]) {
      assert.equal((await c.call(alice, "conversations", body)).status, 400);
    }
    assert.equal((await c.call(alice, "conversations?customer=customer-b")).status, 400);
    assert.equal((await c.call(alice, "conversations", {}, { method: "PUT" })).status, 405);
    assert.equal((await c.call(alice, "unknown")).status, 404);
    assert.equal((await c.call(alice, "conversations", {}, { raw: "{" })).status, 400);
    assert.equal((await c.call(alice, "conversations", {}, { raw: " ".repeat(2049) })).status, 413);
    assert.equal((await c.call(alice, "conversations", {}, { headers: { "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await c.call(alice, "conversations", {}, { headers: { "Content-Encoding": "gzip" } })).status, 415);
    assert.equal((await c.call(alice, `conversations/${conversation}/drafts`, {
      details: { ...details, advanceTime: "tomorrow" },
    })).status, 400);
    const draft = await c.draft(alice, conversation);
    const op = `operations/${draft.id}`;
    assert.equal((await c.call(alice, op + "/submit", { scenario: "accept", revision: 1 })).status, 409);
    assert.equal((await c.call(alice, op + "/confirm", { revision: 1 })).status, 409);
    const reviewed = await c.result(await c.call(alice, op + "/review", { revision: 1 }));
    assert.match(reviewed.summary, /^SIMULATION: book now/);
    await c.result(await c.call(alice, op + "/confirm", { revision: 1 }));
    await c.result(await c.call(alice, op + "/edit", { details: { ...details, passengers: 3 }, revision: 1 }));
    assert.equal((await c.call(alice, op + "/edit", { details, revision: 1 })).status, 409);
    assert.equal((await c.call(alice, op + "/review", { revision: 1 })).status, 409);
    await c.result(await c.call(alice, op + "/review", { revision: 2 }));
    assert.equal((await c.call(alice, op + "/confirm", { revision: 1 })).status, 409);
    await c.result(await c.call(alice, op + "/confirm", { revision: 2 }));
    assert.equal((await c.call(alice, op + "/submit", { scenario: "invented", revision: 2 })).status, 400);
    assert.equal((await c.call(alice, op + "/confirm", { revision: "2" })).status, 400);
    assert.equal((await c.call(alice, op + "/submit", { scenario: "accept", revision: 1 })).status, 409);
    const outcomes = await Promise.all([1, 2].map(() => c.call(alice, op + "/submit", { scenario: "lose-reply", revision: 2 })));
    for (const outcome of outcomes) assert.equal((await c.result(outcome)).state, "outcome unknown");
    assert.equal(c.effects(), 1);
    assert.equal((await c.call(alice, `conversations/${conversation}/drafts`, { details })).status, 409);
    const unknown = await c.result(await c.call(alice, op + "/handover", { reason: "caller_disconnected" }));
    assert.equal(unknown.state, "outcome unknown");
    assert.equal(unknown.handoverReason, "caller_disconnected");
    assert.equal(unknown.reference, null);
    // A response discarded by the caller must still be discoverable, not automatically recreated.
    await c.call(alice, "conversations", {});
    const recoveredList = await c.result(await c.call(alice));
    assert.equal(recoveredList.conversations.length, 2);
    assert.equal(recoveredList.conversations.flatMap((entry: { operations: unknown[] }) => entry.operations).length, 1);
    const empty = recoveredList.conversations.find((entry: { operations: unknown[] }) => entry.operations.length === 0);
    await c.call(alice, `conversations/${empty.conversation}/drafts`, { details });
    const recoveredDrafts = await c.result(await c.call(alice));
    assert.equal(recoveredDrafts.conversations.flatMap((entry: { operations: unknown[] }) => entry.operations).length, 2);
    assert.equal(c.effects(), 1, "Recovering a lost creation receipt must not submit or recreate");
    c.reopen();
    assert.equal((await c.call(alice)).status, 401);
    alice = await c.login();
    assert.equal((await c.result(await c.call(alice, op))).state, "outcome unknown");
    assert.equal((await c.result(await c.call(alice, op + "/reconcile", {}))).state, "accepted");
    assert.equal(c.effects(), 1);
    for (const scenario of ["accept", "reject", "unresolved"]) {
      const next = await c.draft(alice, conversation);
      const path = `operations/${next.id}`;
      await c.result(await c.call(alice, path + "/review", { revision: 1 }));
      await c.result(await c.call(alice, path + "/confirm", { revision: 1 }));
      const settled = await c.result(await c.call(alice, path + "/submit", { scenario, revision: 1 }));
      assert.equal(settled.state, scenario === "accept" ? "accepted" : scenario === "reject" ? "rejected" : "outcome unknown");
      assert.equal(settled.reference, scenario === "accept" ? `SIM-${next.id}` : null);
      if (scenario === "unresolved") {
        assert.equal((await c.result(await c.call(alice, path + "/reconcile", {}))).state, "outcome unknown");
      }
    }
    assert.equal(c.effects(), 4);
    assert.equal(c.errors.length, 0);
  });
});

test("SW-02/10: audit failure and logout fence mutation; after-effect failure stays explicit and recoverable", { timeout: 15000 }, async () => {
  await fixture(async (c) => {
    const alice = await c.login();
    c.controls.auditFailure = "simulation_conversation_requested";
    const auditFailed = await c.call(alice, "conversations", {});
    assert.equal(auditFailed.status, 503);
    assert.equal((await auditFailed.json()).simulation, true);
    c.controls.auditFailure = undefined;
    assert.deepEqual((await c.result(await c.call(alice))).conversations, []);
    const draft = await c.draft(alice);
    const op = `operations/${draft.id}`;
    await c.result(await c.call(alice, op + "/review", { revision: 1 }));
    await c.result(await c.call(alice, op + "/confirm", { revision: 1 }));
    c.controls.auditFailure = "simulation_submit_requested";
    assert.equal((await c.call(alice, op + "/submit", { scenario: "accept", revision: 1 })).status, 503);
    c.controls.auditFailure = undefined;
    assert.equal(c.effects(), 0);
    assert.equal((await c.result(await c.call(alice, op))).state, "awaiting confirmation");
    c.controls.auditFailure = "simulation_read_view_requested";
    const hidden = await c.call(alice, op);
    assert.equal(hidden.status, 503);
    assert.ok(!(await hidden.text()).includes("Synthetic Alice"));
    c.controls.auditFailure = undefined;
    c.controls.effectFailure = true;
    const failed = await c.call(alice, op + "/submit", { scenario: "accept", revision: 1 });
    const reference = failed.headers.get("x-request-id");
    assert.equal(failed.status, 503);
    assert.ok(!(await failed.text()).includes("private"));
    assert.equal((await c.result(await c.call(alice, op))).state, "submitting");
    assert.equal(c.effects(), 1);
    assert.equal((await c.call(alice, op + "/submit", { scenario: "accept", revision: 1 })).status, 409);
    const intent = c.auditRows().find((row) => row.request_id === reference);
    assert.equal(intent?.outcome, "simulation_submit_requested");
    assert.equal(intent?.booking_operation, draft.id);
    c.controls.effectFailure = false;
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { c.controls.entered = resolve; });
    c.controls.gate = new Promise<void>((resolve) => { resume = resolve; });
    c.controls.heldOutcome = "simulation_reconcile_requested";
    const pending = c.call(alice, op + "/reconcile", {});
    await entered;
    assert.equal((await c.logout(alice)).status, 200);
    resume();
    assert.equal((await pending).status, 401);
    c.controls.gate = undefined;
    const fresh = await c.login();
    assert.equal((await c.result(await c.call(fresh, op))).state, "submitting");
    assert.equal((await c.result(await c.call(fresh, op + "/reconcile", {}))).state, "accepted");
    assert.equal(c.effects(), 1);
    const safeAudit = JSON.stringify(c.events);
    assert.ok(!safeAudit.includes("Synthetic Alice"));
    assert.ok(!safeAudit.includes("test-contact-alice"));
    assert.ok(!safeAudit.includes(alice.cookie.split("=")[1]));
    assert.equal(c.errors.length, 4);
    const corrupt = new DatabaseSync(c.path);
    try {
      corrupt.prepare(`UPDATE simulated_bookings
        SET record = json_set(record, '$.details.passenger', 'Invalid private stored name') WHERE id = ?`).run(draft.id);
    } finally { corrupt.close(); }
    const unavailable = await c.call(fresh, op);
    assert.equal(unavailable.status, 503, "Stored corruption is unavailability, not invalid user input");
    assert.ok(!(await unavailable.text()).includes("private"));
    assert.equal(c.errors.length, 5);
  });
});

test("SW-05: a competing tab cannot submit a newer confirmed payload using its stale displayed revision", { timeout: 15000 }, async () => {
  await fixture(async (c) => {
    const first = await c.login();
    const second = await c.login();
    const draft = await c.draft(first);
    const op = `operations/${draft.id}`;
    await c.result(await c.call(first, op + "/review", { revision: 1 }));
    await c.result(await c.call(first, op + "/confirm", { revision: 1 }));
    let resume!: () => void;
    const entered = new Promise<void>((resolve) => { c.controls.entered = resolve; });
    c.controls.gate = new Promise<void>((resolve) => { resume = resolve; });
    c.controls.heldOutcome = "simulation_submit_requested";
    const stale = c.call(first, op + "/submit", { revision: 1, scenario: "accept" });
    await entered;
    await c.result(await c.call(second, op + "/edit", { details: { ...details, passengers: 4 }, revision: 1 }));
    await c.result(await c.call(second, op + "/review", { revision: 2 }));
    await c.result(await c.call(second, op + "/confirm", { revision: 2 }));
    resume();
    assert.equal((await stale).status, 409);
    assert.equal(c.effects(), 0);
    c.controls.gate = undefined;
    const accepted = await c.result(await c.call(second, op + "/submit", { revision: 2, scenario: "accept" }));
    assert.equal(accepted.state, "accepted");
    assert.equal(accepted.details.passengers, 4);
    assert.equal(c.effects(), 1);
    assert.equal(c.errors.length, 0);
  });
});
