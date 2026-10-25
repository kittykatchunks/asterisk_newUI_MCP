import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { compileConfiguration, configurationModel, parseConfigurationModel, configurationHash, ConfigurationValidationError } from "../src/configuration-model.ts";
import { ConfigurationConflict, openConfigurationStore } from "../src/configuration-store.ts";

const scope = { customer: "customer-a", runtime: "runtime-a" };
const actor = { operator: "synthetic-operator", reason: "Offline publication foundation test" };
const model = { schemaVersion: 1, routeId: "inbound", queueId: "waiting", waitSeconds: 2 };
const id = "11111111-1111-4111-8111-111111111111", otherId = "22222222-2222-4222-8222-222222222222";
const execute = promisify(execFile);
async function fixture(action: (store: ReturnType<typeof openConfigurationStore>, path: string, dir: string) => unknown | Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "configuration-foundation-")), path = join(dir, "configuration.sqlite");
  const store = openConfigurationStore(path);
  try { await action(store, path, dir); }
  finally { store.close(); await rm(dir, { recursive: true }); }
}
function approved(store: ReturnType<typeof openConfigurationStore>, selected = scope, wait = 2) {
  const d = store.createDraft(selected, JSON.stringify({ ...model, waitSeconds: wait }), 0, actor);
  const v = store.validate(selected, d.revision, d.sha256, actor);
  const a = store.approve(selected, d.revision, d.sha256, v.sha256, actor);
  return { d, v, a };
}
const codeImport = "import {openConfigurationStore} from './src/configuration-store.ts';";
const cli = async (action: string, path: string, ...args: string[]) => {
  const result = await execute(process.execPath, ["scripts\\Manage-ConfigurationDraft.ts", action, path,
    scope.customer, scope.runtime, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(result.stdout);
};

test("CF-01: deterministic exact compiler output has fresh markers, bounded wait and only empty-queue configuration", () => {
  for (const waitSeconds of [1, 30]) {
    const c = compileConfiguration(scope, { ...model, waitSeconds }, 1);
    assert.deepEqual(c, compileConfiguration({ ...scope }, { waitSeconds, queueId: "waiting", routeId: "inbound", schemaVersion: 1 }, 1));
    assert.equal(c.canonical, JSON.stringify({ ...model, waitSeconds }));
    assert.equal(c.namespace.length, 27);
    assert.equal(c.dialplan, `[${c.context}]\nexten => entry,1,Set(HISTORY_JOURNEY=\${UUID()})\n` +
      ` same => n,Set(HISTORY_VISIT=\${UUID()})\n` +
      ` same => n,CELGenUserEvent(HISTORY_ENTRY,{"v":1,"journeyId":"\${HISTORY_JOURNEY}","entryKind":"synthetic","routeRevision":"${c.routeRevision}"})\n` +
      ` same => n,Answer()\n` +
      ` same => n,CELGenUserEvent(HISTORY_QUEUE_VISIT,{"v":1,"journeyId":"\${HISTORY_JOURNEY}","visitId":"\${HISTORY_VISIT}","queue":"${c.queue}","routeRevision":"${c.routeRevision}"})\n` +
      ` same => n,Queue(${c.queue},,,n,${waitSeconds})\n same => n,Hangup()\n`);
    assert.equal(c.queues, `[${c.queue}]\nstrategy = ringall\ntimeout = 2\njoinempty = yes\nleavewhenempty = no\n`);
    assert.equal(configurationHash(c.dialplan), c.dialplanSha256); assert.equal(configurationHash(c.queues), c.queuesSha256);
    assert.doesNotMatch(c.queues, /member|secret|include/);
    assert.notEqual(compileConfiguration(scope, model, 2).routeRevision, c.routeRevision);
    assert.notEqual(compileConfiguration({ ...scope, customer: "customer-b" }, model, 1).namespace, c.namespace);
    assert.notEqual(compileConfiguration({ ...scope, runtime: "runtime-b" }, model, 1).namespace, c.namespace);
  }
});

test("CF-02: strict model rejects unsafe values, unknowns, duplicate/escaped keys and noncanonical JSON numbers", () => {
  for (const value of [null, [], {}, { ...model, schemaVersion: 2 }, { ...model, routeId: "UPPER" },
    { ...model, queueId: "../other" }, { ...model, routeId: "a\n[foreign]" }, { ...model, routeId: "a".repeat(33) },
    { ...model, waitSeconds: 0 }, { ...model, waitSeconds: 31 }, { ...model, waitSeconds: 1.5 },
    { ...model, waitSeconds: "2" }, { ...model, waitSeconds: NaN }, { ...model, waitSeconds: Infinity },
    { ...model, customer: "foreign" }, { ...model, destination: "foreign" }, { ...model, members: [] }]) {
    assert.throws(() => configurationModel(value), Error, JSON.stringify(value));
  }
  assert.equal(configurationModel({ ...model, routeId: "a".repeat(32) }).routeId.length, 32);
  for (const raw of [JSON.stringify(model).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
    JSON.stringify(model).replace('"queueId":"waiting"', '"queueId":"waiting","\\u0071ueueId":"waiting"'),
    JSON.stringify(model).replace('"waitSeconds":2', '"waitSeconds":2e0'),
    JSON.stringify(model).replace('"waitSeconds":2', '"waitSeconds":2.0'),
    JSON.stringify(model).replace('"waitSeconds":2', '"waitSeconds":-0'), " ".repeat(4097), '{"bad":']) {
    assert.throws(() => parseConfigurationModel(raw));
  }
  assert.deepEqual(parseConfigurationModel(JSON.stringify(model, null, 2)), model);
});

test("CF-03: offline draft/validation/approval hashes bind exact output and never assert runtime validation or apply authority", async () => {
  await fixture((store) => {
    const { d, v, a } = approved(store);
    assert.equal(d.revision, 1); assert.equal(d.baseRevision, 0);
    assert.equal(v.document.runtimeValidated, false);
    assert.equal(v.document.dialplanSha256, d.compiled.dialplanSha256);
    assert.equal(a.document.validationSha256, v.sha256);
    assert.equal(a.document.sameAuthor, true); assert.equal(a.document.sameAuthorPermitted, true);
    assert.equal(a.document.identityBasis, "trusted-local-operator-reference");
    assert.equal(a.document.runtimeApplyAuthorized, false);
    const read = store.read(scope, 1); assert.equal(read.executorEnabled, false); assert.equal(read.runtimeStatus, "not-inspected");
    assert.throws(() => store.validate(scope, 1, d.sha256, actor), ConfigurationConflict);
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor), ConfigurationConflict);
    assert.deepEqual(store.read(scope, 1), read);
  });
});

