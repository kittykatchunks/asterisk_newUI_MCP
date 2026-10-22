import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { chromium } from "playwright";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { createDiagnosticApi } from "../../src/diagnostic-api.ts";
import type { AccessAudit } from "../../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../../src/diagnostic-store.ts";
import { backupDiagnosticStore, restoreDiagnosticStore } from "../../src/diagnostic-backup.ts";
import type { ApprovedIncident } from "../../src/incidents.ts";

interface TestAccount {
  subject: string;
  username: string;
  password: string;
  customer: string;
}

const issuer = "http://127.0.0.1:18080/realms/local-proof";
const callbackUri = "http://127.0.0.1:18765/callback";
const clientId = "browser-proof";
const accounts: TestAccount[] = JSON.parse(await readFile(
  new URL("../../.local-proof/identity/accounts.json", import.meta.url), "utf8",
));
assert.equal(accounts.length, 2);
const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
assert.equal(discoveryResponse.status, 200);
const discovery = await discoveryResponse.json();
assert.equal(discovery.issuer, issuer);
for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri", "end_session_endpoint"]) {
  const url = new URL(discovery[key]);
  assert.equal(url.origin, new URL(issuer).origin);
}
const audit: AccessAudit[] = [];
const operationalErrors: unknown[] = [];
const evidenceRoot = new URL("../../.local-proof/evidence/", import.meta.url);
const directories = (await readdir(evidenceRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && /^incident-[0-9a-f]{32}$/.test(entry.name));
const candidates = [];
for (const entry of directories) {
  try {
    const manifests = await Promise.all(accounts.map((account) =>
      readFile(new URL(`${entry.name}/${account.customer}/export-manifest.json`, evidenceRoot), "utf8")));
    candidates.push({ id: entry.name, manifests: manifests.map((value) => JSON.parse(value)) });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
    throw error;
  }
}
candidates.sort((a, b) => b.manifests[0].started_utc.localeCompare(a.manifests[0].started_utc));
const evidence = candidates[0];
assert.ok(evidence, "Run Test-CaptureProof.ps1 first to generate evidence for both customers");
const entries: ApprovedIncident[] = [];
for (const [index, account] of accounts.entries()) {
  const manifest = evidence.manifests[index];
  assert.equal(manifest.customer, account.customer);
  assert.equal(manifest.incident, evidence.id);
  const html = await readFile(new URL(`${evidence.id}/${account.customer}/report.html`, evidenceRoot), "utf8");
  entries.push({
    customer: account.customer,
    summary: { id: evidence.id, title: "Synthetic SIP evidence", createdAt: manifest.started_utc },
    report: { html, sha256: manifest.report_sha256 },
  });
}
const storageDirectory = await mkdtemp(join(tmpdir(), "asterisk-identity-store-"));
const databasePath = join(storageDirectory, "diagnostics.sqlite");
let store = openDiagnosticStore(databasePath);
try {
  const staged = store.stage(entries);
  for (const entry of entries) {
    assert.deepEqual(await store.catalog.list(entry.customer), []);
    assert.equal(await store.catalog.report(entry.customer, entry.summary.id), undefined);
  }
  for (const candidate of staged) {
    store.review(candidate.id, {
      sha256: candidate.sha256, decision: "approve", reviewer: "synthetic-fixture-reviewer",
      reason: "Known synthetic packet report; no customer data",
    });
  }
  store.close();
  store = openDiagnosticStore(databasePath);
} catch (error) {
  store.close();
  await rm(storageDirectory, { recursive: true });
  throw error;
}
const api = createDiagnosticApi({
  issuer, audience: "diagnostic-api", jwksUrl: discovery.jwks_uri,
  allowLoopbackHttpForTests: true,
  memberships: accounts.map((account) => ({
    issuer, subject: account.subject, customer: account.customer,
    permissions: account.username === "alice" ? ["diagnostics:read", "diagnostics:report"] : ["diagnostics:read"],
  })),
  supportGrants: [],
}, async (event) => {
  await store.audit(event);
  audit.push(event);
}, (error) => { operationalErrors.push(error); }, store.catalog);

let pending: { state: string; accept: (code: string) => void; reject: (error: Error) => void } | undefined;
const callback = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "text/plain");
  const url = new URL(request.url ?? "/", callbackUri);
  if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
  const current = pending;
  pending = undefined;
  if (!current || url.searchParams.get("state") !== current.state ||
      url.searchParams.has("error") || !url.searchParams.get("code")) {
    current?.reject(new Error("Unexpected or invalid OIDC callback"));
    response.writeHead(400).end("Login failed");
    return;
  }
  current.accept(url.searchParams.get("code")!);
  response.end("Synthetic login completed. This is not the management application.");
});

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

