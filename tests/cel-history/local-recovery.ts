import assert from "node:assert/strict";
import { fork, execFile, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { openCelHistory } from "../../src/cel-history.ts";
import { buildHistoryProjection, type ProjectionScope } from "../../src/history-projection.ts";
import { openHistoryProjections } from "../../src/history-projection-store.ts";
import { createHistoryReader } from "../../src/history-reader.ts";
import { historySha256 } from "../../src/history-evidence.ts";
import type { RecoveryWorkerConfig } from "./recovery-worker.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 1 || !isAbsolute(args[0])) throw new Error("Provide one absolute retained synthetic evidence directory");
const canonical = resolve(args[0]);
const originalPaths = [join(canonical, "history.sqlite"), join(canonical, "projections.sqlite")];
const originalBytes = await Promise.all(originalPaths.map((path) => readFile(path)));
const parent = join(root, ".local-proof", "local-history-recovery");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const historyPath = join(directory, "history.sqlite"), projectionPath = join(directory, "projections.sqlite");
const execute = promisify(execFile);
const checks: { id: string; name: string; status: string; evidence: unknown }[] = [];
const processes = new Set<ChildProcess>();
let success = false;
let failure: string | undefined;
let cleanupVerified = false;
const fetchLocal = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
async function check(id: string, name: string, action: () => Promise<unknown>) {
  try {
    const evidence = await action();
    checks.push({ id, name, status: "passed", evidence }); console.log(`${id} PASS: ${name}`);
  } catch (error) {
    checks.push({ id, name, status: "failed", evidence: error instanceof Error ? error.message : "Unknown failure" });
    throw error;
  }
}
async function cli(script: string, values: string[]) {
  const result = await execute(process.execPath, [join(root, "scripts", script), ...values],
    { cwd: root, timeout: 20000, maxBuffer: 2 * 1024 * 1024 });
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(object(parsed)); return parsed;
}
const useHistory = <T>(action: (history: ReturnType<typeof openCelHistory>) => T) => {
  const history = openCelHistory(historyPath, { readOnly: true });
  try { return action(history); } finally { history.close(); }
};
const useProjection = <T>(action: (store: ReturnType<typeof openHistoryProjections>) => T) => {
  const projections = openHistoryProjections(projectionPath, { readOnly: true });
  try { return action(projections); } finally { projections.close(); }
};
interface Customer {
  customer: string; source: string; generation: string; scope: ProjectionScope;
  cel: Buffer; queue: Buffer;
  journeys: ReturnType<typeof buildHistoryProjection>["document"]["journeys"];
}
const customers: Customer[] = [];
const pathFor = (c: Customer, kind: "cel" | "queue") => join(directory, c.customer, kind === "cel" ? "cel.csv" : "queue_log");
const scriptFor = (kind: "cel" | "queue") => kind === "cel" ? "Manage-CelCollector.ts" : "Manage-QueueCollector.ts";
async function collect(c: Customer, kind: "cel" | "queue", inserted: number) {
  const result = await cli(scriptFor(kind), ["collect", historyPath, c.customer, c.source]);
  assert.ok(object(result.result)); assert.equal(result.result.inserted, inserted); return result;
}
async function rebuild(c: Customer) {
  return cli("Manage-HistoryProjection.ts", ["rebuild", historyPath, projectionPath, c.customer, c.scope.runtime, c.scope.epoch]);
}
const state = (c: Customer, kind: "cel" | "queue") => useHistory((h) =>
  kind === "cel" ? h.collectorStatus(c.customer, c.source) : h.queue.collectors.status(c.customer, c.source));
const built = (c: Customer) => useHistory((h) => buildHistoryProjection(h, c.scope));
function preserved(c: Customer) {
  const journeys = built(c).document.journeys;
  for (const original of c.journeys) assert.deepEqual(journeys.find((j) => j.id === original.id), original);
  assert.equal(new Set(journeys.map((j) => j.id)).size, journeys.length);
  assert.equal(new Set(journeys.flatMap((j) => j.visits.map((v) => v.id))).size, journeys.flatMap((j) => j.visits).length);
}
function workerConfig(c: Customer, kind: "cel" | "queue", mode: RecoveryWorkerConfig["mode"]): RecoveryWorkerConfig {
  return { mode, historyPath, projectionPath, customer: c.customer, source: c.source, kind, scope: c.scope };
}
async function worker(config: RecoveryWorkerConfig) {
  const child = fork(fileURLToPath(new URL("./recovery-worker.ts", import.meta.url)), [], {
    cwd: root, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  processes.add(child);
  let diagnostics = "";
  child.stderr?.on("data", (data: Buffer) => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
  const exited = new Promise<void>((resolve) => child.once("exit", () => { processes.delete(child); resolve(); }));
  const errors: unknown[] = [];
  child.on("message", (message: unknown) => {
    if (object(message) && message.type === "api-error") errors.push(message);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  };
  try {
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { clear(); reject(new Error("Owned recovery worker readiness timed out")); }, 15000);
      const clear = () => { clearTimeout(timer); child.off("message", message); child.off("error", error); child.off("exit", early); };
      const message = (value: unknown) => {
        if (object(value) && value.type === "ready") { clear(); resolve(); }
      };
      const error = (err: Error) => { clear(); reject(err); };
      const early = () => { clear(); reject(new Error(`Owned recovery worker exited early: ${diagnostics}`)); };
      child.on("message", message); child.once("error", error); child.once("exit", early);
    });
    child.send(config); await ready;
    assert.ok(child.pid && child.exitCode === null);
    return { stop, errors, pid: child.pid };
  } catch (error) { await stop(); throw error; }
}
function extraCel(id: string) {
  return Buffer.from(["CHAN_START", "2026-10-25 01:30:00", `Local/recovery-${id};2`, id, "reused-linked",
    "unmanaged-recovery", "entry", ""].map((s) => `"${s.replaceAll('"', '""')}"`).join(",") + "\n");
}
const extraQueue = (id: string) => Buffer.from(`1792890000|${id}|recovery-queue|NONE|RECOVERY_TEST|synthetic\n`);

try {
  await check("LR-01", "Owned copies preserve the four recorded scenarios for both customers", async () => {
    await copyFile(originalPaths[0], historyPath); await copyFile(originalPaths[1], projectionPath);
    assert.deepEqual(await readFile(historyPath), originalBytes[0]); assert.deepEqual(await readFile(projectionPath), originalBytes[1]);
    for (const customer of ["customer-a", "customer-b"]) {
      const scopes = useProjection((p) => p.scopes(customer));
      assert.equal(scopes.scopes.length, 1);
      const { runtime, epoch } = scopes.scopes[0], scope = { customer, runtime, epoch };
      const evidence = useHistory((h) => {
        const sources = h.sources(customer).sources; assert.equal(sources.length, 1);
        const { source, generation } = sources[0];
        const cel = h.read({ customer, source, generation, limit: 200 });
        const queue = h.queue.read({ customer, source, generation, limit: 200 });
        assert.equal(cel.nextAfterOffset, null); assert.equal(queue.nextAfterOffset, null);
        return { source, generation, cel: Buffer.from(cel.events.map((e) => e.rawRecord).join("")),
          queue: Buffer.from(queue.events.map((e) => e.rawRecord).join("")),
          projection: buildHistoryProjection(h, scope) };
      });
      assert.equal(evidence.projection.document.journeys.length, 4);
      assert.deepEqual(evidence.projection.document.journeys.map((j) => j.visits[0].state).sort(),
        ["abandonment-observed", "completion-observed", "completion-observed", "timeout-observed"]);
      assert.deepEqual(useProjection((p) => p.read(scope)).document, evidence.projection.document);
      customers.push({ customer, scope, source: evidence.source, generation: evidence.generation,
        cel: evidence.cel, queue: evidence.queue, journeys: evidence.projection.document.journeys });
      await mkdir(join(directory, customer));
      await writeFile(pathFor(customers.at(-1)!, "cel"), evidence.cel);
      await writeFile(pathFor(customers.at(-1)!, "queue"), evidence.queue);
    }
    return customers.map((c) => ({ customer: c.customer, scope: c.scope, roots: c.journeys.map((j) => j.id),
      celBytes: c.cel.length, queueBytes: c.queue.length }));
  });
  await check("LR-02", "Independent collector process replay inserts zero and retains original observations", async () => {
    for (const c of customers) {
      for (const kind of ["cel", "queue"] as const) {
        await cli(scriptFor(kind), ["configure", historyPath, c.customer, c.source, c.generation,
          ...(kind === "cel" ? ["UTC"] : []), pathFor(c, kind), "1000"]);
        await collect(c, kind, 0); await collect(c, kind, 0);
        assert.equal(state(c, kind).status, "healthy");
      }
      preserved(c); await rebuild(c);
      const before = useProjection((p) => p.read(c.scope));
      const again = await rebuild(c); assert.equal(again.reused, true); assert.equal(again.id, before.id);
    }
    return { processReplays: 8, originalRootsPerCustomer: 4, duplicateRoots: 0 };
  });
  await check("LR-03", "Killed collectors retain committed attempts; fresh processes recover without duplicates", async () => {
    for (const c of customers) for (const kind of ["cel", "queue"] as const) {
      const before = state(c, kind);
      const child = await worker(workerConfig(c, kind, "begin")); await child.stop();
      const interrupted = state(c, kind);
      assert.equal(interrupted.outcome, "collecting"); assert.deepEqual(interrupted.checkpoint, before.checkpoint);
      const stale = useHistory((h) => kind === "cel" ?
        h.collectorStatus(c.customer, c.source, interrupted.attemptedAt! + 1000) :
        h.queue.collectors.status(c.customer, c.source, interrupted.attemptedAt! + 1000));
      assert.equal(stale.status, "stale");
      await collect(c, kind, 0); assert.equal(state(c, kind).outcome, "success"); preserved(c);
    }
    return { killedOwnedProcesses: 4, staleCheck: "explicit attempt time + configured 1000ms threshold", duplicateRows: 0 };
  });
  await check("LR-04", "Partial tails survive collector restarts and complete exactly once", async () => {
    for (const c of customers) for (const kind of ["cel", "queue"] as const) {
      const raw = kind === "cel" ? c.cel : c.queue, tail = kind === "cel" ? extraCel("partial") : extraQueue("partial");
      const before = state(c, kind).checkpoint;
      await writeFile(pathFor(c, kind), Buffer.concat([raw, tail.subarray(0, tail.length - 1)]));
      await collect(c, kind, 0); assert.equal(state(c, kind).pendingBytes, tail.length - 1);
      assert.deepEqual(state(c, kind).checkpoint, before);
      await collect(c, kind, 0);
      const complete = Buffer.concat([raw, tail]); await writeFile(pathFor(c, kind), complete);
      await collect(c, kind, 1); await collect(c, kind, 0);
      assert.equal(state(c, kind).pendingBytes, 0); assert.equal(state(c, kind).checkpoint.records, before.records + 1);
      if (kind === "cel") c.cel = complete; else c.queue = complete;
      preserved(c);
    }
    return { partialStreams: 4, exactlyOnceCompletedRecords: 4, pbxEpochsAdded: 0 };
  });
  await check("LR-05", "Malformed late batches and changed prefixes fail without partial import or empty success", async () => {
    for (const c of customers) for (const kind of ["cel", "queue"] as const) {
      const raw = kind === "cel" ? c.cel : c.queue, before = state(c, kind).checkpoint;
      const valid = kind === "cel" ? extraCel("rolled-back") : extraQueue("rolled-back");
      await writeFile(pathFor(c, kind), Buffer.concat([raw, valid, Buffer.from("malformed\n")]));
      await assert.rejects(cli(scriptFor(kind), ["collect", historyPath, c.customer, c.source]));
      assert.deepEqual(state(c, kind).checkpoint, before); assert.equal(state(c, kind).outcome, "failure");
      await writeFile(pathFor(c, kind), raw.subarray(raw.indexOf(10) + 1));
      await assert.rejects(cli(scriptFor(kind), ["collect", historyPath, c.customer, c.source]));
      assert.equal(state(c, kind).failure, "prefix-discontinuity"); assert.deepEqual(state(c, kind).checkpoint, before);
      await writeFile(pathFor(c, kind), raw); await collect(c, kind, 0); preserved(c);
    }
    return { malformedBatchRollbacks: 4, changedPrefixDenials: 4, automaticGenerations: 0 };
  });
  await check("LR-06", "Process death after real raw INSERT rolls back importer transaction and checkpoint", async () => {
    for (const c of customers) for (const kind of ["cel", "queue"] as const) {
      const before = state(c, kind).checkpoint, raw = kind === "cel" ? c.cel : c.queue;
      const tail = kind === "cel" ? extraCel("crash") : extraQueue("crash");
      const complete = Buffer.concat([raw, tail]); await writeFile(pathFor(c, kind), complete);
      const child = await worker(workerConfig(c, kind, "collect-insert")); await child.stop();
      assert.deepEqual(state(c, kind).checkpoint, before); assert.equal(state(c, kind).outcome, "collecting");
      useHistory((h) => {
        const events = kind === "cel" ? h.read({ customer: c.customer, source: c.source, generation: c.generation, limit: 200 }) :
          h.queue.read({ customer: c.customer, source: c.source, generation: c.generation, limit: 200 });
        assert.deepEqual(Buffer.from(events.events.map((e) => e.rawRecord).join("")), raw);
      });
      await collect(c, kind, 1); await collect(c, kind, 0);
      assert.equal(state(c, kind).checkpoint.records, before.records + 1);
      if (kind === "cel") c.cel = complete; else c.queue = complete;
      preserved(c);
    }
    return { killedInsideActualImporterTransactions: 4, recoveredNewRecords: 4, duplicatedRows: 0 };
  });
  await check("LR-07", "Failed and killed actual projection publication preserves prior immutable revisions", async () => {
    for (const c of customers) {
      const before = useProjection((p) => p.read(c.scope));
      const db = new DatabaseSync(projectionPath);
      try { db.exec("CREATE TRIGGER recovery_failure BEFORE INSERT ON projection_revisions BEGIN SELECT RAISE(ABORT,'Synthetic recovery publication failure'); END;"); }
      finally { db.close(); }
      await assert.rejects(rebuild(c));
      const remove = new DatabaseSync(projectionPath);
      try { remove.exec("DROP TRIGGER recovery_failure"); } finally { remove.close(); }
      assert.deepEqual(useProjection((p) => p.read(c.scope)), before);
      const child = await worker(workerConfig(c, "cel", "publish-insert")); await child.stop();
      assert.deepEqual(useProjection((p) => p.read(c.scope)), before);
      const reader = createHistoryReader(historyPath, projectionPath);
      assert.equal(reader.read(c.scope, undefined, true).freshness.state, "inputs-changed");
      const after = await rebuild(c); assert.ok(typeof after.id === "number" && after.id > before.id);
      const replay = await rebuild(c); assert.equal(replay.reused, true); assert.equal(replay.id, after.id);
      assert.deepEqual(useProjection((p) => p.read(c.scope, before.id)), before); preserved(c);
    }
    return { failedPublications: 2, killedInsideActualPublicationTransactions: 2, historicalRevisionsUnchanged: true };
  });
  await check("LR-08", "Late independently delivered marked evidence requires exact manifests; original service facts survive", async () => {
    for (const c of customers) {
      const source = `late-${c.customer}`, generation = "stream-1";
      const journeyId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", visitId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const route = { context: "recovery-marker", extension: "entry", routeRevision: "recovery-v1", entryKind: "synthetic" as const };
      const payload = (event: string) => event === "HISTORY_ENTRY" ?
        { v: 1, journeyId, entryKind: "synthetic", routeRevision: "recovery-v1" } :
        { v: 1, journeyId, visitId, queue: "late-queue", routeRevision: "recovery-v1" };
      const cel = Buffer.from(["CHAN_START", "HISTORY_ENTRY", "ANSWER", "HISTORY_QUEUE_VISIT", "CHAN_END"].map((event) =>
        [event, "2026-10-25 01:30:00", "Local/reused;2", "reused-caller", "reused-linked", route.context, route.extension,
          event.startsWith("HISTORY_") ? JSON.stringify({ extra: JSON.stringify(payload(event)) }) : ""]
          .map((s) => `"${s.replaceAll('"', '""')}"`).join(",") + "\n").join(""));
      const entered = Buffer.from("1792890000|reused-caller|late-queue|NONE|ENTERQUEUE|||1\n");
      const abandoned = Buffer.from("1792890000|reused-caller|late-queue|NONE|ABANDON|1|1|3\n");
      const h = openCelHistory(historyPath);
      try {
        if (c.customer === "customer-b") h.queue.ingest({ customer: c.customer, source, generation }, entered);
        h.ingest({ customer: c.customer, source, generation, timeBasis: "UTC" }, cel);
        h.manifests.register({ ...c.scope, operator: "local-recovery", reason: "Late independent synthetic caller evidence",
          routes: [route], ranges: [{ kind: "cel", source, generation, start: 0, end: cel.length }] });
        if (c.customer === "customer-a") h.queue.ingest({ customer: c.customer, source, generation }, entered);
        let doc = buildHistoryProjection(h, c.scope).document;
        const root = doc.journeys.find((j) => j.journeyId === journeyId)!;
        assert.equal(root.visits[0].state, "unresolved"); assert.ok(doc.issues.some((i) => i.reason === "unassigned-evidence"));
        h.manifests.register({ ...c.scope, operator: "local-recovery", reason: "Exact delayed queue entry assignment", routes: [],
          ranges: [{ kind: "queue", source, generation, start: 0, end: entered.length }] });
        const partial = Buffer.concat([entered, abandoned.subarray(0, abandoned.length - 1)]);
        h.queue.ingest({ customer: c.customer, source, generation }, partial);
        assert.equal(buildHistoryProjection(h, c.scope).document.journeys.find((j) => j.id === root.id)!.visits[0].state, "entry-observed");
        h.queue.ingest({ customer: c.customer, source, generation }, Buffer.concat([entered, abandoned]));
        assert.notEqual(buildHistoryProjection(h, c.scope).document.journeys.find((j) => j.id === root.id)!.visits[0].abandonment, "observed");
        h.manifests.register({ ...c.scope, operator: "local-recovery", reason: "Exact delayed terminal assignment", routes: [],
          ranges: [{ kind: "queue", source, generation, start: entered.length, end: entered.length + abandoned.length }] });
        doc = buildHistoryProjection(h, c.scope).document;
        assert.equal(doc.journeys.find((j) => j.id === root.id)!.visits[0].abandonment, "observed");
        assert.equal(doc.journeys.length, 5);
      } finally { h.close(); }
      preserved(c); await rebuild(c);
    }
    const roots = customers.map((c) => built(c).document.journeys.find((j) => j.journeyId === "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")!.id);
    assert.notEqual(roots[0], roots[1]);
    return { deliveryOrders: ["CEL then queue", "queue then CEL"], stableOriginalRoots: 8, newSyntheticRoots: 2,
      sharedCallerAndMarkerIds: "customer-isolated", pbxEpochsAdded: 0 };
  });
  await check("LR-09", "Source outage and explicit generation recovery retain permanent gaps in the same PBX epoch", async () => {
    for (const c of customers) {
      const originalEpochs = useHistory((h) => h.manifests.list(c.customer).manifests.map((m) => m.epoch));
      for (const kind of ["cel", "queue"] as const) {
        const before = state(c, kind).checkpoint;
        await rm(pathFor(c, kind));
        await assert.rejects(cli(scriptFor(kind), ["collect", historyPath, c.customer, c.source]));
        assert.equal(state(c, kind).failure, "source-unavailable"); assert.deepEqual(state(c, kind).checkpoint, before);
        const replacement = kind === "cel" ? extraCel("replacement") : extraQueue("replacement");
        await writeFile(pathFor(c, kind), replacement);
        await assert.rejects(cli(scriptFor(kind), ["collect", historyPath, c.customer, c.source]));
        assert.equal(state(c, kind).failure, "prefix-discontinuity");
        await cli(scriptFor(kind), ["transition", historyPath, c.customer, c.source, "recovery-replacement",
          "local-recovery", "Unknown delivery interval; process proof only, not a PBX restart"]);
        await collect(c, kind, 1); await collect(c, kind, 0);
        assert.equal(state(c, kind).coverage, "unknown-gap-recorded"); assert.equal(state(c, kind).gapCount, 1);
        assert.equal(state(c, kind).outcome, "success");
      }
      assert.deepEqual(useHistory((h) => h.manifests.list(c.customer).manifests.map((m) => m.epoch)), originalEpochs);
      preserved(c); await rebuild(c);
      const coverage = built(c).document.input.coverage;
      assert.equal(coverage.length, 2); assert.ok(coverage.every((s) => s.gaps.length === 1 && s.association === "possibly-applicable"));
      assert.equal(built(c).document.quality.completeness, "unverified");
    }
    return { permanentGaps: 4, automaticRotations: 0, pbxEpochsAdded: 0, coverage: "unknown-gap-recorded" };
  });
  await check("LR-10", "Killed application restarts with durable evidence/audit, invalid old sessions and isolated authenticated browser reads", async () => {
    const keys = await generateKeyPair("RS256"), jwk = await exportJWK(keys.publicKey);
    let issuer = "", nonce = "";
    const sign = (subject: string, audience: string, claims = {}) => new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "recovery" }).setIssuer(issuer).setSubject(subject)
      .setAudience(audience).setIssuedAt().setExpirationTime("3m").sign(keys.privateKey);
    const identity = createServer(async (req, res) => {
      if (req.url === "/jwks") { res.end(JSON.stringify({ keys: [{ ...jwk, kid: "recovery" }] })); return; }
      if (req.url !== "/token") { res.writeHead(404).end(); return; }
      let body = ""; for await (const chunk of req) body += chunk;
      const subject = new URLSearchParams(body).get("code")!;
      res.end(JSON.stringify({ access_token: await sign(subject, "api"), id_token: await sign(subject, "client", { nonce }) }));
    });
    const listen = async (server: Server) => {
      server.listen(0, "127.0.0.1"); await once(server, "listening");
      const address = server.address(); assert.ok(address && typeof address !== "string");
      return `http://127.0.0.1:${address.port}`;
    };
    const close = async (server: Server) => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    };
    let app: Awaited<ReturnType<typeof worker>> | undefined;
    const before = await Promise.all([readFile(historyPath), readFile(projectionPath)]);
    let browser: Browser | undefined;
    const apiErrors: unknown[] = [];
    try {
      issuer = await listen(identity);
      const reservation = createServer();
      let origin: string;
      try { origin = await listen(reservation); } finally { if (reservation.listening) await close(reservation); }
      const config = { ...workerConfig(customers[0], "cel", "api"), issuer, origin, auditPath: join(directory, "audit.sqlite") };
      browser = await chromium.launch();
      const login = async (c: Customer) => {
        const start = await fetchLocal(`${origin}/auth/login?customer=${c.customer}&workspace=history`, { redirect: "manual" });
        assert.equal(start.status, 302); const url = new URL(start.headers.get("location")!); nonce = url.searchParams.get("nonce")!;
        const complete = await fetchLocal(`${origin}/auth/callback?state=${url.searchParams.get("state")}&code=${c.customer}`, {
          redirect: "manual", headers: { Cookie: start.headers.get("set-cookie")!.split(";")[0] } });
        assert.equal(complete.status, 302);
        assert.equal(complete.headers.get("location"), `/engineering/history/${c.customer}`);
        const cookie = complete.headers.getSetCookie().find((v) => v.startsWith("asterisk-test-session="))!.split(";")[0];
        const response = await fetchLocal(origin + "/auth/session", { headers: { Cookie: cookie } });
        assert.equal(response.status, 200); const info: unknown = await response.json();
        assert.ok(object(info) && typeof info.csrf === "string"); return { cookie, csrf: info.csrf };
      };
      const call = (c: Customer, session: { cookie: string; csrf: string }, action: string, customer = c.customer) =>
        fetchLocal(`${origin}/api/customers/${customer}/history/${action}?${new URLSearchParams({
          runtime: c.scope.runtime, epoch: c.scope.epoch })}`, { headers: { Cookie: session.cookie, "X-CSRF-Token": session.csrf } });
      app = await worker(config);
      const oldSessions = [];
      for (const c of customers) {
        const session = await login(c); oldSessions.push(session);
        const response = await call(c, session, "stored"); assert.equal(response.status, 200);
        const body: unknown = await response.json(); assert.ok(object(body) && typeof body.requestId === "string");
      }
      const auditRows = () => {
        const db = new DatabaseSync(config.auditPath, { readOnly: true });
        try { return db.prepare("SELECT request_id,outcome,status,customer FROM access_audit ORDER BY sequence").all(); }
        finally { db.close(); }
      };
      const earlierAudits = auditRows(); assert.ok(earlierAudits.length >= 4);
      apiErrors.push(...app.errors); await app.stop(); app = undefined;
      await assert.rejects(fetchLocal(origin + "/auth/session"));
      app = await worker(config);
      assert.deepEqual(auditRows(), earlierAudits);
      for (const [i, c] of customers.entries()) {
        assert.equal((await call(c, oldSessions[i], "stored")).status, 401);
        const session = await login(c);
        const stored = await call(c, session, "stored"); assert.equal(stored.status, 200);
        const body: unknown = await stored.json();
        assert.ok(object(body) && object(body.result) && object(body.result.observation));
        assert.deepEqual(body.result.observation.journeys, built(c).document.journeys);
        assert.equal((await call(c, session, "stored", customers[1 - i].customer)).status, 403);
        const context: BrowserContext = await browser.newContext();
        try {
          const [name, value] = session.cookie.split("=");
          await context.addCookies([{ name, value, url: origin, httpOnly: true, sameSite: "Lax" }]);
          const page: Page = await context.newPage();
          const unexpected: string[] = [], errors: string[] = [];
          page.on("pageerror", (e) => errors.push(e.message)); page.on("websocket", (socket) => unexpected.push(socket.url()));
          page.on("request", (request) => {
            const url = new URL(request.url());
            if (url.origin !== origin || !new RegExp(`^/(?:engineering/(?:history/${c.customer}|history\\.js)|auth/(?:session|logout)|api/customers/${c.customer}/history/(?:scopes|revisions|stored|check))$`).test(url.pathname)) {
              unexpected.push(url.pathname);
            }
          });
          await page.addInitScript(() => {
            Object.defineProperty(navigator.mediaDevices, "getUserMedia", { value: () => { throw new Error("Recovery proof must not activate phones"); } });
          });
          await page.goto(`${origin}/engineering/history/${c.customer}`);
          await page.getByRole("button", { name: `${c.scope.runtime} / ${c.scope.epoch}`, exact: true }).click();
          await page.locator("#stored").click();
          await page.locator("#freshness").filter({ hasText: "not-checked" }).waitFor();
          assert.match(await page.locator("#warnings").textContent() ?? "", /"coverage": "unknown"/);
          assert.match(await page.locator("#observations").textContent() ?? "", /abandonment-observed/);
          await page.locator("#check").click(); await page.locator("#freshness").filter({ hasText: "inputs-match" }).waitFor();
          assert.match(await page.locator("#warnings").textContent() ?? "", /unknown-gap-recorded/);
          await page.locator("#sign-out").click(); await page.locator("#session-status").filter({ hasText: "Signed out" }).waitFor();
          assert.equal(await page.locator("#observations").textContent(), "");
          assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
        } finally { await context.close(); }
      }
      assert.ok(auditRows().length > earlierAudits.length);
      assert.deepEqual(auditRows().slice(0, earlierAudits.length), earlierAudits);
      assert.deepEqual(await Promise.all([readFile(historyPath), readFile(projectionPath)]), before);
      apiErrors.push(...app.errors); assert.deepEqual(apiErrors, []);
      return { actualApplicationProcesses: 2, oldSessionsRejected: 2, customerSubstitutionsDenied: 2,
        browserCustomerReads: 2, auditRowsBeforeRestart: earlierAudits.length, auditRowsAfterRestart: auditRows().length,
        applicationReadOnlyBytesUnchanged: true };
    } finally {
      try { await browser?.close(); }
      finally {
        try { if (app) await app.stop(); }
        finally { if (identity.listening) await close(identity); }
      }
    }
  });
  success = true;
} catch (error) {
  failure = error instanceof Error ? error.message : "Unknown recovery failure";
  console.error(`Local recovery failed; inspect ${join(directory, "result.json")}: ${failure}`);
  process.exitCode = 1;
} finally {
  for (const child of processes) if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
  }
  try {
    assert.deepEqual(await Promise.all(originalPaths.map((path) => readFile(path))), originalBytes);
    for (const customer of ["customer-a", "customer-b"]) await rm(join(directory, customer), { recursive: true, force: true });
    assert.equal(processes.size, 0); cleanupVerified = true;
  } catch (error) {
    success = false; process.exitCode = 1;
    failure = `Cleanup/canonical preservation failure: ${error instanceof Error ? error.message : "Unknown error"}`;
    console.error(failure);
  }
  await writeFile(join(directory, "result.json"), JSON.stringify({ status: success ? "passed" : "failed",
    scope: "local process recovery only; no PBX restart, ordinary route changes, live phones or REFER rerun",
    canonical, canonicalHashes: originalBytes.map(historySha256), checks, failure, cleanupVerified,
    retained: ["history.sqlite", "projections.sqlite", "audit.sqlite", "result.json"] }, null, 2));
  console.log(`Local recovery ${success ? "passed" : "failed"}: ${directory}`);
}
