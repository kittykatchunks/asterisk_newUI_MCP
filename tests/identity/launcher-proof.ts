import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { localEngineeringRoot, startLocalEngineering } from "../../src/local-engineering.ts";

const directory = await mkdtemp(join(tmpdir(), "asterisk-launcher-"));
const identityDirectory = join(directory, ".local-proof", "identity");
await mkdir(identityDirectory, { recursive: true });
for (const file of ["accounts.json", "application-client.json"]) {
  await copyFile(join(localEngineeringRoot, ".local-proof", "identity", file), join(identityDirectory, file));
}
const accounts: { username: string; password: string; subject: string }[] =
  JSON.parse(await readFile(join(identityDirectory, "accounts.json"), "utf8"));
const alice = accounts.find((account) => account.username === "alice");
assert.ok(alice);
const incident = "incident-" + "f".repeat(32);
const html = "<!doctype html><h1>Synthetic launcher test report</h1>";
for (const customer of ["customer-a", "customer-b"]) {
  const evidence = join(directory, ".local-proof", "evidence", incident, customer);
  await mkdir(evidence, { recursive: true });
  await writeFile(join(evidence, "report.html"), html);
  await writeFile(join(evidence, "export-manifest.json"), JSON.stringify({
    customer, incident, started_utc: "2026-10-22T12:00:00Z",
    report_sha256: createHash("sha256").update(html).digest("hex"),
  }));
}
let app: Awaited<ReturnType<typeof startLocalEngineering>> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  app = await startLocalEngineering(directory, true);
  assert.equal(app.staged, 2);
  assert.equal((await fetch(app.origin + "/auth/session")).status, 401);
  await assert.rejects(startLocalEngineering(directory), (error: unknown) =>
    error instanceof Error && "code" in error && error.code === "EADDRINUSE");
  assert.equal((await fetch(app.origin + "/engineering/reviews/customer-a")).status, 200);
  const accountBytes = await readFile(join(localEngineeringRoot, ".local-proof", "identity", "accounts.json"), "utf8");
  const competing = spawn("pwsh", ["-NoProfile", "-File",
    join(localEngineeringRoot, "scripts", "Start-LocalEngineering.ps1")], {
    cwd: localEngineeringRoot, stdio: ["ignore", "pipe", "pipe"],
  });
  let competingOutput = "";
  competing.stdout.on("data", (chunk: Buffer) => { competingOutput += chunk.toString(); });
  competing.stderr.on("data", (chunk: Buffer) => { competingOutput += chunk.toString(); });
  const competingExit = await new Promise<number | null>((resolve, reject) => {
    competing.once("error", reject);
    competing.once("exit", resolve);
  });
  assert.notEqual(competingExit, 0, "A second launcher must not replace the running identity fixture");
  assert.match(competingOutput, /fixture\.lock|another process/i);
  assert.equal(await readFile(join(localEngineeringRoot, ".local-proof", "identity", "accounts.json"), "utf8"), accountBytes);
  assert.equal((await fetch(app.origin + "/engineering/reviews/customer-a")).status, 200);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  let oldCookie = "";
  try {
    const page = await context.newPage();
    await page.goto(app.origin + "/engineering/reviews/customer-a");
    await page.getByRole("link", { name: "Sign in", exact: true }).click();
    await page.locator("#username").fill(alice.username);
    await page.locator("#password").fill(alice.password);
    await page.locator("#kc-login").click();
    await page.getByRole("button", { name: /^Inspect / }).click();
    await page.getByRole("region", { name: "Candidate review", exact: true }).getByRole("heading", { name: "Synthetic SIP evidence", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Inert report preview").textContent(), html);
    await page.getByLabel("Review reason", { exact: true }).fill("Launcher restart persistence fixture review");
    await page.getByLabel("I checked customer scope, redaction and disclosure suitability.").check();
    await page.getByRole("button", { name: "Approve report", exact: true }).click();
    await page.getByRole("button", { name: "Confirm approval", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Review recorded: approve." }).waitFor();
    const cookie = (await context.cookies(app.origin)).find((cookie) => cookie.name === "asterisk-test-session");
    assert.ok(cookie);
    oldCookie = `${cookie.name}=${cookie.value}`;
  } finally { await context.close(); }
  const databasePath = app.databasePath;
  await app.stop();
  await app.stop();
  app = undefined;
  const released = createServer();
  released.listen(18766, "127.0.0.1");
  await once(released, "listening");
  await new Promise<void>((resolve, reject) => released.close((error) => error ? reject(error) : resolve()));
  app = await startLocalEngineering(directory, true);
  assert.equal(app.staged, 0, "Existing candidates must not be reimported or auto-approved on restart");
  assert.equal((await fetch(app.origin + "/auth/session", { headers: { Cookie: oldCookie } })).status, 401);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  try {
    assert.equal(reader.prepare("SELECT count(*) AS total FROM report_candidates").get()?.total, 2);
    assert.equal(reader.prepare("SELECT count(*) AS total FROM incidents").get()?.total, 1);
    assert.equal(reader.prepare("SELECT reviewer FROM incident_reviews").get()?.reviewer, alice.subject);
    assert.ok(Number(reader.prepare("SELECT count(*) AS total FROM access_audit").get()?.total) >= 4);
  } finally { reader.close(); }
  await app.stop();
  app = undefined;
  const reportPath = join(directory, ".local-proof", "evidence", incident, "customer-a", "report.html");
  await writeFile(reportPath, "tampered fixture");
  await assert.rejects(startLocalEngineering(directory, true), /integrity/);
  await writeFile(reportPath, html);
  const manifestPath = join(directory, ".local-proof", "evidence", incident, "customer-a", "export-manifest.json");
  const manifest = await readFile(manifestPath, "utf8");
  await writeFile(manifestPath, JSON.stringify({ ...JSON.parse(manifest), started_utc: "2026-10-22T13:00:00Z" }));
  await assert.rejects(startLocalEngineering(directory, true), /differs/);
  await writeFile(manifestPath, manifest);
  const child = spawn(process.execPath, [join(localEngineeringRoot, "scripts", "Start-LocalEngineering.ts")], {
    cwd: localEngineeringRoot, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Local CLI readiness timed out")), 15000);
      child.once("exit", () => { clearTimeout(timer); reject(new Error("Local CLI exited before readiness: " + stderr)); });
      child.stdout.setEncoding("utf8").on("data", (data: string) => {
        output += data;
        if (output.includes("Local engineering ready:")) { clearTimeout(timer); resolve(); }
      });
    });
    assert.equal((await fetch("http://127.0.0.1:18766/engineering/reviews/customer-a")).status, 200);
    child.stdin.write("stop\n");
    const timer = setTimeout(() => child.kill(), 10000);
    try { assert.equal(await exited, 0, output + stderr); }
    finally { clearTimeout(timer); }
    assert.match(output, /database preserved/);
    for (const account of accounts) assert.ok(!output.includes(account.password));
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  }
  console.log("PASS launcher: real login/review, restart persistence, idempotent staging, changed-evidence refusal, occupied-port denial and graceful CLI shutdown");
} finally {
  if (browser) await browser.close();
  if (app) await app.stop();
  await rm(directory, { recursive: true });
}
