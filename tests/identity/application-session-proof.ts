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
const errorRequestIds: string[] = [];
const logoutAuditFailure = new Error("Synthetic logout audit failure");
let failLogoutAudit = false;
const api = createDiagnosticApi({
  issuer, audience: "diagnostic-api", jwksUrl: discovery.jwks_uri, allowLoopbackHttpForTests: true,
  memberships: accounts.map((account) => ({
    issuer, subject: account.subject, customer: account.customer,
    permissions: account.username === "alice" ? ["diagnostics:read", "diagnostics:report", "diagnostics:review"] : ["diagnostics:read"],
  })), supportGrants: [],
}, async (event) => {
  if (failLogoutAudit && event.operation === "session-logout") throw logoutAuditFailure;
  await store.audit(event);
}, (error, requestId) => { errors.push(error); errorRequestIds.push(requestId); }, store.catalog, store, {
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
      let logoutAttempts = 0;
      page.on("request", (request) => {
        if (request.url() === origin + "/auth/logout" && request.method() === "POST") logoutAttempts++;
        if (request.url().startsWith(origin + "/api/")) {
          assert.equal(request.headers().authorization, undefined, "Browser must not receive/send bearer credentials");
          apiRequests.push(request.url());
        }
      });
      await page.goto(`${origin}/engineering/reviews/${account.customer}`);
      await page.getByText("Sign in to review reports.", { exact: true }).waitFor();
      assert.equal(apiRequests.length, 0);
      if (account.username === "alice") {
        for (const failure of ["server", "malformed", "network", "invalid-id", "missing-id"]) {
          const reference = "12345678-1234-1234-1234-123456789abc";
          let bootstraps = 0;
          await page.route("**/auth/session", (route) => {
            bootstraps++;
            if (failure === "network") return route.abort("failed");
            return route.fulfill({
              status: failure === "malformed" ? 200 : 503,
              headers: failure === "missing-id" ? {} : { "X-Request-Id": failure === "invalid-id" ? "<img src=x>private-reference" : reference },
              contentType: "application/json", body: failure === "server" ? "{}" : "{",
            });
          });
          await page.reload();
          await page.getByRole("button", { name: "Retry session connection", exact: true }).waitFor();
          assert.equal(await page.getByRole("alert").textContent() !== "", true);
          const message = await page.getByRole("alert").textContent();
          assert.ok(message?.includes(`session bootstrap request ${["network", "invalid-id", "missing-id"].includes(failure) ? "unavailable" : reference}`));
          assert.ok(!message?.includes("private-reference"));
          assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
          assert.equal(await page.getByRole("region", { name: "Pending reports", exact: true }).count(), 0);
          assert.equal(apiRequests.length, 0);
          assert.equal(logoutAttempts, 0);
          assert.equal(bootstraps, 1, "Bootstrap failures must not trigger automatic retries");
          await page.unroute("**/auth/session");
          await page.getByRole("button", { name: "Retry session connection", exact: true }).click();
          await page.getByText("Sign in to review reports.", { exact: true }).waitFor();
          assert.equal(await page.getByRole("button", { name: "Retry session connection", exact: true }).count(), 0);
        }
      }
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
        await page.getByRole("button", { name: `Inspect ${candidate.id}`, exact: true }).waitFor();
        const originalSessionId = sessionCookies[0].value;
        const beforeRecovery = apiRequests.length;
        await page.route("**/auth/session", (route) => route.fulfill({
          status: 503, contentType: "application/json", body: "{}",
        }));
        await page.reload();
        await page.getByRole("button", { name: "Retry session connection", exact: true }).waitFor();
        assert.equal(apiRequests.length, beforeRecovery);
        assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
        await page.unroute("**/auth/session");
        await page.getByRole("button", { name: "Retry session connection", exact: true }).click();
        await page.getByRole("button", { name: `Inspect ${candidate.id}`, exact: true }).waitFor();
        assert.equal((await context.cookies(origin)).find((entry) => entry.name === "asterisk-test-session")?.value, originalSessionId);
        assert.equal(logoutAttempts, 0);
        await page.getByRole("button", { name: `Inspect ${candidate.id}`, exact: true }).click();
        await page.getByRole("region", { name: "Candidate review", exact: true }).getByRole("heading", { name: "Session-reviewed synthetic report" }).waitFor();
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
        const [unfinished] = store.stage([{
          customer: "customer-a",
          summary: { id: "incident-" + "b".repeat(32), title: "Unfinished local review", createdAt: "2026-10-22T12:00:00Z" },
          report: { html, sha256: createHash("sha256").update(html).digest("hex") },
        }]);
        await page.getByRole("button", { name: "Refresh pending reports", exact: true }).click();
        await page.getByRole("button", { name: `Inspect ${unfinished.id}`, exact: true }).click();
        await page.getByLabel("Review reason", { exact: true }).fill("Must not delay logout");
        assert.equal(await page.evaluate(() =>
          !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
        const expiryPage = await context.newPage();
        try {
          const clockStart = new Date("2030-01-01T00:00:00Z");
          await expiryPage.clock.install({ time: clockStart });
          await expiryPage.clock.pauseAt(new Date(clockStart.getTime() + 1000));
          let advertisedExpiry = new Date(clockStart.getTime() + 181000).toISOString();
          // Shorten only the advertised UI deadline; server token/session tests are separate.
          await expiryPage.route("**/auth/session", async (route) => {
            const response = await route.fetch();
            const body = await response.json();
            body.expiresAt = advertisedExpiry;
            await route.fulfill({ response, json: body });
          });
          const decisions: string[] = [];
          expiryPage.on("request", (request) => {
            if (request.method() === "POST") decisions.push(request.url());
          });
          await expiryPage.goto(`${origin}/engineering/reviews/customer-a`);
          await expiryPage.getByRole("button", { name: `Inspect ${unfinished.id}`, exact: true }).click();
          await expiryPage.getByLabel("Review reason", { exact: true }).fill("Will be cleared at expiry");
          const warning = expiryPage.getByRole("status").filter({ hasText: "Session expires in two minutes or less." });
          assert.equal(await warning.isVisible(), false);
          await expiryPage.clock.fastForward(59000);
          assert.equal(await warning.isVisible(), false);
          await expiryPage.clock.fastForward(1000);
          await warning.waitFor();
          assert.equal(await expiryPage.getByLabel("Review reason", { exact: true }).inputValue(), "Will be cleared at expiry");
          assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 1);
          await expiryPage.clock.fastForward(120000);
          await expiryPage.getByText("Session expired. Sign in again.", { exact: true }).waitFor();
          assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 0);
          assert.equal(await expiryPage.getByLabel("Review reason", { exact: true }).count(), 0);
          assert.equal(await warning.count(), 0);
          assert.equal(await expiryPage.evaluate(() =>
            window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
          assert.deepEqual(decisions, []);
          assert.ok(store.pending("customer-a").some((pending) => pending.id === unfinished.id));
          for (const eventType of ["visibilitychange", "pageshow"]) {
            await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 1000));
            await expiryPage.reload();
            await expiryPage.getByRole("button", { name: `Inspect ${unfinished.id}`, exact: true }).click();
            await expiryPage.getByLabel("Review reason", { exact: true }).fill("Suspended-page local review");
            // Advance wall time without firing scheduled timers, as with a suspended tab.
            await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 61000));
            await expiryPage.evaluate((type) => {
              (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type));
            }, eventType);
            await warning.waitFor();
            assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 1);
            await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 181001));
            await expiryPage.evaluate((type) => {
              (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type));
            }, eventType);
            await expiryPage.getByText("Session expired. Sign in again.", { exact: true }).waitFor();
            assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 0);
            assert.equal(await expiryPage.getByLabel("Review reason", { exact: true }).count(), 0);
            assert.equal(await expiryPage.evaluate(() =>
              window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
            await expiryPage.evaluate((type) => {
              (type === "visibilitychange" ? document : window).dispatchEvent(new Event(type));
            }, eventType);
            assert.equal(await expiryPage.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
          }
          assert.deepEqual(decisions, []);
          const bootstrapRequests: string[] = [];
          expiryPage.on("request", (request) => {
            if (request.url().startsWith(origin + "/api/")) bootstrapRequests.push(request.url());
          });
          for (const offset of [-1, 0]) {
            await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 1000));
            advertisedExpiry = new Date(clockStart.getTime() + 1000 + offset).toISOString();
            await expiryPage.reload();
            await expiryPage.getByRole("alert").filter({ hasText: "Session expired. Sign in again." }).waitFor();
            assert.equal(await expiryPage.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
            assert.equal(await expiryPage.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
            assert.equal(await expiryPage.getByRole("region", { name: "Pending reports", exact: true }).count(), 0);
            assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 0);
            assert.equal(await expiryPage.evaluate(() =>
              window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
          }
          assert.deepEqual(bootstrapRequests, [], "Expired bootstrap must not fetch review metadata or evidence");
          assert.deepEqual(decisions, []);
          await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 1000));
          advertisedExpiry = new Date(clockStart.getTime() + 6000).toISOString();
          let releaseList!: () => void;
          let listStarted!: () => void;
          let listFinished!: () => void;
          const heldList = new Promise<void>((resolve) => { releaseList = resolve; });
          const listRequested = new Promise<void>((resolve) => { listStarted = resolve; });
          const listCompleted = new Promise<void>((resolve) => { listFinished = resolve; });
          const listPattern = "**/api/customers/customer-a/diagnostics/reviews";
          await expiryPage.route(listPattern, async (route) => {
            listStarted();
            await heldList;
            try { await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify({ candidates: store.pending("customer-a") }),
            }); } finally { listFinished(); }
          });
          try {
            await expiryPage.reload({ waitUntil: "commit" });
            await listRequested;
            await expiryPage.getByRole("status").filter({ hasText: "Loading pending reports..." }).waitFor();
            const requestFailed = expiryPage.waitForEvent("requestfailed", {
              predicate: (request) => request.url() === reviewRoot,
            });
            await expiryPage.clock.fastForward(5000);
            await expiryPage.getByText("Session expired. Sign in again.", { exact: true }).waitFor();
            await requestFailed;
            assert.equal(await expiryPage.getByText("Review connection closed.", { exact: true }).count(), 1);
            assert.equal(await expiryPage.getByRole("region", { name: "Pending reports", exact: true }).count(), 0);
            assert.equal(await expiryPage.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
            assert.deepEqual(decisions, []);
          } finally {
            releaseList();
            await listCompleted;
            await expiryPage.unroute(listPattern);
          }
          assert.equal(await expiryPage.getByText("Review connection closed.", { exact: true }).count(), 1);
          for (const rejectedOperation of ["list", "candidate", "decision"]) {
            await expiryPage.clock.setSystemTime(new Date(clockStart.getTime() + 1000));
            advertisedExpiry = new Date(clockStart.getTime() + 181000).toISOString();
            const rejectedPath = rejectedOperation === "list" ? listPattern : `${listPattern}/${unfinished.id}`;
            if (rejectedOperation === "list") {
              await expiryPage.route(rejectedPath, (route) => route.fulfill({
                status: 401, contentType: "text/plain", body: "Session unavailable",
              }));
            }
            await expiryPage.reload();
            if (rejectedOperation !== "list") {
              if (rejectedOperation === "candidate") {
                await expiryPage.route(rejectedPath, (route) => route.fulfill({
                  status: 401, contentType: "application/json", body: "{",
                }));
              }
              await expiryPage.getByRole("button", { name: `Inspect ${unfinished.id}`, exact: true }).click();
              if (rejectedOperation === "decision") {
                await expiryPage.getByLabel("Review reason", { exact: true }).fill("Rejected session decision");
                await expiryPage.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
                await expiryPage.route(rejectedPath, (route) => route.fulfill({
                  status: 401, contentType: "application/json", body: JSON.stringify({ code: "session_required" }),
                }));
                await expiryPage.getByRole("button", { name: "Approve report", exact: true }).click();
                await expiryPage.getByRole("button", { name: "Confirm approval", exact: true }).click();
              }
            }
            await expiryPage.getByRole("alert").filter({ hasText: "Application session is no longer valid." }).waitFor();
            assert.equal(await expiryPage.getByText("Review connection closed.", { exact: true }).count(), 1);
            assert.equal(await expiryPage.getByRole("region", { name: "Pending reports", exact: true }).count(), 0);
            assert.equal(await expiryPage.getByTitle("Rendered report preview").count(), 0);
            assert.equal(await expiryPage.getByRole("button", { name: "Sign out", exact: true }).count(), 0);
            assert.equal(await expiryPage.getByRole("link", { name: "Sign in", exact: true }).isVisible(), true);
            assert.equal(await expiryPage.evaluate(() =>
              window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
            await expiryPage.clock.fastForward(180000);
            assert.equal(await expiryPage.getByText("Session expired. Sign in again.", { exact: true }).count(), 0);
            assert.ok(store.pending("customer-a").some((pending) => pending.id === unfinished.id));
            await expiryPage.unroute(rejectedPath);
          }
          assert.equal(decisions.length, 1, "A rejected decision must not be retried automatically");
        } finally { await expiryPage.close(); }
      } else {
        await page.getByRole("alert").filter({ hasText: "403: customer_access_denied" }).waitFor();
        assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isVisible(), true);
        assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), false);
      }
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
      assert.ok(!(await page.content()).includes(client.secret));
      assert.ok(!(await page.evaluate(() => document.cookie)).includes(sessionCookies[0].value));
      assert.equal((await fetch(origin + "/auth/logout", { method: "POST", headers: { Cookie: cookie, Origin: origin } })).status, 403);
      if (account.username === "alice") {
        failLogoutAudit = true;
        try {
          const failedLogout = page.waitForResponse((response) => response.url() === origin + "/auth/logout");
          await page.getByRole("button", { name: "Sign out", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "Sign out was not confirmed." }).waitFor();
          const failureResponse = await failedLogout;
          const failureRequestId = failureResponse.headers()["x-request-id"];
          assert.match(failureRequestId, /^[0-9a-f-]{36}$/);
          assert.equal(errorRequestIds[0], failureRequestId);
          assert.ok((await page.getByRole("alert").filter({ hasText: "Sign out was not confirmed." }).textContent())?.includes(`request ${failureRequestId}`));
          assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled(), true);
          assert.equal(await page.getByRole("link", { name: "Sign in", exact: true }).isVisible(), false);
          assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Must not delay logout");
          assert.equal(await page.getByTitle("Rendered report preview").count(), 1);
          assert.equal(await page.evaluate(() =>
            !window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
          assert.equal((await context.cookies(origin)).find((entry) => entry.name === "asterisk-test-session")?.value, sessionCookies[0].value);
          assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: cookie } })).status, 200);
          const reader = new DatabaseSync(databasePath, { readOnly: true });
          try {
            assert.equal(reader.prepare("SELECT count(*) AS total FROM access_audit WHERE operation = 'session-logout'").get()?.total, 0);
          } finally { reader.close(); }
          assert.deepEqual(errors, [logoutAuditFailure]);
          assert.equal(logoutAttempts, 1, "Audit failures must not automatically retry logout");
        } finally { failLogoutAudit = false; }
        await page.route("**/auth/logout", (route) => route.abort("failed"));
        try {
          await page.getByRole("button", { name: "Sign out", exact: true }).click();
          await page.getByRole("alert").filter({ hasText: "Sign out was not confirmed." }).waitFor();
          assert.ok((await page.getByRole("alert").filter({ hasText: "Sign out was not confirmed." }).textContent())?.includes("request unavailable"));
          assert.equal(logoutAttempts, 2, "Transport failures must not automatically retry logout");
          assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled(), true);
          assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Must not delay logout");
          assert.equal((await fetch(origin + "/auth/session", { headers: { Cookie: cookie } })).status, 200);
        } finally { await page.unroute("**/auth/logout"); }
      }
      await page.getByRole("button", { name: "Sign out", exact: true }).click();
      await page.getByText("Sign in to review reports.", { exact: true }).waitFor();
      assert.equal(await page.evaluate(() =>
        window.dispatchEvent(new Event("beforeunload", { cancelable: true }))), true);
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.equal((await fetch(reviewRoot, { headers: { Cookie: cookie } })).status, 401);
      assert.equal((await context.cookies(origin)).filter((cookie) => cookie.name === "asterisk-test-session").length, 0);
      assert.equal(logoutAttempts, account.username === "alice" ? 3 : 1);
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
  assert.deepEqual(errors, [logoutAuditFailure]);
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