test("CF-04: new drafts cannot inherit approval; wrong hashes/base and foreign scope fail closed", async () => {
  await fixture((store) => {
    const { d, v, a } = approved(store);
    const changed = store.createDraft(scope, JSON.stringify({ ...model, waitSeconds: 3 }), 0, actor);
    assert.equal(changed.revision, 2); assert.equal(store.read(scope, 2).approval, undefined);
    assert.throws(() => store.approve(scope, 2, changed.sha256, v.sha256, actor), ConfigurationConflict);
    assert.throws(() => store.validate(scope, 2, d.sha256, actor), ConfigurationConflict);
    assert.throws(() => store.claim(scope, 2, a.sha256, 0, id, actor), ConfigurationConflict);
    assert.throws(() => store.createDraft(scope, JSON.stringify(model), 1, actor), ConfigurationConflict);
    assert.throws(() => store.read({ ...scope, customer: "customer-b" }, 1), ConfigurationConflict);
    assert.throws(() => store.read({ ...scope, runtime: "runtime-b" }, 1), ConfigurationConflict);
    assert.throws(() => store.claim(scope, 1, a.sha256, 1, id, actor), ConfigurationConflict);
    assert.deepEqual(store.read(scope, 1).draft, d);
  });
});

test("CF-05: exact operation retry is idempotent and payload/context reuse conflicts; runtime scopes fence independently", async () => {
  await fixture((store) => {
    const { a } = approved(store);
    const first = store.claim(scope, 1, a.sha256, 0, id, actor);
    assert.equal(first.state, "claimed"); assert.equal(first.intent.executorEnabled, false);
    assert.equal(first.reused, false);
    const retry = store.claim(scope, 1, a.sha256, 0, id, actor);
    assert.equal(retry.reused, true); assert.deepEqual(retry.events, first.events); assert.equal(retry.sha256, first.sha256);
    assert.throws(() => store.claim(scope, 1, a.sha256, 0, id, { ...actor, reason: "different" }), ConfigurationConflict);
    assert.throws(() => store.claim(scope, 1, "a".repeat(64), 0, id, actor), ConfigurationConflict);
    assert.throws(() => store.claim(scope, 1, a.sha256, 0, otherId, actor), ConfigurationConflict);
    const other = { ...scope, customer: "customer-b" }, b = approved(store, other);
    assert.equal(store.claim(other, 1, b.a.sha256, 0, id, actor).state, "claimed");
    assert.equal(store.operation({ ...scope, runtime: "unknown" }, id), undefined);
  });
});