api.listen(0, "127.0.0.1");
callback.listen(18765, "127.0.0.1");
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  await Promise.all([once(api, "listening"), once(callback, "listening")]);
  const address = api.address();
  if (!address || typeof address === "string") throw new Error("Missing API address");
  const apiBase = `http://127.0.0.1:${address.port}`;
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  browser = await chromium.launch({ headless: true });
  const invalidRequests: Record<string, string>[] = [
    { client_id: clientId, redirect_uri: callbackUri, response_type: "code", scope: "openid" },
    { client_id: clientId, redirect_uri: "http://127.0.0.1:18765/not-approved", response_type: "code",
      scope: "openid", code_challenge: randomBytes(32).toString("base64url"), code_challenge_method: "S256" },
  ];
  for (const [index, parameters] of invalidRequests.entries()) {
    const invalid = new URL(discovery.authorization_endpoint);
    invalid.search = new URLSearchParams(parameters).toString();
    const rejected = await fetch(invalid, { redirect: "manual" });
    if (index === 0) {
      assert.equal(rejected.status, 302, "Missing PKCE should return an OAuth error to the approved callback");
      const location = rejected.headers.get("location");
      assert.ok(location);
      const errorUrl = new URL(location);
      assert.equal(errorUrl.origin + errorUrl.pathname, callbackUri);
      assert.equal(errorUrl.searchParams.get("error"), "invalid_request");
      assert.equal(errorUrl.searchParams.has("code"), false);
      assert.match(errorUrl.searchParams.get("error_description") ?? "", /code_challenge/i);
    } else {
      assert.equal(rejected.status, 400, "Unapproved redirect must not start a login");
      assert.equal(rejected.headers.has("location"), false);
    }
  }
  console.log("PASS Keycloak rejects missing PKCE and unapproved redirect URI");

  for (const account of accounts) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const verifier = randomBytes(32).toString("base64url");
      const state = randomBytes(32).toString("base64url");
      const nonce = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorize = new URL(discovery.authorization_endpoint);
      authorize.search = new URLSearchParams({
        client_id: clientId, redirect_uri: callbackUri, response_type: "code",
        scope: "openid", state, nonce, code_challenge: challenge, code_challenge_method: "S256",
      }).toString();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const codePromise = new Promise<string>((resolve, reject) => {
        pending = { state, accept: resolve, reject };
        timer = setTimeout(() => reject(new Error("OIDC callback timed out")), 30000);
      });
      // Attach a handler immediately to avoid an unhandled rejection while navigating.
      const outcome = codePromise.then((code) => ({ code }), (error: unknown) => ({ error }));
      let code: string;
      try {
        await page.goto(authorize.href);
        await page.locator("#username").fill(account.username);
        await page.locator("#password").fill(account.password);
        await page.locator("#kc-login").click();
        const result = await outcome;
        if ("error" in result) throw result.error;
        code = result.code;
      } finally {
        clearTimeout(timer);
        pending = undefined;
      }
      const tokenResponse = await fetch(discovery.token_endpoint, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId,
          redirect_uri: callbackUri, code, code_verifier: verifier,
        }),
      });
      assert.equal(tokenResponse.status, 200, "Authorization-code exchange failed");
      const tokens = await tokenResponse.json();
      assert.equal(typeof tokens.access_token, "string");
      assert.equal(typeof tokens.id_token, "string");
      const id = await jwtVerify(tokens.id_token, jwks, {
        issuer, audience: clientId, algorithms: ["RS256"],
        requiredClaims: ["sub", "exp", "iat", "nonce"],
      });
      assert.equal(id.payload.nonce, nonce);
      assert.equal(id.payload.sub, account.subject);
      const own = await fetch(`${apiBase}/api/customers/${account.customer}/diagnostics`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      assert.equal(own.status, 200);
      const other = accounts.find((entry) => entry.customer !== account.customer);
      assert.ok(other);
      assert.equal((await fetch(`${apiBase}/api/customers/${other.customer}/diagnostics`, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      })).status, 403);
      assert.equal((await fetch(`${apiBase}/api/customers/${account.customer}/diagnostics`, {
        headers: { Authorization: `Bearer ${tokens.id_token}` },
      })).status, 401, "ID token must not be accepted as API access token");
      const headers = { Authorization: `Bearer ${tokens.access_token}` };
      const listed = await fetch(`${apiBase}/api/customers/${account.customer}/diagnostics/incidents`, { headers });
      assert.equal(listed.status, 200);
      assert.deepEqual((await listed.json()).incidents.map((entry: { id: string }) => entry.id), [evidence.id]);
      const reportUrl = `${apiBase}/api/customers/${account.customer}/diagnostics/incidents/${evidence.id}/report`;
      const report = await fetch(reportUrl, { headers });
      if (account.username === "alice") {
        assert.equal(report.status, 200);
        assert.match(await report.text(), /Observed signalling ladder/);
        assert.match(report.headers.get("content-security-policy") ?? "", /sandbox allow-scripts/);
        const viewer = await browser.newContext({ extraHTTPHeaders: headers });
        try {
          const reportPage = await viewer.newPage();
          await reportPage.goto(reportUrl);
          await reportPage.getByRole("heading", { name: "Observed signalling ladder" }).waitFor();
          await reportPage.getByLabel("Message filter").fill("SIP 401");
          assert.ok(await reportPage.locator("#packets tbody tr:visible").count() > 0);
          assert.equal(await reportPage.evaluate(() => {
            try { localStorage.getItem("sandbox-probe"); return false; }
            catch (error) { return error instanceof DOMException && error.name === "SecurityError"; }
          }), true, "Sandboxed report must not inherit application-origin storage access");
        } finally { await viewer.close(); }
      } else {
        assert.equal(report.status, 403, "Metadata-only user must not view report");
      }
      assert.equal((await fetch(
        `${apiBase}/api/customers/${other.customer}/diagnostics/incidents/${evidence.id}/report`, { headers },
      )).status, 403);
      const replay = await fetch(discovery.token_endpoint, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code", client_id: clientId,
          redirect_uri: callbackUri, code, code_verifier: verifier,
        }),
      });
      assert.equal(replay.status, 400, "Consumed authorization code must not be reusable");
      console.log(`PASS ${account.username}: real browser PKCE login, ID-token nonce, own-customer API, cross-customer denial, ID-token denial, code replay denial`);
      console.log(`PASS ${account.username}: captured incident listing and report permission boundary`);
    } finally { await context.close(); }
  }
  const directGrant = await fetch(discovery.token_endpoint, {
    method: "POST", body: new URLSearchParams({
      client_id: clientId, grant_type: "password",
      username: accounts[0].username, password: accounts[0].password,
    }),
  });
  assert.equal(directGrant.status, 400, "Password grant must be disabled");
  assert.equal(audit.length, 13);
  assert.deepEqual(operationalErrors, []);
  const persisted = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = persisted.prepare("SELECT request_id, outcome, status FROM access_audit ORDER BY sequence").all();
    assert.deepEqual(rows.map((row) => ({ ...row })), audit.map((event) => ({
      request_id: event.requestId, outcome: event.outcome, status: event.status,
    })));
    const records = JSON.stringify(persisted.prepare("SELECT * FROM access_audit").all());
    assert.ok(!records.includes("Bearer") && !records.includes("eyJ"));
  } finally { persisted.close(); }
  const backupDirectory = await backupDiagnosticStore(databasePath, storageDirectory);
  const restoredPath = await restoreDiagnosticStore(backupDirectory, storageDirectory);
  const restored = openDiagnosticStore(restoredPath);
  try {
    for (const entry of entries) {
      assert.deepEqual(await restored.catalog.list(entry.customer), [entry.summary]);
      assert.equal(await restored.catalog.report(entry.customer, entry.summary.id), entry.report!.html);
    }
    const original = new DatabaseSync(databasePath, { readOnly: true });
    const recovered = new DatabaseSync(restoredPath, { readOnly: true });
    try {
      assert.deepEqual(recovered.prepare("SELECT * FROM access_audit ORDER BY sequence").all(),
        original.prepare("SELECT * FROM access_audit ORDER BY sequence").all());
      assert.deepEqual(recovered.prepare("SELECT * FROM incident_reviews ORDER BY candidate").all(),
        original.prepare("SELECT * FROM incident_reviews ORDER BY candidate").all());
      assert.deepEqual(recovered.prepare("SELECT * FROM report_candidates ORDER BY id").all(),
        original.prepare("SELECT * FROM report_candidates ORDER BY id").all());
    } finally { original.close(); recovered.close(); }
  } finally { restored.close(); }
  console.log("PASS staged reports hidden until synthetic review; backup/restore preserves reports, reviews and thirteen access decisions");
} finally {
  if (browser) await browser.close();
  await Promise.all([close(api), close(callback)]);
  store.close();
  await rm(storageDirectory, { recursive: true });
}
