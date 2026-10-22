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
    const stage = (digit: string, createdAt = "2026-10-22T12:00:00Z") => store.stage([{
      customer: "customer-a",
      summary: { id: "incident-" + digit.repeat(32), title, createdAt },
      report: { html, sha256: createHash("sha256").update(html).digest("hex") },
    }])[0];
    const approved = stage("a");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const unexpected: string[] = [];
      const posts: string[] = [];
      let reviewRequests = 0;
      page.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/customers/customer-a/diagnostics/reviews")) reviewRequests++;
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
      const pendingList = page.getByRole("region", { name: "Pending reports", exact: true });
      await pendingList.getByRole("heading", { name: title, exact: true }).waitFor();
      assert.ok((await pendingList.textContent())?.includes("incident-" + "a".repeat(32)));
      assert.ok((await pendingList.textContent())?.includes("2026-10-22T12:00:00Z"));
      assert.ok((await pendingList.textContent())?.includes(approved.sha256));
      assert.equal(await pendingList.locator("img, script, iframe").count(), 0);
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      const pendingFilter = page.getByLabel("Filter pending reports", { exact: true });
      const requestsBeforeFiltering = reviewRequests;
      await pendingFilter.fill("  SYNTHETIC REPORT  ");
      assert.equal(await pendingList.locator("article:visible").count(), 1);
      await pendingFilter.fill("<script>");
      assert.equal(await pendingList.locator("article:visible").count(), 0);
      await page.getByRole("status").filter({ hasText: "No matches. Clear the filter" }).waitFor();
      await page.getByRole("button", { name: "Clear pending filter", exact: true }).click();
      assert.equal(await pendingList.locator("article:visible").count(), 1);
      assert.equal(reviewRequests, requestsBeforeFiltering, "Filtering must not request reports or send filter text");
      await page.getByRole("button", { name: `Inspect ${approved.id}`, exact: true }).click();
      await page.getByRole("region", { name: "Candidate review", exact: true }).getByRole("heading", { name: title, exact: true }).waitFor();
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
      const evidenceText = await rendered.locator("body").textContent();
      await page.getByLabel("Find evidence text", { exact: true }).fill("invite");
      await page.getByLabel("Find evidence text", { exact: true }).press("Enter");
      await rendered.locator("mark").filter({ hasText: "INVITE" }).waitFor();
      assert.equal(await rendered.locator("mark").count(), 1);
      assert.equal(await rendered.locator("body").textContent(), evidenceText);
      await page.getByRole("status").filter({ hasText: "1 match(es)" }).waitFor();
      await page.getByLabel("Find evidence text", { exact: true }).fill("<img src=x onerror=alert(1)>");
      await page.getByRole("button", { name: "Highlight matches", exact: true }).click();
      await rendered.locator("mark").waitFor({ state: "detached" });
      await page.getByRole("status").filter({ hasText: "0 match(es)" }).waitFor();
      assert.equal(await rendered.locator("body").textContent(), evidenceText);
      await page.getByRole("button", { name: "Clear highlights", exact: true }).click();
      assert.equal(await page.getByLabel("Find evidence text", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("Inert report preview").textContent(), html);
      await page.getByText("Original report source", { exact: true }).click();
      assert.equal(await page.evaluate(() => document.body.dataset.executed), undefined);
      assert.deepEqual(unexpected, []);
      const beforeClose = reviewRequests;
      await page.getByRole("button", { name: "Close review without deciding", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Review closed. No decision sent." }).waitFor();
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.equal(await page.getByLabel("Inert report preview").count(), 0);
      assert.equal(await page.getByLabel("Find evidence text", { exact: true }).count(), 0);
      assert.equal(await page.getByLabel("Review reason", { exact: true }).count(), 0);
      assert.equal(await pendingFilter.evaluate((input) => input === document.activeElement), true);
      assert.equal(reviewRequests, beforeClose);
      assert.equal(posts.length, 0);
      assert.equal(store.pending("customer-a").length, 1);
      await page.getByRole("button", { name: `Inspect ${approved.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).waitFor();
      const unloadIsBlocked = () => page.evaluate(() =>
        !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
      assert.equal(await unloadIsBlocked(), false);
      await page.getByRole("button", { name: "Approve report", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Enter a review reason" }).waitFor();
      assert.equal(posts.length, 0);
      await page.getByLabel("Review reason", { exact: true }).fill("Reviewed scope and redaction");
      assert.equal(await unloadIsBlocked(), true);
      const cancelledReload = page.waitForEvent("dialog").then(async (dialog) => {
        assert.equal(dialog.type(), "beforeunload");
        await dialog.dismiss();
      });
      await page.evaluate(() => { setTimeout(() => location.reload(), 0); });
      await cancelledReload;
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Reviewed scope and redaction");
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      await page.getByRole("button", { name: "Close review without deciding", exact: true }).click();
      const discard = page.getByRole("dialog", { name: "Discard local review", exact: true });
      await discard.waitFor();
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Reviewed scope and redaction");
      assert.equal(await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").isChecked(), true);
      await page.getByRole("button", { name: "Close review without deciding", exact: true }).click();
      await page.keyboard.press("Escape");
      await discard.waitFor({ state: "hidden" });
      assert.equal(await page.getByTitle("Rendered report preview").count(), 1);
      const beforeDiscard = reviewRequests;
      await page.getByRole("button", { name: "Close review without deciding", exact: true }).click();
      await discard.getByRole("button", { name: "Discard and close", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "Review closed. No decision sent." }).waitFor();
      assert.equal(reviewRequests, beforeDiscard);
      assert.equal(posts.length, 0);
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.ok(!(await page.content()).includes("Reviewed scope and redaction"));
      assert.equal(await unloadIsBlocked(), false);
      assert.equal(store.pending("customer-a").length, 1);
      await page.getByRole("button", { name: `Inspect ${approved.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").isChecked(), false);
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      assert.equal(await unloadIsBlocked(), true);
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").uncheck();
      assert.equal(await unloadIsBlocked(), false);
      await page.getByLabel("Review reason", { exact: true }).fill("Temporary reason");
      await page.getByLabel("Review reason", { exact: true }).fill("");
      assert.equal(await unloadIsBlocked(), false);
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      await page.getByRole("button", { name: "Close review without deciding", exact: true }).click();
      await discard.waitFor();
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "");
      assert.equal(await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").isChecked(), true);
      await page.getByLabel("Review reason", { exact: true }).fill("Reviewed scope and redaction");
      const pendingOrder = page.getByLabel("Sort pending reports", { exact: true });
      await pendingOrder.selectOption("newest");
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Reviewed scope and redaction");
      await pendingFilter.fill("no matching pending reports");
      assert.equal(await pendingList.locator("article:visible").count(), 0);
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Reviewed scope and redaction");
      assert.equal(await page.getByTitle("Rendered report preview").count(), 1);
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
      assert.equal(await unloadIsBlocked(), false);
      assert.equal(await pendingFilter.inputValue(), "no matching pending reports");
      await page.getByRole("status").filter({ hasText: "0 of 0 loaded pending report(s) shown." }).waitFor();
      await page.getByRole("button", { name: "Clear pending filter", exact: true }).click();
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
      assert.equal(await page.getByLabel("Find evidence text", { exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
      assert.equal(await store.catalog.report("customer-a", "incident-" + "c".repeat(32)), undefined);

      const changed = stage("f");
      const additional = stage("e", "2026-10-22T12:30:00+01:00");
      const sameInstant = stage("d", "2026-10-22T11:30:00Z");
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await page.getByRole("status").filter({ hasText: "3 of 3 loaded pending report(s) shown." }).waitFor();
      assert.equal(await pendingOrder.inputValue(), "newest");
      const visibleIds = () => pendingList.locator("article:visible button").allTextContents();
      const tiedIds = [additional.id, sameInstant.id].sort().map((id) => `Inspect ${id}`);
      const beforeSorting = reviewRequests;
      assert.deepEqual(await visibleIds(), [`Inspect ${changed.id}`, ...tiedIds]);
      await pendingOrder.selectOption("oldest");
      assert.deepEqual(await visibleIds(), [...tiedIds, `Inspect ${changed.id}`]);
      await pendingOrder.selectOption("candidate");
      assert.deepEqual(await visibleIds(), [changed.id, additional.id, sameInstant.id].sort().map((id) => `Inspect ${id}`));
      assert.equal(reviewRequests, beforeSorting, "Sorting must not fetch reports or send ordering choices");
      await pendingFilter.fill(("incident-" + "f".repeat(32)).toUpperCase());
      assert.equal(await pendingList.locator("article:visible").count(), 1);
      assert.equal(await page.getByRole("button", { name: `Inspect ${changed.id}`, exact: true }).isVisible(), true);
      await pendingFilter.fill(additional.id);
      await pendingOrder.selectOption("oldest");
      assert.equal(await pendingList.locator("article:visible").count(), 1);
      assert.equal(await page.getByRole("button", { name: `Inspect ${additional.id}`, exact: true }).isVisible(), true);
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await page.getByRole("status").filter({ hasText: "1 of 3 loaded pending report(s) shown." }).waitFor();
      await pendingFilter.waitFor({ state: "visible" });
      assert.equal(await pendingFilter.inputValue(), additional.id);
      assert.equal(await pendingOrder.inputValue(), "oldest");
      assert.equal(await pendingList.locator("article:visible").count(), 1);
      await page.getByRole("button", { name: "Clear pending filter", exact: true }).click();
      assert.deepEqual(await visibleIds(), [...tiedIds, `Inspect ${changed.id}`]);
      await page.getByRole("button", { name: `Inspect ${additional.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).fill("Keep this local draft");
      await page.getByLabel("Find evidence text", { exact: true }).fill("INVITE");
      const beforeSwitch = reviewRequests;
      const beforeSwitchPosts = posts.length;
      await page.getByRole("button", { name: `Inspect ${sameInstant.id}`, exact: true }).click();
      await discard.waitFor();
      assert.ok((await discard.textContent())?.includes(sameInstant.id));
      assert.equal(reviewRequests, beforeSwitch);
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "Keep this local draft");
      assert.equal(await page.getByLabel("Find evidence text", { exact: true }).inputValue(), "INVITE");
      await page.getByRole("button", { name: `Inspect ${additional.id}`, exact: true }).click();
      await discard.waitFor();
      await page.keyboard.press("Escape");
      await discard.waitFor({ state: "hidden" });
      assert.equal(reviewRequests, beforeSwitch, "Reopening the same candidate must also protect a local draft");
      await page.getByRole("button", { name: `Inspect ${sameInstant.id}`, exact: true }).click();
      await discard.getByRole("button", { name: "Discard and open", exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).waitFor();
      assert.equal(await page.getByLabel("Review reason", { exact: true }).inputValue(), "");
      assert.equal(reviewRequests, beforeSwitch + 1);
      assert.equal(posts.length, beforeSwitchPosts);
      await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
      const beforeRefresh = reviewRequests;
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await discard.waitFor();
      assert.equal(reviewRequests, beforeRefresh);
      await discard.getByRole("button", { name: "Cancel", exact: true }).click();
      assert.equal(await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").isChecked(), true);
      await page.getByRole("button", { name: "Refresh pending reports" }).click();
      await discard.getByRole("button", { name: "Discard and refresh", exact: true }).click();
      await page.getByRole("status").filter({ hasText: "3 of 3 loaded pending report(s) shown." }).waitFor();
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.equal(reviewRequests, beforeRefresh + 1);
      assert.equal(posts.length, beforeSwitchPosts);
      assert.equal(store.pending("customer-a").length, 3);
      assert.equal(await pendingOrder.inputValue(), "oldest");
      const changedUrl = `**/api/customers/customer-a/diagnostics/reviews/${changed.id}`;
      await page.route(changedUrl, async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.candidate.entry.summary.title = "Changed metadata";
        await route.fulfill({ response, json: body });
      });
      await page.getByRole("button", { name: `Inspect ${changed.id}`, exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "Candidate metadata changed" }).waitFor();
      assert.equal(await page.getByTitle("Rendered report preview").count(), 0);
      assert.equal(await page.getByRole("button", { name: "Approve report", exact: true }).count(), 0);
      await page.unroute(changedUrl);

      await connect(await jwt("reader"));
      await page.getByRole("alert").filter({ hasText: "403: customer_access_denied" }).waitFor();
      assert.equal(await page.getByLabel("Inert report preview").count(), 0);
      assert.equal(await pendingOrder.isVisible(), false);
      await connect(await jwt("reviewer", true));
      await page.getByRole("alert").filter({ hasText: "401: invalid_bearer_token" }).waitFor();
      await page.route("**/api/customers/customer-a/diagnostics/reviews", (route) => route.fulfill({
        status: 503, contentType: "application/json", body: JSON.stringify({ code: "synthetic_storage_failure", requestId: "ui-failure" }),
      }));
      await connect(reviewer);
      await page.getByRole("alert").filter({ hasText: "503: synthetic_storage_failure" }).waitFor();
      await page.unroute("**/api/customers/customer-a/diagnostics/reviews");
      for (const badSummary of [
        undefined,
        { id: "wrong", title: "Report", createdAt: "2026-10-22T12:00:00Z" },
        { id: "incident-" + "f".repeat(32), title: "", createdAt: "2026-10-22T12:00:00Z" },
        { id: "incident-" + "f".repeat(32), title: "Report", createdAt: "invalid" },
      ]) {
        await page.route("**/api/customers/customer-a/diagnostics/reviews", (route) => route.fulfill({
          status: 200, contentType: "application/json",
          body: JSON.stringify({ candidates: [{ ...changed, summary: badSummary }] }),
        }));
        await connect(reviewer);
        await page.getByRole("alert").filter({ hasText: "Invalid pending report response" }).waitFor();
        assert.equal(await page.getByRole("button", { name: `Inspect ${changed.id}`, exact: true }).count(), 0);
        await page.unroute("**/api/customers/customer-a/diagnostics/reviews");
      }
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
      await connect(reviewer);
      await page.getByRole("button", { name: `Inspect ${changed.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).fill("Discard on browser reload");
      const acceptedReload = page.waitForEvent("dialog").then(async (dialog) => {
        assert.equal(dialog.type(), "beforeunload");
        await dialog.accept();
      });
      await page.reload();
      await acceptedReload;
      assert.equal(await page.getByLabel("Review reason", { exact: true }).count(), 0);
      assert.equal(await unloadIsBlocked(), false);
      assert.ok(store.pending("customer-a").some((candidate) => candidate.id === changed.id));
      await page.evaluate(async (accessToken) => {
        const path = "/engineering/review.js";
        const module = await import(path);
        await module.connectReviewWorkspace(accessToken);
      }, reviewer);
      await page.getByRole("button", { name: `Inspect ${changed.id}`, exact: true }).click();
      await page.getByLabel("Review reason", { exact: true }).fill("Discard on disconnect");
      assert.equal(await unloadIsBlocked(), true);
      await page.evaluate(async (accessToken) => {
        const path = "/engineering/review.js";
        const module = await import(path);
        const disconnect = await module.connectReviewWorkspace(accessToken);
        disconnect();
      }, reviewer);
      assert.equal(await unloadIsBlocked(), false);
      assert.equal(await page.getByText("Review connection closed.", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button").count(), 0);
      assert.equal(await page.getByLabel("Find evidence text", { exact: true }).count(), 0);
      assert.equal(await page.getByLabel("Filter pending reports", { exact: true }).count(), 0);
      assert.equal(await pendingOrder.count(), 0);
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
      const searches = await page.evaluate(async () => {
        const path = "/engineering/review-preview.js";
        const { createReviewPreview } = await import(path);
        const cases = [
          { html: "<p>Literal .+? [42] matches</p>", query: ".+? [42]" },
          { html: "<p>Case INVITE invite</p>", query: "InViTe" },
          { html: "<p>\u0130 I \u0131 i</p>", query: "i" },
          { html: "<p>never split <b>across</b> nodes</p>", query: "split across" },
          { html: "<p>&lt;script&gt; &amp; &lt;img&gt;</p>", query: "<script>" },
          { html: "<p>" + "a".repeat(1000) + "</p>", query: "a" },
          { html: "<p>" + "a".repeat(1001) + "</p>", query: "a" },
        ];
        return cases.map(({ html, query }) => {
          const preview = createReviewPreview(html);
          const input = preview.search.querySelector("input");
          const button = preview.search.querySelector("button");
          if (!input || !button) throw new Error("Missing preview search controls");
          input.value = query;
          button.click();
          const parsed = document.createElement("template");
          parsed.innerHTML = preview.frame.srcdoc;
          return {
            matches: Array.from(parsed.content.querySelectorAll("mark"), (mark) => mark.textContent),
            text: parsed.content.textContent,
            status: preview.search.querySelector('[role="status"]')?.textContent,
            active: parsed.content.querySelectorAll("script, img, a, iframe, form").length,
          };
        });
      });
      assert.deepEqual(searches[0].matches, [".+? [42]"]);
      assert.deepEqual(searches[1].matches, ["INVITE", "invite"]);
      assert.deepEqual(searches[2].matches, ["I", "i"]);
      assert.ok(searches[2].text?.endsWith("\u0130 I \u0131 i"));
      assert.deepEqual(searches[3].matches, []);
      assert.deepEqual(searches[4].matches, ["<script>"]);
      assert.equal(searches[5].matches.length, 1000);
      assert.match(searches[5].status ?? "", /^1000 match/);
      assert.equal(searches[6].matches.length, 1000);
      assert.match(searches[6].status ?? "", /first 1,000 matches/);
      assert.ok(searches[6].text?.endsWith("a".repeat(1001)), "Highlight limits must never omit evidence text");
      assert.ok(searches.every((search) => search.active === 0));
    } finally { await context.close(); }
  } finally {
    if (browser) await browser.close();
    if (api) await close(api);
    await close(issuer);
    store.close();
    await rm(directory, { recursive: true });
  }
});
