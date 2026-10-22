import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { chromium } from "playwright";
import { createDiagnosticApi } from "../src/diagnostic-api.ts";
import { openDiagnosticStore } from "../src/diagnostic-store.ts";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No listener address");
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  if (!server.listening) return;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

test("browser workspace keeps previews inert, confirms exact decisions and surfaces access/storage/conflict failures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-review-ui-"));
  const store = openDiagnosticStore(join(directory, "diagnostics.sqlite"));
  const keys = await generateKeyPair("RS256");
  const jwk = await exportJWK(keys.publicKey);
  const issuer = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ keys: [{ ...jwk, kid: "ui-key", alg: "RS256", use: "sig" }] }));
  });
  let api: Server | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const issuerUrl = await listen(issuer);
    api = createDiagnosticApi({
      issuer: issuerUrl, audience: "diagnostic-api", jwksUrl: issuerUrl + "/jwks",
      allowLoopbackHttpForTests: true, supportGrants: [],
      memberships: [
        { issuer: issuerUrl, subject: "reviewer", customer: "customer-a", permissions: ["diagnostics:review"] },
        { issuer: issuerUrl, subject: "reader", customer: "customer-a", permissions: ["diagnostics:read"] },
      ],
    }, store.audit, (error) => { throw error; }, store.catalog, store);
    const origin = await listen(api);
    const jwt = async (subject: string, expired = false) => new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "ui-key" })
      .setIssuer(issuerUrl).setAudience("diagnostic-api").setSubject(subject)
      .setIssuedAt().setExpirationTime(expired ? Math.floor(Date.now() / 1000) - 1 : "5m")
      .sign(keys.privateKey);
    const reviewer = await jwt("reviewer");
    const html = `<!doctype html><script>parent.document.body.dataset.executed="yes";fetch("https://untrusted.invalid/leak")</script>
      <img src="https://untrusted.invalid/image" onerror="alert('unsafe')">
      <meta http-equiv="refresh" content="0;url=https://untrusted.invalid/redirect">
      <base href="https://untrusted.invalid/"><link rel="stylesheet" href="https://untrusted.invalid/style">
      <style>body { background: url(https://untrusted.invalid/css); }</style>
      <h1 id="spoofed" onclick="alert('unsafe')">Unapproved report</h1>
      <table style="display:none"><caption>Observed signalling</caption><tr><th colspan="2">Message</th></tr>
      <tr><td>INVITE</td><td>SIP 200 OK</td></tr></table>
      <details><summary>Packet provenance</summary><p>Frame 42</p></details>
      <a href="https://untrusted.invalid/link" target="_top">Untrusted link text</a>
      <iframe src="https://untrusted.invalid/frame"></iframe>
      <svg onload="alert('unsafe')"><image href="https://untrusted.invalid/svg"></image></svg>
      <math><mtext><img src="https://untrusted.invalid/math"></mtext></math>
      <form action="https://untrusted.invalid"><input autofocus>Form text</form>`;
    const title = '<img src="https://untrusted.invalid/title"> Synthetic report';
    const stage = (digit: string) => store.stage([{
      customer: "customer-a",
      summary: { id: "incident-" + digit.repeat(32), title, createdAt: "2026-10-22T12:00:00Z" },
      report: { html, sha256: createHash("sha256").update(html).digest("hex") },
    }])[0];
    const approved = stage("a");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const unexpected: string[] = [];
      const posts: string[] = [];
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== origin) unexpected.push(request.url());
        if (request.headers().authorization && !new URL(request.url()).pathname.startsWith("/api/customers/customer-a/diagnostics/reviews")) {
          unexpected.push("Authorization sent outside review API");
        }
        if (request.method() === "POST") posts.push(request.postData() ?? "");
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const connect = async (token: string) => {
        const shell = await page.goto(`${origin}/engineering/reviews/customer-a`);
        assert.equal(shell?.status(), 200);
        assert.match(shell?.headers()["content-security-policy"] ?? "", /default-src 'none'/);
        assert.equal(shell?.headers()["cache-control"], "no-store");
        await page.evaluate(async (accessToken) => {
          const path = "/engineering/review.js";
          const module = await import(path);
          await module.connectReviewWorkspace(accessToken);
        }, token);
      };
      await page.goto(`${origin}/engineering/reviews/customer-a`);
      assert.equal(store.pending("customer-a").length, 1);
      assert.equal(await page.getByRole("button").count(), 0, "Shell must not retrieve evidence without a session adapter");
      await connect(reviewer);
      await page.getByRole("button", { name: `Inspect ${approved.id}`, exact: true }).click();
      await page.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.equal(await page.getByLabel("Inert report preview").textContent(), html);
      assert.equal(await page.locator("iframe").count(), 1);
      assert.equal(await page.locator("img, script, form").count(), 0);
      assert.equal(await page.getByTitle("Rendered report preview").getAttribute("sandbox"), "");
      const rendered = page.frameLocator('iframe[title="Rendered report preview"]');
      await rendered.getByRole("heading", { name: "Unapproved report", exact: true }).waitFor();
      assert.equal(await rendered.getByRole("cell", { name: "INVITE", exact: true }).count(), 1);
      assert.equal(await rendered.getByRole("cell", { name: "SIP 200 OK", exact: true }).count(), 1);
      assert.equal(await rendered.getByRole("columnheader", { name: "Message" }).getAttribute("colspan"), "2");
      assert.equal(await rendered.locator("details").getAttribute("open"), "");
      assert.equal(await rendered.getByText("Frame 42", { exact: true }).isVisible(), true);
      assert.equal(await rendered.locator("a, form, input, img, iframe, svg, math, script, style, link, base, [onclick], [style], [id]").count(), 0);
      assert.ok((await rendered.locator("body").textContent())?.includes("Untrusted link text"));
      const previewFrame = page.frames().find((frame) => frame.parentFrame() !== null);
      assert.ok(previewFrame);
      assert.equal(await previewFrame.evaluate(() => {
        try { return parent.document.body !== null; } catch { return false; }
      }), false);
      assert.equal(await previewFrame.evaluate(() => {
        try { localStorage.getItem("preview-test"); return true; } catch { return false; }
      }), false);
      await page.getByText("Original report source", { exact: true }).click();
      assert.equal(await page.evaluate(() => document.body.dataset.executed), undefined);
      assert.deepEqual(unexpected, []);
      await page.getByRole("button", { name: "Approve report", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Enter a review reason" }).waitFor();
      assert.equal(posts.length, 0);
      await page.getByLabel("Review reason", { exact: true }).fill("Reviewed scope and redaction");
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      await page.getByRole("button", { name: "Approve report", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "Confirm review decision" });
      assert.ok((await confirmation.textContent())?.includes(approved.sha256));
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(posts.length, 0);
      assert.equal(await store.catalog.report("customer-a", "incident-" + "a".repeat(32)), undefined);
      await page.getByRole("button", { name: "Approve report", exact: true }).click();
      await page.getByRole("button", { name: "Confirm approval", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Review recorded: approve. No pending reports." }).waitFor();
      assert.equal(posts.length, 1);
      assert.deepEqual(JSON.parse(posts[0]), { decision: "approve", reason: "Reviewed scope and redaction", sha256: approved.sha256 });
      assert.equal(await store.catalog.report("customer-a", "incident-" + "a".repeat(32)), html);
      assert.ok(!(await page.content()).includes(reviewer));
      assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
      assert.equal((await context.cookies()).length, 0);

      const rejected = stage("b");
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await page.getByRole("button", { name: `Inspect ${rejected.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).fill("Not suitable for disclosure");
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      await page.getByRole("button", { name: "Reject report", exact: true }).click();
      await page.getByRole("button", { name: "Confirm rejection", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Review recorded: reject. No pending reports." }).waitFor();
      assert.equal(await store.catalog.report("customer-a", "incident-" + "b".repeat(32)), undefined);

      const conflict = stage("c");
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await page.getByRole("button", { name: `Inspect ${conflict.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).fill("Stale review");
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      store.review(conflict.id, { decision: "reject", reason: "Decided elsewhere", reviewer: "another-reviewer", sha256: conflict.sha256 });
      await page.getByRole("button", { name: "Approve report", exact: true }).click();
      await page.getByRole("button", { name: "Confirm approval", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "409: review_already_decided" }).waitFor();
      assert.equal(await page.getByLabel("Inert report preview").count(), 0);
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
      assert.equal(await store.catalog.report("customer-a", "incident-" + "c".repeat(32)), undefined);

      await connect(await jwt("reader"));
      await page.getByRole("alert").filter({ hasText: "403: customer_access_denied" }).waitFor();
      assert.equal(await page.getByLabel("Inert report preview").count(), 0);
      await connect(await jwt("reviewer", true));
      await page.getByRole("alert").filter({ hasText: "401: invalid_bearer_token" }).waitFor();
      await page.route("**/api/customers/customer-a/diagnostics/reviews", (route) => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ code: "synthetic_storage_failure", requestId: "ui-failure" }),
      }));
      await connect(reviewer);
      await page.getByRole("alert").filter({ hasText: "503: synthetic_storage_failure" }).waitFor();
      await page.unroute("**/api/customers/customer-a/diagnostics/reviews");
      await page.route("**/api/customers/customer-a/diagnostics/reviews", (route) => route.fulfill({
        status: 200, contentType: "application/json", body: JSON.stringify({ candidates: [{ id: "../wrong", sha256: "x" }] }),
      }));
      await connect(reviewer);
      await page.getByRole("alert").filter({ hasText: "Invalid pending report response" }).waitFor();
      await page.unroute("**/api/customers/customer-a/diagnostics/reviews");
      await page.route("**/api/customers/customer-a/diagnostics/reviews", (route) => route.abort("failed"));
      await connect(reviewer);
      await page.getByRole("alert").filter({ hasText: "Failed to fetch" }).waitFor();
      assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
      await page.unroute("**/api/customers/customer-a/diagnostics/reviews");
      await page.evaluate(async (accessToken) => {
        const path = "/engineering/review.js";
        const module = await import(path);
        const disconnect = await module.connectReviewWorkspace(accessToken);
        disconnect();
      }, reviewer);
      assert.equal(await page.getByText("Review connection closed.", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button").count(), 0);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      const limits = await page.evaluate(async () => {
        const path = "/engineering/review-preview.js";
        const { createReviewPreview } = await import(path);
        const results: string[] = [];
        for (const html of [
          "x".repeat(2 * 1024 * 1024 + 1),
          "<div>".repeat(130) + "Nested evidence" + "</div>".repeat(130),
          "<span>x</span>".repeat(50001),
        ]) {
          try { createReviewPreview(html); results.push("unexpected-success"); }
          catch (error) { results.push(error instanceof Error ? error.message : "unknown-error"); }
        }
        return results;
      });
      assert.match(limits[0], /size limit/);
      assert.match(limits[1], /structure exceeds/);
      assert.match(limits[2], /structure exceeds/);
    } finally { await context.close(); }
  } finally {
    if (browser) await browser.close();
    if (api) await close(api);
    await close(issuer);
    store.close();
    await rm(directory, { recursive: true });
  }
});
