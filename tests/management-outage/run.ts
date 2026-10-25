import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = join(root, ".local-proof", "management-outage");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const project = `asterisk-outage-${basename(directory).slice(4).toLowerCase()}`;
const compose = ["compose", "--project-name", project,
  "-f", join(root, "compose.yaml"), "-f", join(root, "compose.sip-proof.yaml"),
  "-f", join(root, "compose.management-outage-proof.yaml")];
const environment = { ...process.env, OUTAGE_PROOF_DIRECTORY: directory };
const execute = promisify(execFile);
const customers = ["customer-a", "customer-b"] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function docker(args: string[], timeout = 30000) {
  const result = await execute("docker", [...compose, ...args], {
    cwd: root, env: environment, timeout, maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}
function childResult(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
}
async function until(check: () => Promise<boolean>, milliseconds: number, description: string) {
  const deadline = performance.now() + milliseconds;
  do {
    if (await check()) return;
    if (performance.now() >= deadline) throw new Error(`Timed out: ${description}`);
    await sleep(100);
  } while (true);
}
async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface MediaResult {
  customer: string; callId: string; baselineEchoed: number; byeStatus: number;
  seconds: number; observedSeconds: number; maxReceiveGapSeconds: number;
  windows: { second: number; sent: number; echoed: number }[];
  newCall: { callId: string; sent: number; echoed: number; byeStatus: number };
}
function mediaResult(value: unknown, customer: string): asserts value is MediaResult {
  assert.ok(object(value) && value.customer === customer && typeof value.callId === "string" &&
    /^[0-9a-f]{32}$/.test(value.callId) && value.byeStatus === 200 &&
    typeof value.baselineEchoed === "number" && value.baselineEchoed >= 70 &&
    value.seconds === 60 && typeof value.observedSeconds === "number" && value.observedSeconds >= 60 &&
    typeof value.maxReceiveGapSeconds === "number" && value.maxReceiveGapSeconds <= 1 &&
    Array.isArray(value.windows) && value.windows.length === 60 && object(value.newCall),
  "Invalid media proof result");
  for (const [second, window] of value.windows.entries()) {
    assert.ok(object(window) && window.second === second &&
      typeof window.sent === "number" && Number.isInteger(window.sent) && window.sent >= 40 &&
      typeof window.echoed === "number" && Number.isInteger(window.echoed) &&
      window.echoed >= Math.ceil(window.sent * 0.7) && window.echoed <= window.sent,
    "RTP window threshold failed");
  }
  const fresh = value.newCall;
  assert.ok(typeof fresh.callId === "string" && /^[0-9a-f]{32}$/.test(fresh.callId) &&
    fresh.callId !== value.callId && fresh.sent === 100 && typeof fresh.echoed === "number" &&
    fresh.echoed >= 70 && fresh.echoed <= 100 && fresh.byeStatus === 200, "Invalid fresh outage call result");
}
const probes: { customer: string; output: string; exit: Promise<number | null>; child: ChildProcess }[] = [];
let management: ChildProcess | undefined;
let managementExit: Promise<number | null> | undefined;
let origin = "";
let managementPid: number | undefined;
let stoppedAt = 0;
let unavailableChecks = 0;
let result: Record<string, unknown> = { passed: false, project };
let failed: unknown;
let cleanupFailed: unknown;
let composeAttempted = false;
async function unavailable() {
  try {
    await fetch(origin + "/auth/session", { signal: AbortSignal.timeout(1500) });
    throw new Error("Management HTTP server responded during outage");
  } catch (error) {
    if (!(error instanceof TypeError) || !("cause" in error) || !object(error.cause) ||
        error.cause.code !== "ECONNREFUSED") throw error;
    unavailableChecks++;
  }
}
try {
  const template = await readFile(join(root, "local", "sip", "endpoint.conf.template"), "utf8");
  for (const customer of customers) {
    await mkdir(join(directory, customer));
    await writeFile(join(directory, customer, "pjsip.conf"),
      template.replace("@PASSWORD@", randomBytes(32).toString("hex")).replaceAll("\r\n", "\n"));
  }
  await docker(["config", "--quiet"]);
  composeAttempted = true;
  await docker(["up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "90",
    ...customers], 120000);
  management = spawn(process.execPath, [join(root, "tests", "management-outage", "management.ts"),
    join(directory, "diagnostics.sqlite")], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
  managementExit = childResult(management);
  void managementExit.catch(() => {});
  let startup = "";
  let managementErrors = "";
  management.stdout!.setEncoding("utf8").on("data", (chunk: string) => { startup += chunk; });
  management.stderr!.setEncoding("utf8").on("data", (chunk: string) => {
    managementErrors = (managementErrors + chunk).slice(-4000);
  });
  await until(async () => {
    if (management!.exitCode !== null || management!.signalCode !== null) {
      throw new Error(`Owned management process exited before readiness: ${managementErrors}`);
    }
    const line = startup.split(/\r?\n/).slice(0, -1).find((line) => line.startsWith("{"));
    if (!line) return false;
    const ready: unknown = JSON.parse(line);
    assert.ok(object(ready) && typeof ready.origin === "string" &&
      /^http:\/\/127\.0\.0\.1:\d+$/.test(ready.origin) && ready.pid === management!.pid);
    origin = ready.origin; managementPid = management!.pid;
    return true;
  }, 10000, "actual management HTTP readiness");
  const page = await fetch(origin + "/agent/customer-a");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Agent console/);
  assert.equal((await fetch(origin + "/auth/session")).status, 401);
  console.log(`PASS owned application readiness; PID ${managementPid}; isolated project ${project}`);
  for (const [customer, tester] of [["customer-a", "sip-test-a"], ["customer-b", "sip-test-b"]]) {
    const child = spawn("docker", [...compose, "run", "--rm", "--no-deps", "-T", tester], {
      cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"],
    });
    const probe = { customer, output: "", exit: childResult(child), child };
    void probe.exit.catch(() => {});
    for (const stream of [child.stdout!, child.stderr!]) {
      stream.setEncoding("utf8").on("data", (chunk: string) => { probe.output += chunk; });
    }
    probes.push(probe);
  }
  await until(async () => {
    for (const probe of probes) {
      if (probe.child.exitCode !== null || probe.child.signalCode !== null) {
        throw new Error(`Probe exited before outage: ${probe.output}`);
      }
    }
    for (const customer of customers) {
      try {
        const ready = await json(join(directory, customer, "ready.json"));
        assert.ok(object(ready) && typeof ready.callId === "string" &&
          typeof ready.baselineEchoed === "number" && ready.baselineEchoed >= 70);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      }
    }
    return true;
  }, 20000, "both established calls and pre-outage RTP baselines");
  management.stdin!.end("stop\n");
  await until(async () => management!.exitCode !== null || management!.signalCode !== null,
    10000, "owned management process exit");
  assert.equal(await managementExit, 0, "Management process did not stop cleanly");
  await unavailable();
  stoppedAt = performance.now();
  for (const customer of customers) {
    const temporary = join(directory, customer, "outage-start.tmp");
    await writeFile(temporary, JSON.stringify({ managementExited: true, pid: managementPid }));
    // The file appears atomically to the media observer.
    await rename(temporary, join(directory, customer, "outage-start.json"));
  }
  console.log("PASS management exited and HTTP refused; observing both original calls for 60 seconds");
  await until(async () => {
    await unavailable();
    for (const probe of probes) {
      if (probe.child.signalCode !== null || (probe.child.exitCode !== null && probe.child.exitCode !== 0)) {
        throw new Error(`Probe failed during outage: ${probe.output}`);
      }
    }
    return probes.every((probe) => probe.child.exitCode === 0);
  }, 75000, "60-second media windows and new calls during outage");
  const outageSeconds = (performance.now() - stoppedAt) / 1000;
  assert.ok(outageSeconds >= 60);
  const evidence: (MediaResult & { cel?: unknown })[] = [];
  result = { ...result, managementPid, managementExitCode: 0, outageSeconds, unavailableChecks, customers: evidence };
  for (const customer of customers) {
    const media = await json(join(directory, customer, "result.json"));
    mediaResult(media, customer);
    const entry: MediaResult & { cel?: unknown } = { ...media };
    evidence.push(entry);
  }
  for (const media of evidence) {
    const customer = media.customer;
    const correlation: unknown = JSON.parse(await docker(["exec", "-T", customer, "python3", "-B",
      "/tests/management-outage/correlate.py", media.callId, media.newCall.callId]));
    assert.ok(object(correlation) && Array.isArray(correlation.dialogs) && correlation.dialogs.length === 2);
    media.cel = correlation;
    console.log(`PASS ${customer}: 60 media windows; max gap ${media.maxReceiveGapSeconds.toFixed(3)}s; new call ${media.newCall.echoed}/100; fresh CEL lifecycles`);
  }
  await unavailable();
  result = { passed: true, project, managementPid, managementOrigin: origin,
    managementExitCode: 0, outageSeconds, unavailableChecks, customers: evidence,
    route: "authenticated synthetic UDP/PCMU echo; not queue/agent acceptance",
    asteriskImage: "andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d" };
} catch (error) {
  failed = error;
  result = { ...result, error: error instanceof Error ? error.message : "Unknown proof failure" };
} finally {
  const cleanupErrors: unknown[] = [];
  async function cleanup(action: () => Promise<unknown>) {
    try { await action(); } catch (error) { cleanupErrors.push(error); }
  }
  await cleanup(async () => {
    if (management && management.exitCode === null && management.signalCode === null) {
      management.kill();
      await managementExit;
    }
  });
  if (composeAttempted) {
    await cleanup(() => docker(["down", "--volumes", "--remove-orphans", "--timeout", "5"], 45000));
  }
  for (const probe of probes) {
    await cleanup(async () => {
      if (probe.child.exitCode === null && probe.child.signalCode === null) probe.child.kill();
      await probe.exit;
    });
  }
  for (const customer of customers) {
    await cleanup(() => rm(join(directory, customer), { recursive: true, force: true }));
  }
  await cleanup(() => rm(join(directory, "diagnostics.sqlite"), { force: true }));
  if (cleanupErrors.length > 0) {
    cleanupFailed = new AggregateError(cleanupErrors, "Owned outage proof cleanup failed");
    result.passed = false;
    result.cleanup = { failed: true, errors: cleanupErrors.map((error) =>
      error instanceof Error ? error.message : "Unknown cleanup failure") };
  } else {
    result.cleanup = "owned processes, Compose project/networks/volumes and generated credentials removed";
  }
  await writeFile(join(directory, "result.json"), JSON.stringify(result, null, 2) + "\n");
}
console.log(`Outage proof result: ${join(directory, "result.json")}`);
if (failed) throw failed;
if (cleanupFailed) throw cleanupFailed;
