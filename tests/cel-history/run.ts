import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { openCelHistory, type CelEvent } from "../../src/cel-history.ts";
import type { QueueEvent } from "../../src/queue-history.ts";
import { proveHistoryMarkers } from "./markers.ts";
import { proveHistoryProjection } from "./projection.ts";
import { proveQueueRecovery } from "./queue-recovery.ts";
import { proveQueueService } from "./queue-service.ts";
import { proveQueueAbandonment } from "./queue-abandonment.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && !["--recovery", "--queue", "--markers", "--projection", "--queue-recovery", "--service", "--caller-service", "--abandonment"].includes(args[0]))) {
  throw new Error("Only --recovery, --queue, --markers, --projection, --queue-recovery, --service, --caller-service or --abandonment is supported");
}
const recovery = args[0] === "--recovery";
const queueProof = args[0] === "--queue";
const queueRecovery = args[0] === "--queue-recovery";
const abandonmentProof = args[0] === "--abandonment";
const callerServiceProof = args[0] === "--caller-service" || abandonmentProof;
const serviceProof = args[0] === "--service" || callerServiceProof;
const projectionProof = args[0] === "--projection" || queueRecovery || serviceProof;
const markerProof = args[0] === "--markers" || projectionProof;
const mode = recovery ? "cel-collector" : abandonmentProof ? "queue-abandonment" : callerServiceProof ? "caller-queue-service" : serviceProof ? "queue-service" : queueRecovery ? "queue-collector" : queueProof ? "queue-history" :
  projectionProof ? "history-projection" : markerProof ? "history-markers" : "cel-history";
const parent = join(root, ".local-proof", mode);
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const project = `asterisk-${recovery ? "collector" : queueProof ? "queue" : "history"}-${basename(directory).slice(4).toLowerCase()}`;
const database = join(directory, "history.sqlite");
const compose = ["compose", "--project-name", project,
  "-f", join(root, "compose.yaml"), "-f", join(root, "compose.sip-proof.yaml"),
  "-f", join(root, "compose.cel-history-proof.yaml")];
if (markerProof) compose.push("-f", join(root, "compose.history-markers-proof.yaml"));
if (serviceProof) compose.push("-f", join(root, "compose.history-service-proof.yaml"));
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
async function freshSnapshot(customer: string, kind: "cel" | "queue" = "cel") {
  const path = kind === "queue" ? "/var/log/asterisk/queue_log" : "/var/log/asterisk/cel-custom/Master.csv";
  const encoded = await docker(["exec", "-T", customer, "python3", "-B", "-c",
    `import base64; from pathlib import Path; print(base64.b64encode(Path('${path}').read_bytes()).decode())`]);
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
    abandonmentProof ? "isolated pre-connection caller hangup ABANDON record and conservative projection; no human intent, business outcome or media claim" :
    callerServiceProof ? "isolated caller-ended and member-ended automated queue service evidence; no human, abandonment, whole-journey or media claim" :
    serviceProof ? "isolated automated queue member CONNECT/completion and exact CEL member answer observations; no human or media claim" :
    queueRecovery ? "operator local-file queue interruption/replay, independent collector status and permanent unknown replacement gap in projection provenance" :
    queueProof ? "operator queue evidence with isolated empty Local-channel timeout and PBX restart; not human service or journey reconstruction" :
    projectionProof ? "conservative operator marked-caller/visit projection revisions; isolated synthetic entry and queue timeout only; no totals, service or transfer classification" :
    markerProof ? "operator runtime/epoch manifest assertions and isolated synthetic entry/queue-visit observations; not journey reconstruction or production trust attestation" :
      "operator-only CEL evidence; no business journey/outcome reconstruction",
  asteriskImage: "andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d" };
