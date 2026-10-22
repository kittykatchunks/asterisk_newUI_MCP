import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { chromium } from "playwright";

test("agent console renders literal profiles, clears stale data, guards session lifecycle and confirms logout", async () => {
  const html = await readFile(new URL("../src/agent-console.html", import.meta.url));
  const script = await readFile(new URL("../src/agent-console.js", import.meta.url));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/agent/console.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/agent/console.js" ? script : html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const context = await browser.newContext();
  let mode = "valid";
  let sessionMode = "valid";
  let failLogout = true;
  let profileReads = 0;
  let releaseProfile: (() => void) | undefined;
  const requestId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const errors: string[] = [];
  try {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/auth/session", async (route) => route.fulfill({ status: sessionMode === "unauthenticated" ? 401 : 200,
      contentType: "application/json", headers: { "X-Request-Id": requestId },
      body: JSON.stringify({ customer: sessionMode === "mismatch" ? "customer-b" : "customer-a",
        csrf: "a".repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString() }) }));
    await page.route("**/api/customers/customer-a/agent/profile", async (route) => {
      profileReads++;
      if (mode === "held-logout") await new Promise<void>((resolve) => { releaseProfile = resolve; });
      if (mode === "held") await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ status: mode === "failed" ? 503 : mode === "unauthorized" ? 401 : 200,
        contentType: "application/json", headers: { "X-Request-Id": requestId },
        body: JSON.stringify({ customer: mode === "mismatch" ? "customer-b" : "customer-a",
          agent: { extension: "1001", displayName: "<img src=x onerror=alert(1)>" } }) });
    });
    await page.route("**/auth/logout", async (route) => {
      assert.equal(route.request().method(), "POST");
      assert.equal(route.request().headers()["x-csrf-token"], "a".repeat(43));
      await route.fulfill({ status: failLogout ? 503 : 204, headers: { "X-Request-Id": requestId }, body: "" });
    });
    await page.goto(origin + "/agent/customer-a");
    await page.locator("#assignment-status").filter({ hasText: "Assignment loaded" }).waitFor();
    assert.ok((await page.locator("#assignment").textContent())?.includes("<img src=x onerror=alert(1)>"));
    assert.equal(await page.locator("img").count(), 0);
    mode = "held";
    await page.getByRole("button", { name: "Refresh assignment" }).click();
    assert.equal(await page.locator("#assignment").isHidden(), true);
    assert.equal(await page.getByRole("button", { name: "Refresh assignment" }).isDisabled(), true);
    await page.locator("#assignment-status").filter({ hasText: "Assignment loaded" }).waitFor();
    mode = "failed";
    await page.getByRole("button", { name: "Refresh assignment" }).click();
    await page.getByRole("alert").filter({ hasText: requestId }).waitFor();
    assert.equal(await page.locator("#assignment dd").count(), 0);
    const reads = profileReads;
    await page.waitForTimeout(100);
    assert.equal(profileReads, reads, "Failures must not cause automatic retries");
    mode = "mismatch";
    await page.getByRole("button", { name: "Refresh assignment" }).click();
    await page.getByRole("alert").filter({ hasText: "Invalid agent assignment response" }).waitFor();
    mode = "valid";
    await page.getByRole("button", { name: "Refresh assignment" }).click();
    await page.locator("#assignment-status").filter({ hasText: "Assignment loaded" }).waitFor();
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Sign out was not confirmed" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled(), true);
    failLogout = false;
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByText("Sign in to view your agent assignment.", { exact: true }).waitFor();
    assert.equal(await page.locator("#assignment dd").count(), 0);
    assert.ok((await page.getByRole("link", { name: "Sign in" }).getAttribute("href"))?.includes("workspace=agent"));
    sessionMode = "mismatch";
    const before = profileReads;
    await page.reload();
    await page.getByRole("alert").filter({ hasText: "mismatched application session" }).waitFor();
    assert.equal(profileReads, before);
    sessionMode = "valid";
    await page.clock.install();
    await page.reload();
    await page.locator("#assignment-status").filter({ hasText: "Assignment loaded" }).waitFor();
    await page.clock.fastForward(300001);
    await page.getByText("Session expired. Sign in again.", { exact: true }).waitFor();
    assert.equal(await page.locator("#assignment dd").count(), 0);
    await page.clock.resume();
    await page.clock.setSystemTime(new Date());
    mode = "unauthorized";
    await page.reload();
    await page.getByText("Application session is no longer valid. Sign in again.", { exact: true }).waitFor();
    assert.equal(await page.locator("#assignment dd").count(), 0);
    mode = "valid";
    await page.reload();
    await page.locator("#assignment-status").filter({ hasText: "Assignment loaded" }).waitFor();
    mode = "held-logout";
    const pending = page.waitForRequest("**/api/customers/customer-a/agent/profile");
    await page.getByRole("button", { name: "Refresh assignment" }).click();
    await pending;
    assert.equal(await page.getByRole("button", { name: "Sign out", exact: true }).isEnabled(), true);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByText("Sign in to view your agent assignment.", { exact: true }).waitFor();
    assert.ok(releaseProfile);
    releaseProfile();
    await page.waitForTimeout(200);
    assert.equal(await page.locator("#assignment dd").count(), 0, "Late profile response must not repopulate a signed-out console");
    assert.equal(await page.getByRole("button", { name: "Refresh assignment" }).isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await context.close(); await browser.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
