import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { createDiagnosticApi } from "../../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../../src/diagnostic-store.ts";

const issuer = "http://127.0.0.1:18080/realms/local-proof";
const origin = "http://127.0.0.1:18766";
const accounts: { subject: string; username: string; password: string; customer: string }[] =
  JSON.parse(await readFile(new URL("../../.local-proof/identity/accounts.json", import.meta.url), "utf8"));
const client: { clientId: string; secret: string } =
  JSON.parse(await readFile(new URL("../../.local-proof/identity/application-client.json", import.meta.url), "utf8"));
const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
assert.equal(discoveryResponse.status, 200);
const discovery = await discoveryResponse.json();
const directory = await mkdtemp(join(tmpdir(), "asterisk-app-session-"));
const databasePath = join(directory, "diagnostics.sqlite");
const store = openDiagnosticStore(databasePath);
const html = "<!doctype html><h1>Synthetic session report</h1>";
const incident = "incident-" + "a".repeat(32);
const [candidate] = store.stage([{
  customer: "customer-a", summary: { id: incident, title: "Session-reviewed synthetic report", createdAt: "2026-10-22T12:00:00Z" },
  report: { html, sha256: createHash("sha256").update(html).digest("hex") },
}]);
const errors: unknown[] = [];
const api = createDiagnosticApi({
  issuer, audience: "diagnostic-api", jwksUrl: discovery.jwks_uri, allowLoopbackHttpForTests: true,
  memberships: accounts.map((account) => ({
    issuer, subject: account.subject, customer: account.customer,
    permissions: account.username === "alice" ? ["diagnostics:read", "diagnostics:report", "diagnostics:review"] : ["diagnostics:read"],
  })), supportGrants: [],
}, store.audit, (error) => errors.push(error), store.catalog, store, {
  origin, issuer, authorizationEndpoint: discovery.authorization_endpoint,
  tokenEndpoint: discovery.token_endpoint, jwksUrl: discovery.jwks_uri,
  clientId: client.clientId, clientSecret: client.secret, audience: "diagnostic-api",
  allowLoopbackHttpForTests: true,
});
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  api.listen(18766, "127.0.0.1");
  await once(api, "listening");
  browser = await chromium.launch({ headless: true });
  for (const account of accounts) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const browserErrors: string[] = [];
      page.on("pageerror", (error) => browserErrors.push(error.message));
      const apiRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith(origin + "/api/")) {
          assert.equal(request.headers().authorization, undefined, "Browser must not receive/send bearer credentials");
          apiRequests.push(request.url());
        }
      });
      await page.goto(`${origin}/engineering/reviews/${account.customer}`);
      await page.getByText("Sign in to review reports.", { exact: true }).waitFor();
      assert.equal(apiRequests.length, 0);
      await page.getByRole("link", { name: "Sign in", exact: true }).click();
      await page.locator("#username").fill(account.username);
      await page.locator("#password").fill(account.password);
      await page.locator("#kc-login").click();
      await page.getByRole("button", { name: "Sign out", exact: true }).waitFor();
      const sessionCookies = (await context.cookies(origin)).filter((cookie) => cookie.name === "asterisk-test-session");
      assert.equal(sessionCookies.length, 1);
      assert.equal(sessionCookies[0].httpOnly, true);
      assert.equal(sessionCookies[0].sameSite, "Lax");
      const cookie = `${sessionCookies[0].name}=${sessionCookies[0].value}`;
      const reviewRoot = `${origin}/api/customers/${account.customer}/diagnostics/reviews`;
      if (account.username === "alice") {
        await page.getByRole("button", { name: `Inspect ${candidate.id}`, exact: true }).click();
        await page.getByRole("heading", { name: "Session-reviewed synthetic report" }).waitFor();
        const decision = { decision: "approve", reason: "Invalid CSRF attempt", sha256: candidate.sha256 };
        const invalidCsrfHeaders: Record<string, string>[] = [
          { Cookie: cookie, Origin: origin },
          { Cookie: cookie, Origin: "https://untrusted.invalid", "X-CSRF-Token": "wrong" },
          { Cookie: cookie, Origin: origin, "X-CSRF-Token": "wrong" },
        ];
        for (const headers of invalidCsrfHeaders) {
          const denied = await fetch(`${reviewRoot}/${candidate.id}`, {
            method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(decision),
          });
          assert.equal(denied.status, 403);
        }
        assert.equal(await store.catalog.report("customer-a", incident), undefined);
        assert.equal((await fetch(reviewRoot.replace("customer-a", "customer-b"), { headers: { Cookie: cookie } })).status, 403);
        await page.getByLabel("Review reason", { exact: true }).fill("Reviewed through a real server-managed session");
        await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
        await page.getByRole("button", { name: "Approve report", exact: true }).click();
        await page.getByRole("button", { name: "Confirm approval", exact: true }).click();
        await page.getByRole("status").filter({ hasText: "Review recorded: approve." }).waitFor();
        assert.equal(await store.catalog.report("customer-a", incident), html);
        const reader = new DatabaseSync(databasePath, { readOnly: true });
        try { assert.equal(reader.prepare("SELECT reviewer FROM incident_reviews").get()?.reviewer, account.subject); }
        finally { reader.close(); }
        await page.reload();
        await page.getByRole("status").filter({ hasText: "No pending reports." }).waitFor();
      } else {
        await page.getByRole("alert").filter({ hasText: "403: customer_access_denied" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
      }
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
      assert.ok(!(await page.content()).includes(client.secret));
      assert.ok(!(await page.evaluate(() => document.cookie)).includes(sessionCookies[0].value));
      assert.equal((await fetch(origin + "/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 403);
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByText("Sign in to review reports.", { exact: true }).waitFor();
      assert.equal((await fetch(reviewRoot, { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await context.cookies(origin)).filter((cookie) => cookie.name === "asterisk-test-session").length, 0);
      assert.deepEqual(browserErrors, []);
      console.log(`PASS ${account.username}: ordinary browser login, HttpOnly session, CSRF, permission boundary and logout replay denial`);
    } finally { await context.close(); }
  }
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit WHERE operation = 'session-login'").get()?.total, 2);
    assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit WHERE operation = 'session-logout'").get()?.total, 2);
    const audit = JSON.stringify(reader.prepare("SELECT * FROM access_audit").all());
    assert.ok(!audit.includes(client.secret) && !audit.includes("Bearer") && !audit.includes("eyJ"));
  } finally { reader.close(); }
  assert.deepEqual(errors, []);
  console.log("PASS confidential-client code exchange stays server-side; login/logout audits persisted without credentials");
} finally {
  if (browser) await browser.close();
  if (api.listening) {
    api.closeAllConnections();
    await new Promise<void>((resolve, reject) => api.close((error) => error ? reject(error) : resolve()));
  }
  store.close();
  await rm(directory, { recursive: true });
}
