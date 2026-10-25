import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Route } from "playwright";
import { openBookingSimulation, type SimulationCase } from "../src/booking-simulation.ts";

async function fixture(action: (context: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const context = await setup();
  try { await action(context); }
  finally { await context.close(); }
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "booking-browser-"));
  const store = openBookingSimulation(join(directory, "simulation.sqlite"));
  const owner = store.forOwner({ issuer: "https://synthetic.example", subject: "alice", customer: "customer-a" });
  const html = await readFile(new URL("../src/booking-workspace.html", import.meta.url));
  const script = await readFile(new URL("../src/booking-workspace.js", import.meta.url));
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", request.url === "/simulation/workspace.js" ? "text/javascript" : "text/html");
    response.end(request.url === "/simulation/workspace.js" ? script : html);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const requestId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const calls: { path: string; method: string; body?: Record<string, unknown> }[] = [];
  const unexpected: string[] = [];
  const errors: string[] = [];
  const controls: {
    failStatus?: number; losePath?: string; holdPath?: string;
    release?: () => void; entered?: () => void; malformed?: string;
    session?: "mismatch" | "unavailable" | "signed-out"; logoutFailure?: boolean;
  } = {};
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) => unexpected.push(socket.url()));
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (!/^\/(?:simulation\/(?:customer-a|workspace\.js)|auth\/(?:session|logout)|api\/customers\/customer-a\/booking-simulation\/(?:conversations(?:\/synthetic-[0-9a-f-]{36}\/drafts)?|operations\/[0-9a-f-]{36}(?:\/(?:edit|review|confirm|submit|reconcile|handover))?))$/.test(path)) {
      unexpected.push(request.url());
    }
  });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      value: () => { throw new Error("Simulation must not request microphone access"); },
    });
  });
  await page.clock.install();
  await page.route("**/auth/session", (route) => route.fulfill({
    status: controls.session === "unavailable" ? 503 : controls.session === "signed-out" ? 401 : 200,
    contentType: "application/json", body: JSON.stringify({
      customer: controls.session === "mismatch" ? "customer-b" : "customer-a",
      csrf: "a".repeat(43), expiresAt: new Date(Date.now() + 300000).toISOString(),
    }),
  }));
  await page.route("**/auth/logout", (route) => route.fulfill({ status: controls.logoutFailure ? 503 : 200, body: "{}" }));
  const fulfill = (route: Route, result: unknown, status = 200) => route.fulfill({
    status, contentType: "application/json", headers: { "X-Request-Id": requestId },
    body: JSON.stringify({ requestId, simulation: true, customer: "customer-a", result }),
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    assert.equal(request.headers()["x-csrf-token"], "a".repeat(43), "Reads and writes must bind the bootstrap session");
    assert.equal(request.headers().authorization, undefined);
    const path = new URL(request.url()).pathname.split("/booking-simulation/")[1];
    const method = request.method();
    const body = method === "POST" ? request.postDataJSON() : undefined;
    calls.push({ path, method, body });
    if (controls.failStatus) { await fulfill(route, {}, controls.failStatus); return; }
    let result: unknown;
    try {
      if (path === "conversations") result = method === "POST" ? owner.createConversation() : { conversations: owner.list() };
      else if (path.startsWith("conversations/")) result = owner.create(path.split("/")[1], body.details);
      else {
        const [, id, action] = path.split("/");
        if (!action) result = owner.read(id);
        else if (action === "edit") result = owner.edit(id, body.details, body.revision);
        else if (action === "review") result = owner.review(id, body.revision);
        else if (action === "confirm") result = owner.confirm(id, body.revision);
        else if (action === "submit") result = owner.submit(id, body.scenario as SimulationCase, body.revision);
        else if (action === "reconcile") result = owner.reconcile(id);
        else if (action === "handover") result = owner.handover(id, body.reason);
        else throw new Error("Unexpected mock API action");
      }
    } catch (error) {
      assert.ok(error instanceof Error);
      await fulfill(route, { code: error.message }, 409); return;
    }
    if (controls.losePath && path.endsWith(controls.losePath)) {
      controls.losePath = undefined;
      await route.abort("failed"); return;
    }
    if (controls.holdPath && path.endsWith(controls.holdPath)) {
      await new Promise<void>((resolve) => { controls.release = resolve; controls.entered?.(); });
    }
    if (controls.malformed) {
      const changed = controls.malformed === "customer" ? { simulation: true, customer: "customer-b", result } :
        controls.malformed === "state" ? { simulation: true, customer: "customer-a", result: { ...(typeof result === "object" ? result : {}), state: "allocated" } } :
          { simulation: true, customer: "customer-a", result: { conversations: [{ simulation: true,
            customer: "customer-a", conversation: "<img src=x onerror=alert(1)>", operations: [] }] } };
      await route.fulfill({ contentType: "application/json", headers: { "X-Request-Id": requestId }, body: JSON.stringify(changed) });
      return;
    }
    await fulfill(route, result);
  });
  const start = async () => {
    await page.goto(origin + "/simulation/customer-a");
    await page.locator("#selection").filter({ hasText: "Own exercises loaded" }).waitFor();
  };
  const draft = async () => {
    await page.getByRole("button", { name: "Start new synthetic exercise", exact: true }).click();
    await page.getByRole("button", { name: "Create synthetic draft", exact: true }).click();
    await page.locator("#operation").filter({ hasText: "State: collecting" }).waitFor();
  };
  const confirm = async () => {
    await page.getByRole("button", { name: "Review summary", exact: true }).click();
    await page.getByRole("button", { name: "Confirm displayed revision", exact: true }).click();
    await page.locator("#operation").filter({ hasText: /Confirmed revision: \d/ }).waitFor();
  };
  return { page, controls, calls, errors, unexpected, owner, start, draft, confirm, origin, requestId,
    async close() {
      controls.release?.();
      await browser.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      store.close(); await rm(directory, { recursive: true });
    },
  };
}