test("CF-06: explicit cancellation releases only offline claims; uncertain claims persist and block new work after reopening", async () => {
  await fixture((store, path) => {
    const { a } = approved(store);
    store.claim(scope, 1, a.sha256, 0, id, actor);
    const cancelled = store.finishOffline(scope, id, "cancelled-before-effects", actor);
    assert.equal(cancelled.events.length, 2); assert.equal(cancelled.state, "cancelled-before-effects");
    assert.equal(store.claim(scope, 1, a.sha256, 0, id, actor).state, "cancelled-before-effects", "Retry cannot revive an old operation");
    store.claim(scope, 1, a.sha256, 0, otherId, actor);
    store.finishOffline(scope, otherId, "uncertain", actor);
    const reopened = openConfigurationStore(path);
    try {
      assert.equal(reopened.operation(scope, otherId)?.state, "uncertain");
      assert.throws(() => reopened.finishOffline(scope, otherId, "cancelled-before-effects", actor), ConfigurationConflict);
      assert.throws(() => reopened.claim(scope, 1, a.sha256, 0, "33333333-3333-4333-8333-333333333333", actor), ConfigurationConflict);
    } finally { reopened.close(); }
  });
});

test("CF-07: separate competing processes claim exactly one durable active operation", async () => {
  await fixture(async (store, path) => {
    const { a } = approved(store);
    const code = `${codeImport}
      const store=openConfigurationStore(process.argv[1]);
      try { console.log(JSON.stringify(store.claim(${JSON.stringify(scope)},1,${JSON.stringify(a.sha256)},0,process.argv[2],${JSON.stringify(actor)}))); }
      finally { store.close(); }`;
    const results = await Promise.allSettled([id, otherId].map((operation) =>
      execute(process.execPath, ["--input-type=module", "-e", code, path, operation], { timeout: 15000 })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    const row = [store.operation(scope, id), store.operation(scope, otherId)].filter(Boolean);
    assert.equal(row.length, 1); assert.equal(row[0]!.events.length, 1);
  });
});

test("CF-08: process death after a durable claim preserves fencing; uncommitted claim failure rolls back all rows", async () => {
  await fixture(async (store, path) => {
    const { a } = approved(store);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `${codeImport}
      const store=openConfigurationStore(process.argv[1]);
      store.claim(${JSON.stringify(scope)},1,${JSON.stringify(a.sha256)},0,${JSON.stringify(id)},${JSON.stringify(actor)});
      console.log('committed'); setInterval(()=>{},1000);`, path], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Claim worker readiness timeout")), 10000);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Claim worker exited early")); });
      });
    } finally { child.kill("SIGKILL"); await exited; }
    assert.equal(store.operation(scope, id)?.state, "claimed");
    assert.throws(() => store.claim(scope, 1, a.sha256, 0, otherId, actor), ConfigurationConflict);
    store.finishOffline(scope, id, "cancelled-before-effects", actor);
    const db = new DatabaseSync(path);
    try { db.exec("CREATE TRIGGER fail_claim BEFORE INSERT ON configuration_operation_events BEGIN SELECT RAISE(ABORT,'injected claim event failure'); END;"); }
    finally { db.close(); }
    assert.throws(() => store.claim(scope, 1, a.sha256, 0, otherId, actor), /injected claim/);
    assert.equal(store.operation(scope, otherId), undefined);
    const inspect = new DatabaseSync(path, { readOnly: true });
    try { assert.equal(inspect.prepare("SELECT count(*) AS count FROM configuration_claims").get()?.count, 0); }
    finally { inspect.close(); }
  });
});

