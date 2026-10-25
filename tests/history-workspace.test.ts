import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { chromium } from "playwright";
import type { AccessConfig } from "../src/access.ts";
import { createDiagnosticApi, type AccessAudit } from "../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../src/diagnostic-store.ts";
import { openCelHistory } from "../src/cel-history.ts";
import { openHistoryProjections } from "../src/history-projection-store.ts";
import { createHistoryReader, historyObservationView } from "../src/history-reader.ts";
import { historySha256 } from "../src/history-evidence.ts";
import { loadLocalHistoryReader } from "../src/local-engineering.ts";

const scope = { customer: "customer-a", runtime: "runtime-a", epoch: "boot-1" };
const selector = "runtime=runtime-a&epoch=boot-1";
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
}
function seed(historyPath: string, projectionPath: string) {
  const history = openCelHistory(historyPath), projections = openHistoryProjections(projectionPath);
  try {
    for (const customer of ["customer-a", "customer-b"]) {
      const route = { context: "history-test", extension: "entry", routeRevision: "route-v1", entryKind: "synthetic" as const };
      const payload = { v: 1, journeyId: "11111111-1111-4111-8111-111111111111", entryKind: "synthetic", routeRevision: "route-v1" };
      const raw = Buffer.from(["CHAN_START", "HISTORY_ENTRY", "ANSWER", "CHAN_END"].map((event) =>
        [event, "2026-10-25 01:30:00", "Local/test;2", "same-id", "same-linked", route.context, route.extension,
          event === "HISTORY_ENTRY" ? JSON.stringify({ extra: JSON.stringify(payload) }) : ""]
          .map((s) => `"${s.replaceAll('"', '""')}"`).join(",") + "\n").join(""));
      history.ingest({ customer, source: customer, generation: "stream-1", timeBasis: "UTC" }, raw);
      history.manifests.register({ customer, runtime: "runtime-a", epoch: "boot-1", operator: "test", reason: "Synthetic HR fixture",
        routes: [route], ranges: [{ kind: "cel", source: customer, generation: "stream-1", start: 0, end: raw.length }] });
      projections.rebuild(history, { ...scope, customer });
    }
  } finally { projections.close(); history.close(); }
}
async function setup(paths?: { historyPath: string; projectionPath: string }) {
  const directory = await mkdtemp(join(tmpdir(), "history-workspace-"));
  const historyPath = paths?.historyPath ?? join(directory, "history.sqlite");
  const projectionPath = paths?.projectionPath ?? join(directory, "projections.sqlite");
  if (!paths) {
    try { seed(historyPath, projectionPath); }
    catch (error) { await rm(directory, { recursive: true }); throw error; }
  }
  const reader = createHistoryReader(historyPath, projectionPath);
  const audits = openDiagnosticStore(join(directory, "audit.sqlite"));
  const events: AccessAudit[] = [], errors: unknown[] = [];
  const controls: { auditFailure?: boolean; held?: boolean; gate?: Promise<void>; entered?: () => void;
    holdJwks?: boolean; jwksGate?: Promise<void>; jwksEntered?: () => void } = {};
  const keys = await generateKeyPair("RS256"), jwk = await exportJWK(keys.publicKey);
  let issuer = "", nonce = "";
  const sign = (sub: string, audience = "api", claims = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "history" }).setIssuer(issuer).setSubject(sub)
    .setAudience(audience).setIssuedAt().setExpirationTime("2m").sign(keys.privateKey);
  const identity = createServer(async (request, response) => {
    if (request.url === "/jwks") {
      if (controls.holdJwks) { controls.jwksEntered?.(); await controls.jwksGate; }
      response.end(JSON.stringify({ keys: [{ ...jwk, kid: "history" }] })); return;
    }
    if (request.url !== "/token") { response.writeHead(404).end(); return; }
    let body = ""; for await (const chunk of request) body += chunk;
    const subject = new URLSearchParams(body).get("code")!;
    response.end(JSON.stringify({ access_token: await sign(subject), id_token: await sign(subject, "client", { nonce }) }));
  });
  const holder = createServer();
  try {
    issuer = await listen(identity); const origin = await listen(holder);
    const config: AccessConfig = { issuer, audience: "api", jwksUrl: issuer + "/jwks", allowLoopbackHttpForTests: true,
      memberships: [
        ...["customer-a", "customer-b"].map((customer) => ({ issuer, subject: "reader", customer, permissions: ["history:read"] as const })),
        { issuer, subject: "diagnostic", customer: "customer-a", permissions: ["diagnostics:read", "diagnostics:report", "diagnostics:review"] },
        { issuer, subject: "agent", customer: "customer-a", permissions: ["agent:access", "booking:simulate"] },
      ], supportGrants: [{ issuer, subject: "support", customer: "customer-a", permissions: ["history:read"],
        startsAt: Date.now() / 1000 - 1, expiresAt: Date.now() / 1000 + 120, reason: "Test", contractReference: "Test" }] };
    const sessionConfig = { origin, issuer, authorizationEndpoint: issuer + "/authorize", tokenEndpoint: issuer + "/token",
      jwksUrl: issuer + "/jwks", clientId: "client", clientSecret: "synthetic", audience: "api", allowLoopbackHttpForTests: true };
    const audit = async (event: AccessAudit) => {
      if (event.operation === "history-read" && controls.auditFailure) throw new Error("Synthetic audit unavailable");
      if (event.operation === "history-read" && controls.held) { controls.entered?.(); await controls.gate; }
      await audits.audit(event); events.push(event);
    };
    const build = (enabled = true) => createDiagnosticApi(config, audit, (e) => errors.push(e), undefined, undefined, sessionConfig,
      undefined, undefined, undefined, undefined, undefined, enabled ? reader : undefined);
    let api = build();
    holder.on("request", (req, res) => api.emit("request", req, res));
    const login = async (subject = "reader", customer = "customer-a", workspace = "history") => {
      const start = await fetch(`${origin}/auth/login?customer=${customer}&workspace=${workspace}`, { redirect: "manual" });
      assert.equal(start.status, 302);
      const location = new URL(start.headers.get("location")!); nonce = location.searchParams.get("nonce")!;
      const completed = await fetch(`${origin}/auth/callback?state=${location.searchParams.get("state")}&code=${subject}`, {
        redirect: "manual", headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] } });
      assert.equal(completed.status, 302); assert.equal(completed.headers.get("location"), `/engineering/${workspace === "history" ? "history" : "reviews"}/${customer}`);
      const cookie = completed.headers.getSetCookie().find((s) => s.startsWith("asterisk-test-session="))!.split(";")[0];
      const info = await (await fetch(origin + "/auth/session", { headers: { Cookie: cookie } })).json();
      return { cookie, csrf: String(info.csrf) };
    };
    const call = (session: { cookie: string; csrf: string } | undefined, path = "scopes",
      options: { customer?: string; method?: string; headers?: Record<string, string> } = {}) =>
      fetch(`${origin}/api/customers/${options.customer ?? "customer-a"}/history/${path}`, { method: options.method ?? "GET",
        headers: { ...(session ? { Cookie: session.cookie, "X-CSRF-Token": session.csrf } : {}), ...options.headers } });
    const result = async (response: Response) => {
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get("cache-control"), "no-store");
      const value = await response.json(); assert.equal(value.requestId, response.headers.get("x-request-id")); return value.result;
    };
    return { origin, directory, historyPath, projectionPath, reader, login, call, result, events, errors, controls, sign,
      logout: (session: { cookie: string; csrf: string }) => fetch(origin + "/auth/logout", { method: "POST",
        headers: { Cookie: session.cookie, Origin: origin, "X-CSRF-Token": session.csrf } }),
      disable() { api = build(false); },
      async close() { await close(holder); await close(identity); audits.close(); await rm(directory, { recursive: true }); } };
  } catch (error) {
    if (holder.listening) await close(holder);
    if (identity.listening) await close(identity);
    audits.close(); await rm(directory, { recursive: true }); throw error;
  }
}
async function fixture(action: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup(); try { await action(context); } finally { await context.close(); }
}