test("SW-04/05/06/08/11: keyboard workflow separates synthetic collection, revision confirmation, dispatch and handover", { timeout: 30000 }, async () => {
  await fixture(async (c) => {
    await c.start();
    assert.equal(await c.page.getByText("SIMULATION ONLY — no taxi will be booked.", { exact: true }).isVisible(), true);
    assert.equal(c.calls.length, 1);
    assert.equal(c.calls[0].method, "GET", "Landing may list, never create");
    assert.equal(await c.page.locator("input").count(), 0, "No real personal-data entry");
    await c.page.getByRole("button", { name: "Start new synthetic exercise", exact: true }).focus();
    await c.page.keyboard.press("Enter");
    await c.page.getByRole("button", { name: "Create synthetic draft", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "State: collecting" }).waitFor();
    assert.equal(await c.page.locator("#submit").isVisible(), false);
    await c.confirm();
    await c.page.getByLabel("Passengers", { exact: true }).selectOption("3");
    assert.equal(await c.page.locator("#submit").isDisabled(), true, "Unsaved edits must not submit old details");
    await c.page.getByRole("button", { name: "Save changes (clears confirmation)", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "Confirmed revision: none" }).waitFor();
    assert.equal(await c.page.locator("#submit").isVisible(), false);
    await c.confirm();
    await c.page.getByLabel("Test scenario", { exact: true }).selectOption("reject");
    await c.page.getByRole("button", { name: "Submit confirmed simulation", exact: true }).focus();
    await c.page.keyboard.press("Enter");
    await c.page.locator("#operation").filter({ hasText: "State: rejected" }).waitFor();
    assert.match(await c.page.locator("#operation").textContent() ?? "", /Reference: none/);
    await c.page.getByLabel("Handover reason", { exact: true }).selectOption("unsupported_request");
    await c.page.getByRole("button", { name: "Show simulated handover", exact: true }).click();
    await c.page.locator("#handover-context").filter({ hasText: "unsupported_request" }).waitFor();
    assert.match(await c.page.locator("#handover-context").textContent() ?? "", /State: rejected/);
    await c.page.getByRole("button", { name: "Create synthetic draft", exact: true }).click();
    await c.confirm();
    await c.page.getByLabel("Test scenario", { exact: true }).selectOption("accept");
    await c.page.getByRole("button", { name: "Submit confirmed simulation", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "State: accepted" }).waitFor();
    assert.match(await c.page.locator("#operation").textContent() ?? "", /Reference: SIM-/);
    assert.equal(c.owner.list()[0].operations.length, 2);
    const before = c.calls.length;
    await c.page.clock.fastForward(30000);
    assert.equal(c.calls.length, before, "No polling, background renew or reconciliation");
    assert.deepEqual(await c.page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    assert.deepEqual(c.errors, []); assert.deepEqual(c.unexpected, []);
  });
});

test("SW-06/07/08: lost submit reply keeps the known ID and explicit reconciliation recovers only one result", { timeout: 30000 }, async () => {
  await fixture(async (c) => {
    await c.start(); await c.draft(); await c.confirm();
    await c.page.getByLabel("Test scenario", { exact: true }).selectOption("lose-reply");
    c.controls.losePath = "/submit";
    await c.page.getByRole("button", { name: "Submit confirmed simulation", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "No outcome inferred" }).waitFor();
    assert.equal(await c.page.locator("#submit").isDisabled(), true);
    assert.equal(await c.page.locator("#new-conversation").isDisabled(), true);
    await c.page.getByRole("button", { name: "Read current operation", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "State: outcome unknown" }).waitFor();
    assert.equal(await c.page.locator("#create-draft").isVisible(), false);
    await c.page.getByLabel("Handover reason", { exact: true }).selectOption("caller_disconnected");
    await c.page.getByRole("button", { name: "Show simulated handover", exact: true }).click();
    await c.page.locator("#handover-context").filter({ hasText: "State: outcome unknown" }).waitFor();
    await c.page.getByRole("button", { name: "Reconcile existing operation", exact: true }).focus();
    await c.page.keyboard.press("Enter");
    await c.page.locator("#operation").filter({ hasText: "State: accepted" }).waitFor();
    assert.equal(c.calls.filter((call) => call.path.endsWith("/submit")).length, 1);
    assert.equal(c.owner.list()[0].operations.length, 1);
    await c.page.reload();
    await c.page.locator("#selection").filter({ hasText: "Own exercises loaded" }).waitFor();
    assert.equal(await c.page.locator("#operation").textContent(), "");
    await c.page.getByRole("button", { name: /^Resume .*accepted/ }).click();
    await c.page.locator("#operation").filter({ hasText: "State: accepted" }).waitFor();
    assert.equal(c.calls.filter((call) => call.method === "POST").length, 7);
    assert.deepEqual(c.errors, []); assert.deepEqual(c.unexpected, []);
  });
});

test("SW-07/11: lost creation replies recover through owner listing; unresolved outcomes never auto-retry", { timeout: 30000 }, async () => {
  await fixture(async (c) => {
    await c.start();
    c.controls.losePath = "conversations";
    await c.page.getByRole("button", { name: "Start new synthetic exercise", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "No outcome inferred" }).waitFor();
    assert.equal(await c.page.locator("#new-conversation").isDisabled(), true);
    await c.page.getByRole("button", { name: "Refresh own exercises", exact: true }).click();
    await c.page.getByRole("button", { name: "Resume empty exercise", exact: true }).click();
    c.controls.losePath = "/drafts";
    await c.page.getByRole("button", { name: "Create synthetic draft", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "No outcome inferred" }).waitFor();
    await c.page.getByRole("button", { name: "Refresh own exercises", exact: true }).click();
    await c.page.getByRole("button", { name: /^Resume .*collecting/ }).click();
    await c.confirm();
    await c.page.getByLabel("Test scenario", { exact: true }).selectOption("unresolved");
    await c.page.getByRole("button", { name: "Submit confirmed simulation", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "State: outcome unknown" }).waitFor();
    await c.page.getByRole("button", { name: "Reconcile existing operation", exact: true }).click();
    await c.page.locator("#result-status").filter({ hasText: "Simulation response received" }).waitFor();
    assert.match(await c.page.locator("#operation").textContent() ?? "", /State: outcome unknown/);
    assert.equal(c.owner.list().length, 1);
    assert.equal(c.owner.list()[0].operations.length, 1);
    assert.equal(c.calls.filter((call) => call.path.endsWith("/drafts")).length, 1);
    assert.equal(c.calls.filter((call) => call.path.endsWith("/submit")).length, 1);
    assert.deepEqual(c.errors, []); assert.deepEqual(c.unexpected, []);
  });
});

test("SW-09/10: logout clears details before a held response and failed logout never restores them", { timeout: 30000 }, async () => {
  await fixture(async (c) => {
    await c.start(); await c.draft(); await c.confirm();
    const entered = new Promise<void>((resolve) => { c.controls.entered = resolve; });
    c.controls.holdPath = "/submit";
    const pending = c.page.getByRole("button", { name: "Submit confirmed simulation", exact: true }).click();
    await entered; await pending;
    assert.equal(await c.page.locator("#submit").isDisabled(), true);
    c.controls.logoutFailure = true;
    await c.page.getByRole("button", { name: "Sign out", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "Sign out not confirmed" }).waitFor();
    c.controls.release?.();
    await c.page.waitForTimeout(30);
    assert.equal(await c.page.locator("#workspace").isHidden(), true);
    assert.equal(await c.page.locator("#operation").textContent(), "");
    assert.equal(await c.page.locator("#conversations").textContent(), "");
    assert.equal(await c.page.locator("#handover-context").textContent(), "");
    assert.equal(c.owner.list()[0].operations[0].state, "accepted", "Logout does not cancel a committed operation");
    assert.deepEqual(c.errors, []); assert.deepEqual(c.unexpected, []);
  });
});

test("SW-09/10/11: denial, expiry, conflicts, unavailable and malformed responses never imply readiness or success", { timeout: 30000 }, async () => {
  await fixture(async (c) => {
    for (const mode of ["signed-out", "mismatch", "unavailable"] as const) {
      c.controls.session = mode;
      await c.page.goto(c.origin + "/simulation/customer-a");
      await c.page.locator("#sign-in").waitFor();
      assert.equal(await c.page.locator("#workspace").isHidden(), true);
      assert.match(await c.page.locator("#sign-in").getAttribute("href") ?? "", /workspace=simulation$/);
    }
    c.controls.session = undefined;
    await c.start(); await c.draft();
    for (const status of [409, 503]) {
      c.controls.failStatus = status;
      await c.page.getByRole("button", { name: "Review summary", exact: true }).click();
      await c.page.getByRole("alert").filter({ hasText: status === 409 ? "State or revision conflict" : "Simulation unavailable" }).waitFor();
      assert.match(await c.page.getByRole("alert").textContent() ?? "", new RegExp(c.requestId));
      c.controls.failStatus = undefined;
      await c.page.getByRole("button", { name: "Read current operation", exact: true }).click();
      await c.page.locator("#result-status").filter({ hasText: "Simulation response received" }).waitFor();
    }
    c.controls.malformed = "state";
    await c.page.getByRole("button", { name: "Review summary", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "Invalid simulated operation response" }).waitFor();
    assert.equal(await c.page.locator("#review").isDisabled(), true);
    c.controls.malformed = undefined;
    await c.page.getByRole("button", { name: "Read current operation", exact: true }).click();
    await c.page.locator("#operation").filter({ hasText: "State: awaiting confirmation" }).waitFor();
    c.controls.failStatus = 403;
    await c.page.getByRole("button", { name: "Read current operation", exact: true }).click();
    await c.page.locator("#session-status").filter({ hasText: "Simulation access denied" }).waitFor();
    assert.equal(await c.page.locator("#operation").textContent(), "");
    assert.equal(await c.page.locator("#workspace").isHidden(), true);
    c.controls.failStatus = undefined;
    await c.start();
    c.controls.malformed = "list";
    await c.page.getByRole("button", { name: "Refresh own exercises", exact: true }).click();
    await c.page.getByRole("alert").filter({ hasText: "Invalid owned conversation" }).waitFor();
    assert.equal(await c.page.locator("#conversations img").count(), 0);
    c.controls.malformed = undefined;
    await c.page.getByRole("button", { name: "Refresh own exercises", exact: true }).click();
    await c.page.getByRole("button", { name: /^Resume .*awaiting confirmation/ }).click();
    await c.page.locator("#operation").filter({ hasText: "Synthetic Alice" }).waitFor();
    const entered = new Promise<void>((resolve) => { c.controls.entered = resolve; });
    c.controls.holdPath = c.owner.list()[0].operations[0].id;
    await c.page.getByRole("button", { name: "Read current operation", exact: true }).click();
    await entered;
    const count = c.calls.length;
    await c.page.clock.fastForward(301000);
    await c.page.locator("#session-status").filter({ hasText: "Session expired" }).waitFor();
    c.controls.release?.();
    await c.page.waitForTimeout(30);
    assert.equal(await c.page.locator("#operation").textContent(), "");
    assert.equal(c.calls.length, count);
    assert.deepEqual(c.errors, []); assert.deepEqual(c.unexpected, []);
  });
});