try {
  if (markerProof) {
    const [extensions, markers, modules, cel] = await Promise.all([
      readFile(join(root, "local", "asterisk", "extensions.conf"), "utf8"),
      readFile(join(root, "tests", "history-markers", "extensions.conf"), "utf8"),
      readFile(join(root, "local", "asterisk", "modules.conf"), "utf8"),
      readFile(join(root, "local", "asterisk", "cel.conf"), "utf8"),
    ]);
    await writeFile(join(directory, "extensions.conf"), `${extensions}\n${markers}`.replaceAll("\r\n", "\n"));
    await writeFile(join(directory, "modules.conf"), `${modules}\nload = func_uuid.so\n`.replaceAll("\r\n", "\n"));
    await writeFile(join(directory, "cel.conf"), cel.replace("apps = all", "apps = Queue").replaceAll("\r\n", "\n"));
    if (serviceProof) {
      const [service, queues] = await Promise.all([
        readFile(join(root, "tests", "history-markers", "service.conf"), "utf8"),
        readFile(join(root, "local", "asterisk", "queues.conf"), "utf8"),
      ]);
      await writeFile(join(directory, "extensions.conf"), `${extensions}\n${markers}\n${service}`.replaceAll("\r\n", "\n"));
      await writeFile(join(directory, "queues.conf"), `${queues}\n[service-queue]\nstrategy = ringall\ntimeout = 3\nretry = 1\njoinempty = yes\nleavewhenempty = no\nmember => Local/answer@history-service-member/n,0,synthetic-member\n`.replaceAll("\r\n", "\n"));
      if (callerServiceProof) {
        const callerService = await readFile(join(root, "tests", "history-markers", "caller-service.conf"), "utf8");
        await writeFile(join(directory, "extensions.conf"), `${extensions}\n${markers}\n${service}\n${callerService}`.replaceAll("\r\n", "\n"));
        const generatedQueues = await readFile(join(directory, "queues.conf"), "utf8");
        await writeFile(join(directory, "queues.conf"), `${generatedQueues}\n[caller-service-queue]\nstrategy = ringall\ntimeout = 3\nretry = 1\njoinempty = yes\nleavewhenempty = no\nmember => Local/answer@history-caller-service-member/n,0,synthetic-caller-member\n`);
        if (abandonmentProof) {
          const abandon = await readFile(join(root, "tests", "history-markers", "abandon.conf"), "utf8");
          await writeFile(join(directory, "extensions.conf"), `${extensions}\n${markers}\n${service}\n${callerService}\n${abandon}`.replaceAll("\r\n", "\n"));
          const callerQueues = await readFile(join(directory, "queues.conf"), "utf8");
          await writeFile(join(directory, "queues.conf"), `${callerQueues}\n[abandon-queue]\nstrategy = ringall\ntimeout = 2\njoinempty = yes\nleavewhenempty = no\n`);
        }
      }
    }
  }
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
  if (markerProof) {
    const markers: Record<string, unknown>[] = [];
    report.markers = markers;
    await proveHistoryMarkers(database, directory, project, docker, freshSnapshot, cli, markers);
    if (projectionProof) {
      const projections: Record<string, unknown>[] = [];
      report.projections = projections;
      await proveHistoryProjection(database, join(directory, "projections.sqlite"), project, cli, projections);
      if (serviceProof) {
        const services: Record<string, unknown>[] = [];
        report.service = services;
        await proveQueueService(database, directory, project, docker, freshSnapshot, cli, services);
        if (callerServiceProof) {
          const callerServices: Record<string, unknown>[] = [];
          report.callerService = callerServices;
          await proveQueueService(database, directory, project, docker, freshSnapshot, cli, callerServices, "caller");
          if (abandonmentProof) {
            const abandonment: Record<string, unknown>[] = [];
            report.abandonment = abandonment;
            await proveQueueAbandonment(database, directory, project, docker, freshSnapshot, cli, abandonment);
          }
        }
      }
      if (queueRecovery) {
        const recovered: Record<string, unknown>[] = [];
        report.queueRecovery = recovered;
        await proveQueueRecovery(database, directory, project, docker, freshSnapshot, cli, recovered);
      }
    }
  }
  if (queueProof) {
    const queueEvidence: Record<string, unknown>[] = [];
    report.queue = queueEvidence;
    for (const customer of customers) {
      await docker(["exec", "-T", customer, "asterisk", "-rx",
        "channel originate Local/queue@proof/n application Wait 4"]);
    }
    for (const customer of customers) {
      const deadline = performance.now() + 20000;
      while (!/^0 active channels/m.test(await docker(["exec", "-T", customer, "asterisk", "-rx", "core show channels count"]))) {
        if (performance.now() >= deadline) throw new Error("Queue fixture did not finish");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }
    const snapshots: { customer: string; snapshot: Buffer; events: QueueEvent[] }[] = [];
    for (const customer of customers) {
      const source = `pbx-${customer}`;
      const snapshot = await freshSnapshot(customer, "queue");
      const input = join(directory, customer, "queue_log");
      await writeFile(input, snapshot);
      // Queue and CEL deliberately share source/generation strings; kinds remain independent.
      const args = ["import", database, customer, source, project, input];
      const imported = JSON.parse(await cli(args, "Manage-QueueHistory.ts"));
      const replay = JSON.parse(await cli(args, "Manage-QueueHistory.ts"));
      assert.equal(imported.kind, "queue");
      assert.equal(imported.pendingBytes, 0);
      assert.equal(replay.inserted, 0);
      const cel = await freshSnapshot(customer);
      const writer = openCelHistory(database);
      try { writer.ingest({ customer, source, generation: project, timeBasis: "UTC" }, cel); }
      finally { writer.close(); }
      const store = openCelHistory(database, { readOnly: true });
      try {
        const query = { customer, source, generation: project };
        const events: QueueEvent[] = [];
        let afterOffset = -1;
        do {
          const page = store.queue.read({ ...query, afterOffset, limit: 1 });
          events.push(...page.events);
          if (page.nextAfterOffset === null) break;
          afterOffset = page.nextAfterOffset;
        } while (true);
        assert.deepEqual(Buffer.from(events.map((event) => event.rawRecord).join("")), snapshot);
        assert.equal(events.length, imported.records);
        const entries = events.filter((event) => event.event === "ENTERQUEUE");
        assert.equal(entries.length, 1);
        const callId = entries[0].callId;
        assert.equal(entries[0].queue, "proof-queue");
        const call = store.queue.read({ ...query, callId });
        assert.deepEqual(call.events.map((event) => event.event), ["ENTERQUEUE", "EXITWITHTIMEOUT"]);
        const lifecycle = store.read({ ...query, uniqueid: callId }).events;
        for (const name of ["CHAN_START", "ANSWER", "HANGUP", "CHAN_END"]) {
          assert.equal(lifecycle.filter((event) => event.event === name).length, 1);
        }
        assert.throws(() => store.queue.read({ ...query,
          customer: customer === "customer-a" ? "customer-b" : "customer-a" }), /not found/);
        snapshots.push({ customer, snapshot, events });
        queueEvidence.push({ customer, source, generation: project, bytes: snapshot.length,
          imported: imported.inserted, replayInserted: replay.inserted, exactRawRoundTrip: true,
          readPageLimit: 1, callId, callEvents: call.events.map((event) => event.event),
          celEvents: lifecycle.map((event) => event.event), prefixSha256: imported.prefixSha256,
          crossCustomerReadDenied: true });
      } finally { store.close(); }
    }
    await docker(["restart", ...customers], 45000);
    await docker(["up", "-d", "--pull", "never", "--no-build", "--wait", "--wait-timeout", "90", ...customers], 120000);
    for (const { customer, snapshot, events } of snapshots) {
      const source = `pbx-${customer}`;
      const restarted = await freshSnapshot(customer, "queue");
      assert.deepEqual(restarted.subarray(0, snapshot.length), snapshot);
      const input = join(directory, customer, "queue_log");
      await writeFile(input, restarted);
      const args = ["import", database, customer, source, project, input];
      const appended = JSON.parse(await cli(args, "Manage-QueueHistory.ts"));
      const replay = JSON.parse(await cli(args, "Manage-QueueHistory.ts"));
      assert.equal(appended.pendingBytes, 0);
      assert.equal(replay.inserted, 0);
      const store = openCelHistory(database, { readOnly: true });
      try {
        const all = store.queue.read({ customer, source, generation: project });
        assert.equal(all.nextAfterOffset, null);
        assert.deepEqual(all.events.slice(0, events.length), events);
        assert.deepEqual(Buffer.from(all.events.map((event) => event.rawRecord).join("")), restarted);
        const entry = queueEvidence.find((entry) => entry.customer === customer)!;
        Object.assign(entry, { restartPrefixPreserved: true, restartInserted: appended.inserted,
          restartReplayInserted: replay.inserted, restartRecords: all.events.length, restartBytes: restarted.length });
      } finally { store.close(); }
      console.log(`PASS ${customer}: raw queue entry/timeout and CEL preserved; zero duplicate replay before/after PBX restart`);
    }
  }
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
    if (serviceProof) {
      for (const kind of ["container", "network", "volume"]) {
        await cleanup(async () => {
          const listed = await execute("docker", [kind, "ls", "--filter", `label=com.docker.compose.project=${project}`, "--format", "{{.ID}}"],
            { cwd: root, timeout: 15000 });
          assert.equal(listed.stdout.trim(), "", `Owned service ${kind} resources remain`);
        });
      }
    }
  }
  for (const customer of customers) {
    await cleanup(() => rm(join(directory, customer), { recursive: true, force: true }));
  }
  if (markerProof) {
    for (const file of ["extensions.conf", "modules.conf", "cel.conf"]) {
      await cleanup(() => rm(join(directory, file), { force: true }));
    }
    if (serviceProof) await cleanup(() => rm(join(directory, "queues.conf"), { force: true }));
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
console.log(`History proof result: ${join(directory, "result.json")}`);
if (failed) throw failed;