test("HR-01: opt-in validates explicit members and existing read-only stores; no load-time writes or raw dependency", async () => {
  await fixture(async (c) => {
    const before = await readFile(c.projectionPath);
    const configDir = join(c.directory, ".local-proof", "engineering"); await mkdir(configDir, { recursive: true });
    const path = join(configDir, "history-reader.json");
    const absent = join(c.directory, "missing.sqlite");
    await writeFile(path, JSON.stringify({ historyPath: absent, projectionPath: c.projectionPath, members: ["alice"] }));
    const loaded = await loadLocalHistoryReader(c.directory);
    assert.deepEqual(loaded.members, ["alice"]); loaded.reader.read(scope, undefined, false);
    assert.throws(() => loaded.reader.read(scope, undefined, true));
    assert.equal((await readdir(c.directory)).includes("missing.sqlite"), false);
    for (const members of [[], ["support"], ["alice", "alice"]]) {
      await writeFile(path, JSON.stringify({ historyPath: absent, projectionPath: c.projectionPath, members }));
      await assert.rejects(loadLocalHistoryReader(c.directory), /explicit local/);
    }
    assert.throws(() => createHistoryReader(c.historyPath, absent)); assert.throws(() => createHistoryReader(c.historyPath, c.historyPath));
    assert.deepEqual(await readFile(c.projectionPath), before);
    c.disable();
    assert.equal((await fetch(c.origin + "/engineering/history/customer-a")).status, 503);
    assert.equal((await fetch(c.origin + "/auth/login?customer=customer-a&workspace=history")).status, 503);
  });
});

