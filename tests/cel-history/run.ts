import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openCelHistory, type CelEvent } from "../../src/cel-history.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = join(root, ".local-proof", "cel-history");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const project = `asterisk-history-${basename(directory).slice(4).toLowerCase()}`;
const database = join(directory, "history.sqlite");
const compose = ["compose", "--project-name", project,
  "-f", join(root, "compose.yaml"), "-f", join(root, "compose.sip-proof.yaml"),
  "-f", join(root, "compose.cel-history-proof.yaml")];
const execute = promisify(execFile);
const customers = ["customer-a", "customer-b"] as const;
async function docker(args: string[], timeout = 30000) {
  const result = await execute("docker", [...compose, ...args], {
    cwd: root, env: { ...process.env, CEL_HISTORY_PROOF_DIRECTORY: directory },
    timeout, maxBuffer: 12 * 1024 * 1024,
  });
  return result.stdout.trim();
}
async function cli(args: string[]) {
  const result = await execute(process.execPath, [join(root, "scripts", "Manage-CelHistory.ts"), ...args],
    { cwd: root, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
let failed: unknown;
let composeAttempted = false;
const evidence: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { passed: false, project, customers: evidence,
  scope: "operator-only CEL evidence; no business journey/outcome reconstruction",
  asteriskImage: "andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d" };
try {
  const template = await readFile(join(root, "local", "sip", "endpoint.conf.template"), "utf8");
  for (const customer of customers) {
    await mkdir(join(directory, customer));
    await writeFile(join(directory, customer, "pjsip.conf"),
      template.replace("@PASSWORD@", randomBytes(32).toString("hex")).replaceAll("\r\n", "\n"));
  }
  await docker(["config", "--quiet"]);
  composeAttempted = true;
  await docker(["up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "90", ...customers], 120000);
  for (const customer of customers) {
    assert.equal(await docker(["exec", "-T", customer, "python3", "-B", "-c",
      "import time; print(time.strftime('%z'))"]), "+0000", "Proof CEL time basis must be UTC");
  }
  // Wait for both bounded probes before cleanup, including when either fails.
  const calls = await Promise.allSettled(["sip-test-a", "sip-test-b"].map((tester) =>
    docker(["run", "--rm", "--no-deps", "-T", tester], 30000)));
  for (const call of calls) {
    if (call.status === "rejected") throw call.reason;
    assert.match(call.value, /PASS authenticated call, PCMU negotiation, and \d+\/100 distinct RTP frames echoed/);
    assert.match(call.value, /PASS other customer credentials rejected/);
  }
  for (const customer of customers) {
    const encoded = await docker(["exec", "-T", customer, "python3", "-B", "-c",
      "import base64; from pathlib import Path; print(base64.b64encode(Path('/var/log/asterisk/cel-custom/Master.csv').read_bytes()).decode())"]);
    const snapshot = Buffer.from(encoded, "base64");
    const input = join(directory, customer, "snapshot.csv");
    await writeFile(input, snapshot);
    const source = { customer, source: `pbx-${customer}`, generation: project, timeBasis: "UTC" };
    // Separate CLI processes prove persistence beyond an importer lifetime.
    const args = ["import", database, customer, source.source, source.generation, source.timeBasis, input];
    const imported = JSON.parse(await cli(args));
    const replay = JSON.parse(await cli(args));
    assert.ok(imported.inserted > 0 && imported.pendingBytes === 0);
    assert.equal(replay.inserted, 0);
    assert.equal(replay.records, imported.records);
    const store = openCelHistory(database, { readOnly: true });
    try {
      const events: CelEvent[] = [];
      let afterOffset = -1;
      do {
        const page = store.read({ ...source, afterOffset, limit: 2 });
        events.push(...page.events);
        if (page.nextAfterOffset === null) break;
        afterOffset = page.nextAfterOffset;
      } while (true);
      assert.equal(events.length, imported.records);
      assert.deepEqual(Buffer.from(events.map((event) => event.rawRecord).join("")), snapshot);
      const correlations = events.filter((event) => event.event === "PROOF_SIP_DIALOG");
      assert.equal(correlations.length, 1);
      const correlation = correlations[0];
      const extra: unknown = JSON.parse(correlation.extra);
      assert.ok(typeof extra === "object" && extra !== null && "extra" in extra &&
        typeof extra.extra === "string" && /^[0-9a-f]{32}$/.test(extra.extra));
      const channel = store.read({ ...source, uniqueid: correlation.uniqueid, limit: 200 });
      assert.equal(channel.nextAfterOffset, null);
      for (const name of ["CHAN_START", "ANSWER", "HANGUP", "CHAN_END"]) {
        assert.equal(channel.events.filter((event) => event.event === name).length, 1, name);
      }
      assert.throws(() => store.read({ ...source,
        customer: customer === "customer-a" ? "customer-b" : "customer-a" }), /not found/);
      evidence.push({ customer, source: source.source, generation: source.generation,
        bytes: snapshot.length, imported: imported.inserted, replayInserted: replay.inserted,
        prefixSha256: imported.prefixSha256, exactRawRoundTrip: true, readPageLimit: 2,
        callId: extra.extra, uniqueid: correlation.uniqueid, linkedid: correlation.linkedid,
        channelEvents: channel.events.map((event) => event.event), crossCustomerReadDenied: true });
      console.log(`PASS ${customer}: ${events.length} exact CEL records persisted, replay inserted zero, lifecycle and scope verified`);
    } finally { store.close(); }
  }
  const reopened = openCelHistory(database, { readOnly: true });
  try {
    for (const customer of customers) {
      const sources = reopened.sources(customer);
      assert.equal(sources.sources.length, 1);
      assert.equal(sources.sources[0].source, `pbx-${customer}`);
    }
  } finally { reopened.close(); }
  report.passed = true;
} catch (error) {
  failed = error;
  report.error = error instanceof Error ? error.message : "Unknown CEL history proof failure";
} finally {
  const errors: unknown[] = [];
  async function cleanup(action: () => Promise<unknown>) {
    try { await action(); } catch (error) { errors.push(error); }
  }
  if (composeAttempted) {
    await cleanup(() => docker(["down", "--volumes", "--remove-orphans", "--timeout", "5"], 45000));
  }
  for (const customer of customers) {
    await cleanup(() => rm(join(directory, customer), { recursive: true, force: true }));
  }
  if (errors.length > 0) {
    report.passed = false;
    report.cleanup = { failed: true, errors: errors.map((error) => error instanceof Error ? error.message : "Unknown cleanup failure") };
    failed = new AggregateError(failed ? [failed, ...errors] : errors, "CEL proof/cleanup failed");
  } else {
    report.cleanup = "owned Compose containers/networks/volumes and generated credentials removed; synthetic history database retained";
  }
  await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2) + "\n");
}
console.log(`CEL history proof result: ${join(directory, "result.json")}`);
if (failed) throw failed;