test("CF-09: validation/approval receipt storage failure is atomic and leaves previous immutable data readable", async () => {
  await fixture((store, path) => {
    const d = store.createDraft(scope, JSON.stringify(model), 0, actor);
    const db = new DatabaseSync(path);
    try { db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON configuration_receipts BEGIN SELECT RAISE(ABORT,'injected receipt failure'); END;"); }
    finally { db.close(); }
    assert.throws(() => store.validate(scope, 1, d.sha256, actor), /injected receipt/);
    assert.equal(store.read(scope, 1).validation, undefined); assert.deepEqual(store.read(scope, 1).draft, d);
    const change = new DatabaseSync(path);
    try { change.exec("DROP TRIGGER fail_receipt"); } finally { change.close(); }
    const v = store.validate(scope, 1, d.sha256, actor);
    const fail = new DatabaseSync(path);
    try { fail.exec("CREATE TRIGGER fail_approval BEFORE INSERT ON configuration_receipts WHEN NEW.kind='approved' BEGIN SELECT RAISE(ABORT,'injected approval failure'); END;"); }
    finally { fail.close(); }
    assert.throws(() => store.approve(scope, 1, d.sha256, v.sha256, actor), /injected approval/);
    assert.equal(store.read(scope, 1).approval, undefined); assert.deepEqual(store.read(scope, 1).validation, v);
  });
});

test("CF-10: malformed/corrupt/wrong-identity stores fail explicitly; read-only never creates or mutates", async () => {
  await fixture(async (store, path, dir) => {
    const { d } = approved(store), before = await readFile(path);
    const reader = openConfigurationStore(path, { readOnly: true });
    try {
      assert.equal(reader.read(scope, 1).draft.sha256, d.sha256);
      assert.throws(() => reader.createDraft(scope, JSON.stringify(model), 0, actor), /writable/);
    } finally { reader.close(); }
    assert.deepEqual(await readFile(path), before);
    assert.throws(() => openConfigurationStore(join(dir, "missing.sqlite"), { readOnly: true }));
    assert.equal((await readdir(dir)).includes("missing.sqlite"), false);
    const wrong = join(dir, "wrong.sqlite"), db = new DatabaseSync(wrong); db.exec("CREATE TABLE unrelated(x)"); db.close();
    const wrongBefore = await readFile(wrong);
    assert.throws(() => openConfigurationStore(wrong), /supported/);
    assert.deepEqual(await readFile(wrong), wrongBefore);
    const corrupt = new DatabaseSync(path);
    try { corrupt.prepare("UPDATE configuration_drafts SET document='{}'").run(); } finally { corrupt.close(); }
    assert.throws(() => store.read(scope, 1), /checksum/);
  });
});

test("CF-11: recomputed checksums cannot conceal forged compiler artifacts or unbound validation/approval facts", async () => {
  await fixture((store, path) => {
    approved(store);
    const db = new DatabaseSync(path);
    try {
      for (const kind of ["validated", "approved"]) {
        const row = db.prepare("SELECT document FROM configuration_receipts WHERE kind=?").get(kind)!;
        const value = JSON.parse(String(row.document));
        if (kind === "validated") value.queuesSha256 = "a".repeat(64);
        else value.runtimeApplyAuthorized = true;
        const text = JSON.stringify(value);
        db.prepare("UPDATE configuration_receipts SET document=?,sha256=? WHERE kind=?").run(text, configurationHash(text), kind);
        assert.throws(() => store.read(scope, 1), /Corrupt/);
        db.prepare("UPDATE configuration_receipts SET document=?,sha256=? WHERE kind=?")
          .run(String(row.document), configurationHash(String(row.document)), kind);
      }
      const row = db.prepare("SELECT document FROM configuration_drafts").get()!;
      const value = JSON.parse(String(row.document)); value.compiled.queues += "member => PJSIP/foreign\n";
      const text = JSON.stringify(value);
      db.prepare("UPDATE configuration_drafts SET document=?,sha256=?").run(text, configurationHash(text));
      assert.throws(() => store.read(scope, 1), /compiler output/);
    } finally { db.close(); }
  });
});

test("CF-12: real operator CLI round-trips draft/validation/approval/claims across processes with no runtime operations", async () => {
  await fixture(async (_store, path, dir) => {
    const input = join(dir, "model.json"); await writeFile(input, JSON.stringify(model));
    const d = await cli("draft", path, input, "0", actor.operator, actor.reason);
    const v = await cli("validate", path, "1", d.result.sha256, actor.operator, actor.reason);
    const a = await cli("approve", path, "1", d.result.sha256, v.result.sha256, actor.operator, actor.reason);
    const op = await cli("claim", path, "1", a.result.sha256, "0", id, actor.operator, actor.reason);
    assert.equal(op.result.state, "claimed"); assert.equal(op.offlineOnly, true);
    assert.equal(op.executorEnabled, false); assert.equal(op.runtimeStatus, "not-inspected");
    const before = await readFile(path);
    assert.deepEqual((await cli("operation", path, id)).result.events, op.result.events);
    assert.deepEqual(await readFile(path), before);
    const cancelled = await cli("cancel", path, id, actor.operator, actor.reason);
    assert.equal(cancelled.result.state, "cancelled-before-effects");
    await assert.rejects(cli("apply", path, id));
    await assert.rejects(cli("read", path, "01"));
    await assert.rejects(cli("draft", path, input, "1", actor.operator, actor.reason));
    assert.equal((await cli("read", path, "1")).result.approval.sha256, a.result.sha256);
    assert.deepEqual((await readdir(dir)).sort(), ["configuration.sqlite", "model.json"]);
  });
});

test("CF-13: invalid model input returns bounded structured errors and never reserves a draft revision", async () => {
  await fixture(async (store, path, dir) => {
    const input = join(dir, "invalid.json");
    await writeFile(input, JSON.stringify({ ...model, waitSeconds: 31 }));
    try {
      await cli("draft", path, input, "0", actor.operator, actor.reason);
      assert.fail("Invalid input unexpectedly succeeded");
    } catch (error) {
      assert.ok(error instanceof Error && "stderr" in error && typeof error.stderr === "string");
      const line = error.stderr.split(/\r?\n/).find((text) => text.startsWith('{"offlineOnly":'));
      assert.ok(line, "CLI must emit an explicit structured error independently of Node warnings");
      const result = JSON.parse(line);
      assert.equal(result.error.code, "validation-failed");
      assert.deepEqual(result.error.issues, [{ code: "wait-range", path: "$.waitSeconds",
        message: "Configuration wait requires an integer from 1 through 30" }]);
      assert.ok(JSON.stringify(result).length < 1000);
    }
    assert.throws(() => parseConfigurationModel('{"schemaVersion":'), ConfigurationValidationError);
    await writeFile(input, " ".repeat(4097));
    await assert.rejects(cli("draft", path, input, "0", actor.operator, actor.reason),
      (error: unknown) => error instanceof Error && "stderr" in error && typeof error.stderr === "string" &&
        error.stderr.includes('"code":"input-size"'));
    assert.equal(store.createDraft(scope, JSON.stringify(model), 0, actor).revision, 1);
  });
});

test("CF-14: two process draft creation assigns distinct immutable scoped revisions", async () => {
  await fixture(async (store, path, dir) => {
    const input = join(dir, "model.json"); await writeFile(input, JSON.stringify(model));
    const results = await Promise.all([1, 2].map(() => cli("draft", path, input, "0", actor.operator, actor.reason)));
    assert.deepEqual(results.map((r) => r.result.revision).sort(), [1, 2]);
    for (const r of results) assert.deepEqual(store.read(scope, r.result.revision).draft, r.result);
    assert.notEqual(results[0].result.sha256, results[1].result.sha256);
  });
});

test("CF-15: kill inside the actual claim transaction rolls back intent, claim and events together", async () => {
  await fixture(async (store, path) => {
    const { a } = approved(store);
    const child = spawn(process.execPath, ["--input-type=module", "-e", `${codeImport}
      import {DatabaseSync} from 'node:sqlite';
      const original=DatabaseSync.prototype.prepare;
      DatabaseSync.prototype.prepare=function(sql) {
        const stmt=original.call(this,sql);
        if(!sql.startsWith('INSERT INTO configuration_operations')) return stmt;
        return new Proxy(stmt,{get(target,key) {
          if(key==='run') return (...args)=>{
            const result=target.run(...args);
            console.log('uncommitted');
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
            return result;
          };
          const value=Reflect.get(target,key,target);
          return typeof value==='function'?value.bind(target):value;
        }});
      };
      const store=openConfigurationStore(process.argv[1]);
      store.claim(${JSON.stringify(scope)},1,${JSON.stringify(a.sha256)},0,${JSON.stringify(id)},${JSON.stringify(actor)});
      throw new Error('Claim injection did not stop');`, path], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", () => resolve()); });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Claim transaction worker readiness timeout")), 10000);
        child.stdout.once("data", () => { clearTimeout(timer); resolve(); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error("Claim transaction worker exited early")); });
      });
    } finally { child.kill("SIGKILL"); await exited; }
    assert.equal(store.operation(scope, id), undefined);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      for (const table of ["configuration_operations", "configuration_claims", "configuration_operation_events"]) {
        assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count, 0);
      }
    } finally { db.close(); }
    assert.equal(store.claim(scope, 1, a.sha256, 0, id, actor).state, "claimed");
  });
});