test("HR-02: history requires live customer session and explicit membership, never support, diagnostics, agent or bearer authority", async () => {
  await fixture(async (c) => {
    assert.equal((await c.call(undefined)).status, 401);
    assert.equal((await c.call(undefined, "scopes", { headers: { Authorization: `Bearer ${await c.sign("reader")}` } })).status, 401);
    for (const subject of ["support", "diagnostic", "agent", "outsider"]) {
      const session = await c.login(subject); assert.equal((await c.call(session)).status, 403);
    }
    const session = await c.login();
    assert.equal((await c.call(session, "scopes", { customer: "customer-b" })).status, 403);
    assert.equal((await c.call(session, "scopes", { headers: { "X-CSRF-Token": "wrong" } })).status, 403);
    assert.equal((await c.call(session, "scopes", { headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
    assert.equal((await c.call(session, "scopes", { headers: { Authorization: "Bearer forged" } })).status, 403);
    assert.equal((await c.result(await c.call(session))).scopes.length, 1);
    assert.equal(c.events.filter((e) => e.operation === "history-read" && e.status === 403).length, 5);
  });
});

test("HR-03: persistent request references fail closed on audit failure and logout during awaited audit", async () => {
  await fixture(async (c) => {
    const session = await c.login();
    const response = await c.call(session, `stored?${selector}`); await c.result(response);
    const id = response.headers.get("x-request-id");
    const db = new DatabaseSync(join(c.directory, "audit.sqlite"), { readOnly: true });
    assert.equal(db.prepare("SELECT operation FROM access_audit WHERE request_id=?").get(id!)?.operation, "history-read"); db.close();
    c.controls.auditFailure = true;
    const failed = await c.call(session, `stored?${selector}`);
    assert.equal(failed.status, 503); assert.doesNotMatch(await failed.text(), /journeyId|Synthetic audit/);
    assert.equal(c.errors.length, 1); c.controls.auditFailure = false;
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    c.controls.gate = new Promise<void>((resolve) => { release = resolve; });
    c.controls.entered = entered; c.controls.held = true;
    const pending = c.call(session, `stored?${selector}`); await waiting;
    assert.equal((await c.logout(session)).status, 200); release();
    const denied = await pending; assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /journeyId/);
    assert.equal((await c.call(session)).status, 401);
  });
  await fixture(async (c) => {
    const session = await c.login();
    let release!: () => void, entered!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    c.controls.jwksGate = new Promise<void>((resolve) => { release = resolve; });
    c.controls.jwksEntered = entered; c.controls.holdJwks = true;
    const pending = c.call(session, `stored?${selector}`); await waiting;
    assert.equal((await c.logout(session)).status, 200); release();
    const denied = await pending;
    assert.equal(denied.status, 401); assert.doesNotMatch(await denied.text(), /journeyId/);
    assert.equal(c.events.at(-1)?.outcome, "application_session_required");
    assert.equal(c.events.some((e) => e.outcome === "history_stored_view_prepared"), false);
  });
});

test("HR-04: bounded customer/runtime/epoch/revision pages deny scope swaps, arbitrary files, mutations and raw routes", async () => {
  await fixture(async (c) => {
    const session = await c.login();
    const a = await c.result(await c.call(session, `revisions?${selector}&limit=1`));
    const other = c.reader.revisions({ ...scope, customer: "customer-b" }, 0, 1).revisions[0].id;
    assert.equal(a.revisions.length, 1);
    for (const path of [`stored?${selector}&revision=${other}`, "stored?runtime=other&epoch=boot-1",
      "stored?runtime=runtime-a&epoch=other"]) assert.equal((await c.call(session, path)).status, 404);
    for (const path of ["scopes?limit=201", "scopes?limit=0", "scopes?after=-1", "scopes?limit=1&limit=2",
      "scopes?path=C%3A%5Cprivate", `stored?${selector}&revision=01`, `stored?${selector}&revision=1.2`]) {
      assert.equal((await c.call(session, path)).status, 400, path);
    }
    for (const path of ["raw", "collect", "rebuild", "import", "manifests"]) assert.equal((await c.call(session, path)).status, 404);
    assert.equal((await c.call(session, "scopes", { method: "POST", headers: { Origin: c.origin } })).status, 405);
    const store = openHistoryProjections(c.projectionPath);
    const history = openCelHistory(c.historyPath);
    try {
      for (const epoch of ["boot-2", "boot-3"]) {
        const m = history.manifests.list("customer-a").manifests[0];
        const raw = Buffer.from(history.read({ customer: "customer-a", source: "customer-a", generation: "stream-1" })
          .events.map((e) => e.rawRecord).join(""));
        history.ingest({ customer: "customer-a", source: epoch, generation: "stream-1", timeBasis: "UTC" }, raw);
        history.manifests.register({ customer: "customer-a", runtime: "other-runtime", epoch, operator: "test", reason: "Empty epoch",
          routes: m.routes, ranges: [{ kind: "cel", source: epoch, generation: "stream-1", start: 0, end: raw.length }] });
        store.rebuild(history, { ...scope, runtime: "other-runtime", epoch });
      }
      const first = await c.result(await c.call(session, "scopes?limit=1"));
      assert.equal(first.scopes.length, 1); assert.ok(first.nextAfterId > 0);
      const next = await c.result(await c.call(session, `scopes?limit=1&after=${first.nextAfterId}`));
      assert.equal(next.scopes[0].epoch, "boot-2");
      assert.equal((await c.result(await c.call(session, `revisions?${selector}&after=${a.revisions[0].id}`))).revisions.length, 0);
    } finally { store.close(); history.close(); }
  });
});

test("HR-05: legacy v1-v5 bytes stay unchanged, missing observations remain absent, malformed stores explicitly fail", async () => {
  await fixture(async (c) => {
    const db = new DatabaseSync(c.projectionPath);
    const original = db.prepare("SELECT * FROM projection_revisions WHERE customer='customer-a'").get()!;
    for (const version of [1, 2, 3, 4, 5]) {
      const d = JSON.parse(String(original.document));
      d.algorithm = d.input.algorithm = `marked-caller-v${version}`;
      if (version === 1) delete d.quality.queueCoverage;
      const text = JSON.stringify(d), input = historySha256(Buffer.from(JSON.stringify(d.input)));
      db.prepare("UPDATE projection_revisions SET algorithm=?,document=?,sha256=?,input_sha256=? WHERE id=?")
        .run(d.algorithm, text, historySha256(Buffer.from(text)), input, Number(original.id));
      const before = await readFile(c.projectionPath), session = await c.login();
      const value = await c.result(await c.call(session, `stored?${selector}`));
      assert.equal(value.algorithm, `marked-caller-v${version}`);
      assert.equal(Object.hasOwn(value.observation.quality, "queueCoverage"), version !== 1);
      assert.deepEqual(await readFile(c.projectionPath), before);
    }
    db.prepare("UPDATE projection_revisions SET document='{}' WHERE id=?").run(Number(original.id)); db.close();
    const response = await c.call(await c.login(), `stored?${selector}`);
    assert.equal(response.status, 503); assert.doesNotMatch(await response.text(), /Corrupt|sqlite|journeyId/);
    assert.equal(c.events.at(-1)?.outcome, "history_read_unavailable");
  });
});

test("HR-06: explicit current check distinguishes matching/changed inputs from offline not-checked without publishing", async () => {
  await fixture(async (c) => {
    const session = await c.login(), before = await readFile(c.projectionPath);
    assert.equal((await c.result(await c.call(session, `stored?${selector}`))).freshness.state, "not-checked");
    const matched = await c.result(await c.call(session, `check?${selector}`));
    assert.equal(matched.freshness.state, "inputs-match");
    assert.equal(matched.currentQuality.completeness, "unverified"); assert.deepEqual(matched.collectorHealth, []);
    const history = openCelHistory(c.historyPath);
    try { history.queue.ingest({ customer: "customer-a", source: "late", generation: "stream-1" },
      Buffer.from("1792890000|same-id|proof-queue|NONE|ABANDON|1|1|3\n")); } finally { history.close(); }
    const changed = await c.result(await c.call(session, `check?${selector}`));
    assert.equal(changed.freshness.state, "inputs-changed");
    assert.equal((await c.result(await c.call(session, `stored?${selector}`))).freshness.state, "not-checked");
    assert.deepEqual(await readFile(c.projectionPath), before);
    const writer = openCelHistory(c.historyPath), projections = openHistoryProjections(c.projectionPath);
    try {
      const path = join(c.directory, "PRIVATE-collector-path");
      writer.configureCollector({ customer: "customer-a", source: "customer-a", generation: "stream-1", timeBasis: "UTC",
        path, staleAfterMs: 1000 });
      writer.transitionCollector("customer-a", "customer-a", "stream-2", "test", "Permanent unknown delivery gap");
      const attempt = writer.beginCollection("customer-a", "customer-a");
      writer.failCollection("customer-a", "customer-a", attempt.revision, "source-unavailable");
      writer.queue.collectors.configure({ customer: "customer-a", source: "late", generation: "stream-1", path, staleAfterMs: 1000 });
      writer.queue.collectors.transition("customer-a", "late", "stream-2", "test", "Independent queue gap");
      projections.rebuild(writer, scope);
    } finally { writer.close(); projections.close(); }
    const withGaps = await c.result(await c.call(session, `check?${selector}`));
    assert.equal(withGaps.freshness.state, "inputs-match", "Matching local inputs are not healthy remote delivery");
    assert.deepEqual(withGaps.collectorHealth.map((h: { status: string }) => h.status), ["unhealthy", "never-collected"]);
    assert.ok(withGaps.collectorHealth.every((h: { coverage: string }) => h.coverage === "unknown-gap-recorded"));
    assert.ok(withGaps.currentCoverage.every((row: { gaps: unknown[] }) => row.gaps.length === 1));
    assert.doesNotMatch(JSON.stringify(withGaps), /PRIVATE-collector-path|configuration|rawRecord/);
    await rm(c.historyPath);
    assert.equal((await c.result(await c.call(session, `stored?${selector}`))).freshness.state, "not-checked");
    assert.equal((await c.call(session, `check?${selector}`)).status, 503);
    assert.equal((await readdir(c.directory)).includes("history.sqlite"), false);
  });
});

test("HR-07: observation DTO preserves separate service/abandonment/answer/end facts without business classification", async () => {
  await fixture(async (c) => {
    const store = openHistoryProjections(c.projectionPath, { readOnly: true });
    try {
      const document = store.read(scope).document;
      const view = historyObservationView(document);
      assert.deepEqual(view.journeys, document.journeys);
      assert.deepEqual(view.quality, document.quality);
      assert.equal(view.quality.service, "not-classified"); assert.equal(view.quality.completeness, "unverified");
      assert.doesNotMatch(JSON.stringify(view), /rawRecord|linkedid|timestamp|phone|recording|dispatch/);
    } finally { store.close(); }
  });
});

test("HR-08: unresolved/conflicting/unassigned issues, permanent gaps and source association remain explicit; unknown keys cannot leak", () => {
  const ref = { kind: "queue", source: "queue", generation: "stream-1", offset: 0, sha256: "a".repeat(64), rawRecord: "PRIVATE" };
  const value = { quality: { completeness: "unverified", service: "not-classified" },
    input: { coverage: [{ kind: "queue", source: "queue", generation: "stream-1", association: "association-unknown",
      configuration: { path: "PRIVATE" }, gaps: [{ id: 1, source: "queue", previousGeneration: "old",
        generation: "stream-1", coverage: "unknown", lastSuccessAt: null, observedAt: "2026-01-01T00:00:00.000Z" }] }] },
    journeys: [], issues: ["unassigned-evidence", "conflicting-queue-abandonment", "missing-or-conflicting-queue-connect"]
      .map((reason) => ({ reason, evidence: [ref], rawRecord: "PRIVATE" })), rawRecord: "PRIVATE" };
  const view = historyObservationView(value);
  assert.equal(view.issues.length, 3); assert.equal(view.coverage[0].metadata.association, "association-unknown");
  assert.equal(view.coverage[0].gaps[0].coverage, "unknown");
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|rawRecord|configuration/);
  assert.throws(() => historyObservationView({ ...value, issues: [{ reason: {}, evidence: [] }] }));
});

test("HR-09: browser escapes hostile evidence, surfaces failures, clears logout/expiry/access loss and discards late responses", async () => {
  const html = await readFile(new URL("../src/history-workspace.html", import.meta.url));
  const script = await readFile(new URL("../src/history-workspace.js", import.meta.url));
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", req.url === "/engineering/history.js" ? "text/javascript" : "text/html");
    res.end(req.url === "/engineering/history.js" ? script : html);
  });
  const origin = await listen(server), browser = await chromium.launch(), page = await browser.newPage();
  const errors: string[] = [], unexpected: string[] = [], calls: string[] = [];
  let mode = "valid", release: (() => void) | undefined, entered: (() => void) | undefined;
  const hostile = '<img src=x onerror="window.hacked=true"><script>window.hacked=true</script>';
  const body = { customer: "customer-a", result: { id: 1, scope, algorithm: "marked-caller-v5", freshness: { state: "not-checked" },
    observation: { quality: { completeness: "unverified" }, issues: [{ reason: hostile, evidence: [] }], coverage: [], journeys: [] } } };
  try {
    page.on("pageerror", (e) => errors.push(e.message)); page.on("websocket", (s) => unexpected.push(s.url()));
    page.on("request", (r) => {
      const path = new URL(r.url()).pathname;
      if (!/^\/(?:engineering\/(?:history\/customer-a|history\.js)|auth\/(?:session|logout)|api\/customers\/customer-a\/history\/(?:scopes|revisions|stored|check))$/.test(path)) unexpected.push(path);
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: () => { throw new Error("Microphone prohibited"); } });
    });
    await page.clock.install();
    await page.route("**/auth/session", async (route) => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ customer: "customer-a", csrf: "a".repeat(43),
        expiresAt: new Date(await page.evaluate(() => Date.now()) + 120000).toISOString() }) }));
    await page.route("**/auth/logout", (route) => route.fulfill({ body: "{}" }));
    await page.route("**/history/scopes?**", (route) => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ customer: "customer-a", result: { scopes: [{ runtime: scope.runtime, epoch: scope.epoch }], nextAfterId: null } }) }));
    await page.route("**/history/revisions?**", (route) => route.fulfill({ contentType: "application/json",
      body: JSON.stringify({ customer: "customer-a", result: { revisions: [{ id: 1, scope, algorithm: "marked-caller-v5" }], nextAfterId: null } }) }));
    await page.route("**/history/stored?**", async (route) => {
      calls.push("stored"); assert.equal(route.request().headers()["x-csrf-token"], "a".repeat(43));
      if (mode === "held") { entered?.(); await new Promise<void>((resolve) => { release = resolve; }); }
      if (mode === "network") { await route.abort("failed"); return; }
      await route.fulfill({ status: mode === "forbidden" ? 403 : mode === "failed" ? 503 : 200,
        contentType: "application/json", headers: { "X-Request-Id": "history-ref" }, body: JSON.stringify(body) });
    });
    const load = async () => {
      await page.goto(origin + "/engineering/history/customer-a");
      await page.getByRole("button", { name: "runtime-a / boot-1", exact: true }).click();
      await page.getByRole("button", { name: "Revision 1 / marked-caller-v5", exact: true }).waitFor();
    };
    const stored = () => page.locator("#stored").click();
    await load(); assert.equal(calls.length, 0, "No automatic protected revision read or current check");
    await stored(); await page.locator("#warnings").filter({ hasText: "window.hacked" }).waitFor();
    assert.equal(await page.locator("#workspace img, #workspace script").count(), 0);
    for (mode of ["failed", "network"]) {
      await stored(); await page.locator("#status").filter({ hasText: /failed|fetch/i }).waitFor();
      assert.equal(await page.locator("#warnings").textContent(), "");
    }
    mode = "valid"; await stored(); await page.locator("#warnings").filter({ hasText: "window.hacked" }).waitFor();
    mode = "forbidden"; await stored(); await page.locator("#session-status").filter({ hasText: /access lost.*history-ref/ }).waitFor();
    assert.equal(await page.locator("#workspace").isVisible(), false); assert.equal(await page.locator("#warnings").textContent(), "");
    mode = "valid"; await load(); await stored(); await page.locator("#warnings").filter({ hasText: "window.hacked" }).waitFor();
    await page.clock.fastForward(121000); await page.locator("#session-status").filter({ hasText: "Session expired" }).waitFor();
    assert.equal(await page.locator("#warnings").textContent(), "");
    await load(); mode = "held";
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    await stored(); await waiting; await page.locator("#sign-out").click(); release?.();
    await page.locator("#session-status").filter({ hasText: "Signed out" }).waitFor();
    assert.equal(await page.locator("#warnings").textContent(), ""); assert.equal(await page.locator("#workspace").isVisible(), false);
    assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  } finally { release?.(); await browser.close(); await close(server); }
});

