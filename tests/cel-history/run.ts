import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openCelHistory, type CelEvent } from "../../src/cel-history.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--recovery")) throw new Error("Only --recovery is supported");
const recovery = args[0] === "--recovery";
const parent = join(root, ".local-proof", recovery ? "cel-collector" : "cel-history");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const project = `asterisk-${recovery ? "collector" : "history"}-${basename(directory).slice(4).toLowerCase()}`;
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
async function cli(args: string[], script = "Manage-CelHistory.ts") {
  const result = await execute(process.execPath, [join(root, "scripts", script), ...args],
    { cwd: root, timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
  return result.stdout.trim();
}
const collector = (args: string[]) => cli(args, "Manage-CelCollector.ts");
async function freshSnapshot(customer: string) {
  const encoded = await docker(["exec", "-T", customer, "python3", "-B", "-c",
    "import base64; from pathlib import Path; print(base64.b64encode(Path('/var/log/asterisk/cel-custom/Master.csv').read_bytes()).decode())"]);
  return Buffer.from(encoded, "base64");
}
async function calls() {
  // Wait for both bounded probes before cleanup, including when either fails.
  const results = await Promise.allSettled(["sip-test-a", "sip-test-b"].map((tester) =>
    docker(["run", "--rm", "--no-deps", "-T", tester], 30000)));
  for (const call of results) {
    if (call.status === "rejected") throw call.reason;
    assert.match(call.value, /PASS authenticated call, PCMU negotiation, and \d+\/100 distinct RTP frames echoed/);
    assert.match(call.value, /PASS other customer credentials rejected/);
  }
}
let failed: unknown;
let composeAttempted = false;
const evidence: Record<string, unknown>[] = [];
const report: Record<string, unknown> = { passed: false, project, customers: evidence,
  scope: recovery ? "operator local-file collector interruption/replay and explicit unknown-coverage replacement; synthetic CEL snapshots" :
    "operator-only CEL evidence; no business journey/outcome reconstruction",
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
  await calls();
  for (const customer of customers) {
    const snapshot = await freshSnapshot(customer);
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
  if (recovery) {
    const recoveryEvidence: Record<string, unknown>[] = [];
    report.recovery = recoveryEvidence;
    for (const customer of customers) {
      const source = `pbx-${customer}`;
      const input = join(directory, customer, "snapshot.csv");
      await collector(["configure", database, customer, source, project, "UTC", input, "1000"]);
      const initial = JSON.parse(await collector(["collect", database, customer, source]));
      assert.equal(initial.result.inserted, 0);
      assert.equal(initial.status.status, "healthy");
    }
    // Collection processes have exited; durable PBX CEL grows without ingestion.
    await calls();
    for (const customer of customers) {
      const source = `pbx-${customer}`;
      const input = join(directory, customer, "snapshot.csv");
      const before = JSON.parse(await collector(["status", database, customer, source]));
      assert.equal(before.status, "stale");
      assert.equal(before.checkpoint.records, 6);
      const snapshot = await freshSnapshot(customer);
      await writeFile(input, snapshot);
      const resumed = JSON.parse(await collector(["collect", database, customer, source]));
      assert.equal(resumed.result.inserted, 6);
      assert.equal(resumed.status.checkpoint.records, 12);
      assert.equal(resumed.status.status, "healthy");
      const replay = JSON.parse(await collector(["collect", database, customer, source]));
      assert.equal(replay.result.inserted, 0);
      const preserved = openCelHistory(database, { readOnly: true });
      let originalEvents: CelEvent[];
      try {
        originalEvents = preserved.read({ customer, source, generation: project }).events;
        assert.deepEqual(Buffer.from(originalEvents.map((event) => event.rawRecord).join("")), snapshot);
        const correlations = originalEvents.filter((event) => event.event === "PROOF_SIP_DIALOG");
        assert.equal(correlations.length, 2);
        assert.notEqual(correlations[0].uniqueid, correlations[1].uniqueid);
        for (const correlation of correlations) {
          const channel = preserved.read({ customer, source, generation: project, uniqueid: correlation.uniqueid });
          for (const event of ["CHAN_START", "ANSWER", "HANGUP", "CHAN_END"]) {
            assert.equal(channel.events.filter((item) => item.event === event).length, 1);
          }
        }
      } finally { preserved.close(); }
      await rename(input, input + ".saved");
      await assert.rejects(collector(["collect", database, customer, source]));
      const missing = JSON.parse(await collector(["status", database, customer, source]));
      assert.equal(missing.status, "unhealthy");
      assert.equal(missing.failure, "source-unavailable");
      const replacement = Buffer.from(snapshot.subarray(snapshot.indexOf(10) + 1));
      await writeFile(input, replacement);
      await assert.rejects(collector(["collect", database, customer, source]));
      const changed = JSON.parse(await collector(["status", database, customer, source]));
      assert.equal(changed.failure, "prefix-discontinuity");
      assert.equal(changed.checkpoint.records, 12);
      const generation = `${project}-replacement`;
      const transition = JSON.parse(await collector(["transition", database, customer, source, generation,
        "synthetic-proof-operator", "Synthetic source replacement; continuity cannot be established"]));
      const recovered = JSON.parse(await collector(["collect", database, customer, source]));
      assert.equal(recovered.status.status, "healthy");
      assert.equal(recovered.status.gapCount, 1);
      assert.equal(recovered.status.coverage, "unknown-gap-recorded");
      const gaps = JSON.parse(await collector(["gaps", database, customer, source, "0", "100"]));
      assert.equal(gaps.gaps.length, 1);
      assert.equal(gaps.gaps[0].id, transition.gapId);
      const verify = openCelHistory(database, { readOnly: true });
      try {
        assert.deepEqual(verify.read({ customer, source, generation: project }).events, originalEvents);
        assert.throws(() => verify.collectionGaps(customer === "customer-a" ? "customer-b" : "customer-a", source), /not found/);
      } finally { verify.close(); }
      recoveryEvidence.push({ customer, staleBeforeRestart: before.status,
        absentCollectorMs: before.ageMs, beforeRecords: 6, replayedRecords: resumed.result.inserted,
        afterRecords: 12, duplicateReplayInserted: replay.result.inserted, exactRawRoundTrip: true,
        missingSourceFailure: missing.failure, replacementFailure: changed.failure,
        replacementGeneration: generation, replacementRecords: recovered.result.inserted,
        gapId: transition.gapId, persistentCoverage: recovered.status.coverage,
        previousGenerationPreserved: true, foreignGapReadDenied: true });
      console.log(`PASS ${customer}: stale collector resumed 6 retained records exactly once; missing/replaced source failed; healthy recovery retained unknown gap`);
    }
  }
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