test("HR-10: both customers read persisted revisions through real session HTTP/browser boundaries without changing evidence", async () => {
  const root = process.env.HR_PROOF_ROOT;
  const epochDirectory = process.env.HR_EPOCH_PROOF_DIRECTORY;
  const cases = root && !epochDirectory ? [
    ["history-projection", "run-99RbJ4", "marked-caller-v1"], ["queue-collector", "run-XYvtHl", "marked-caller-v2"],
    ["queue-service", "run-n7q0gL", "marked-caller-v3"], ["caller-queue-service", "run-nOTX5T", "marked-caller-v4"],
    ["queue-abandonment", "run-PIl5h8", "marked-caller-v5"],
  ] : [[null, null, "marked-caller-v5"]];
  const browser = await chromium.launch();
  try {
    for (const [kind, run, algorithm] of cases) {
      const paths = epochDirectory ? { historyPath: join(epochDirectory, "history.sqlite"), projectionPath: join(epochDirectory, "projections.sqlite") } :
        root && kind && run ? { historyPath: join(root, kind, run, "history.sqlite"),
        projectionPath: join(root, kind, run, "projections.sqlite") } : undefined;
      const c = await setup(paths);
      const before = await Promise.all([readFile(c.historyPath), readFile(c.projectionPath)]);
      try {
        for (const customer of ["customer-a", "customer-b"]) {
          const session = await c.login("reader", customer);
          const scopes = await c.result(await c.call(session, "scopes", { customer }));
          assert.equal(scopes.scopes.length, epochDirectory ? 2 : 1);
          for (const selected of scopes.scopes) {
          const params = new URLSearchParams({ runtime: selected.runtime, epoch: selected.epoch });
          const stored = await c.result(await c.call(session, `stored?${params}`, { customer }));
          assert.equal(stored.algorithm, algorithm); assert.ok(stored.observation.journeys.length > 0);
          const projections = openHistoryProjections(c.projectionPath, { readOnly: true });
          try {
            const original = projections.read({ customer, runtime: selected.runtime, epoch: selected.epoch });
            assert.deepEqual(stored.observation.journeys, original.document.journeys);
            assert.deepEqual(stored.observation.issues, original.document.issues);
          } finally { projections.close(); }
          assert.equal(stored.freshness.state, "not-checked");
          if (epochDirectory) {
            const otherScope = scopes.scopes.find((s: { epoch: string }) => s.epoch !== selected.epoch);
            const otherParams = new URLSearchParams({ runtime: otherScope.runtime, epoch: otherScope.epoch });
            const other = await c.result(await c.call(session, `stored?${otherParams}`, { customer }));
            assert.notEqual(other.observation.journeys[0].id, stored.observation.journeys[0].id);
            assert.equal(other.observation.journeys[0].journeyId, stored.observation.journeys[0].journeyId);
            assert.equal((await c.call(session, `stored?${params}&revision=${other.id}`, { customer })).status, 404);
          }
          assert.equal((await c.call(session, `stored?${params}`, { customer: customer === "customer-a" ? "customer-b" : "customer-a" })).status, 403);
          const context = await browser.newContext();
          try {
            const [name, value] = session.cookie.split("=");
            await context.addCookies([{ name, value, url: c.origin, httpOnly: true, sameSite: "Lax" }]);
            const page = await context.newPage();
            const unexpected: string[] = [], errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("websocket", (socket) => unexpected.push(socket.url()));
            page.on("request", (request) => {
              const url = new URL(request.url());
              if (url.origin !== c.origin || !new RegExp(`^/(?:engineering/(?:history/${customer}|history\\.js)|auth/(?:session|logout)|api/customers/${customer}/history/(?:scopes|revisions|stored|check))$`).test(url.pathname)) {
                unexpected.push(url.pathname);
              }
            });
            await page.addInitScript(() => {
              Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
                value: () => { throw new Error("History proof must not request a microphone"); },
              });
            });
            await page.goto(`${c.origin}/engineering/history/${customer}`);
            await page.getByRole("button", { name: `${selected.runtime} / ${selected.epoch}`, exact: true }).click();
            await page.locator("#stored").click();
            await page.locator("#freshness").filter({ hasText: String(algorithm) }).waitFor();
            assert.match(await page.locator("#warnings").textContent() ?? "", /unverified/);
            assert.match(await page.locator("#observations").textContent() ?? "", /journeyId/);
            assert.equal(await page.locator("#customer").textContent(), customer);
            await page.locator("#check").click();
            await page.locator("#freshness").filter({ hasText: algorithm === "marked-caller-v5" ? "inputs-match" : "inputs-changed" }).waitFor();
            const csp = (await fetch(`${c.origin}/engineering/history/${customer}`)).headers.get("content-security-policy")!;
            assert.match(csp, /connect-src 'self'/); assert.doesNotMatch(csp, /unsafe-inline/);
            assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
          } finally { await context.close(); }
          }
        }
        assert.deepEqual(await Promise.all([readFile(c.historyPath), readFile(c.projectionPath)]), before);
        assert.deepEqual(c.errors, []);
      } finally { await c.close(); }
    }
  } finally { await browser.close(); }
});
