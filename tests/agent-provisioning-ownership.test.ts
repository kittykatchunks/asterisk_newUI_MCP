import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAgentProvisioningExecutor } from "../src/agent-provisioning-executor.ts";
import { openAgentProvisioningJournal } from "../src/agent-provisioning-store.ts";
import type { AgentProvisioningCommand } from "../src/agent-provisioning-store.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-ownership-"));
  const path = join(directory, "journal.sqlite");
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const options = { now: () => 100000 };
  const first = openAgentProvisioningJournal(path, binding, options);
  const second = openAgentProvisioningJournal(path, binding, options);
  const command: AgentProvisioningCommand = { version: 1, ...binding, operationId: randomUUID(),
    revision: 1, leaseId: randomUUID(), notAfter: 160000, action: "prepare",
    payload: { generationId: randomUUID(), extension: "1001" } };
  const context = { requestId: randomUUID(), actor: "fixture", reason: "Synthetic exclusive execution" };
  first.accept(command, context);
  return { directory, path, binding, options, first, second, command, context,
    async close() { first.close(); second.close(); await rm(directory, { recursive: true }); } };
}

test("separate handles cannot overlap; journal I/O and other customer execution remain available", async () => {
  const f = await fixture();
  const other = openAgentProvisioningJournal(join(f.directory, "other.sqlite"),
    { customer: "customer-b", epoch: randomUUID() }, f.options);
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  const controller = new AbortController();
  let started!: () => void;
  const applying = new Promise<void>((resolve) => { started = resolve; });
  const running = createAgentProvisioningExecutor(f.first, {
    async apply() { started(); await gate; }, async observe() { assert.fail("Cancelled before observation"); },
  }, f.options).step(controller.signal);
  try {
    await applying;
    controller.abort(new Error("fixture cancellation"));
    const forbidden = { async apply() { assert.fail("Concurrent apply"); },
      async observe(): Promise<"verified"> { assert.fail("Concurrent observation"); } };
    await assert.rejects(createAgentProvisioningExecutor(f.second, forbidden, f.options).step(), /locked/);
    assert.equal(f.second.report(f.command.operationId)?.receipts[0].stage, "applying");
    const later = { ...f.command, operationId: randomUUID(), revision: 2 };
    f.second.accept(later, f.context);
    assert.equal(f.second.operation(later.operationId)?.receipts.length, 0);
    assert.deepEqual(await createAgentProvisioningExecutor(other, forbidden, f.options).step(), { state: "idle" });
    finish();
    await assert.rejects(running, /fixture cancellation/);
    assert.equal((await createAgentProvisioningExecutor(f.second, {
      async apply() { assert.fail("Recovery must not replay"); }, async observe() { return "verified"; },
    }, f.options).step()).state, "verified");
  } finally {
    finish(); await running.catch(() => {});
    other.close(); await f.close();
  }
});

test("an actual owner process excludes another process and crash releases ownership for observation-only recovery", async () => {
  const f = await fixture();
  const storageModule = new URL("../src/agent-provisioning-store.ts", import.meta.url).href;
  const executorModule = new URL("../src/agent-provisioning-executor.ts", import.meta.url).href;
  const setup = `
    import { openAgentProvisioningJournal } from ${JSON.stringify(storageModule)};
    import { createAgentProvisioningExecutor } from ${JSON.stringify(executorModule)};
    const journal = openAgentProvisioningJournal(${JSON.stringify(f.path)}, ${JSON.stringify(f.binding)}, { now: () => 100000 });
  `;
  const owner = spawn(process.execPath, ["--input-type=module", "--eval", `${setup}
    const keepAlive = setTimeout(() => { throw new Error("fixture owner timed out"); }, 15000);
    await createAgentProvisioningExecutor(journal, {
      async apply() { process.send("applying"); await new Promise(() => {}); },
      async observe() { throw new Error("Unexpected owner observation"); },
    }, { now: () => 100000 }).step();
    clearTimeout(keepAlive);
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exit = once(owner, "exit");
  try {
    const [message] = await once(owner, "message", { signal: AbortSignal.timeout(10000) });
    assert.equal(message, "applying");
    const contender = spawn(process.execPath, ["--input-type=module", "--eval", `${setup}
      try {
        await createAgentProvisioningExecutor(journal, {
          async apply() { throw new Error("Concurrent apply"); },
          async observe() { throw new Error("Concurrent observe"); },
        }, { now: () => 100000 }).step();
        throw new Error("Expected ownership rejection");
      } catch (error) {
        if (!/locked/.test(error.message)) throw error;
        console.log("excluded");
      } finally { journal.close(); }
    `], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    contender.stdout.on("data", (chunk) => { output += chunk; });
    contender.stderr.on("data", (chunk) => { errors += chunk; });
    try {
      const [code] = await once(contender, "exit", { signal: AbortSignal.timeout(10000) });
      assert.equal(code, 0, errors);
      assert.equal(output.trim(), "excluded");
    } finally { if (contender.exitCode === null && contender.signalCode === null) contender.kill(); }
    owner.kill();
    await exit;
    assert.equal(f.first.next().state, "reconcile");
    assert.equal((await createAgentProvisioningExecutor(f.second, {
      async apply() { assert.fail("Crash recovery cannot reapply"); },
      async observe() { return "verified"; },
    }, f.options).step()).state, "verified");
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    await exit;
    await f.close();
  }
});

test("foreign, unsupported and externally locked sidecars fail before adapter entry and remain untouched", async () => {
  const f = await fixture();
  const path = `${f.path}.executor-lock.sqlite`;
  const writer = new DatabaseSync(path);
  const executor = createAgentProvisioningExecutor(f.first, {
    async apply() { assert.fail("Unexpected apply"); }, async observe() { assert.fail("Unexpected observe"); },
  }, f.options);

  try {
    writer.exec("CREATE TABLE unrelated (id INTEGER); INSERT INTO unrelated VALUES (42)");
    await assert.rejects(executor.step(), /Invalid provisioning executor lock/);
    assert.equal(writer.prepare("SELECT id FROM unrelated").get()?.id, 42);
    writer.exec("DROP TABLE unrelated; PRAGMA user_version = 2");
    await assert.rejects(executor.step(), /Invalid provisioning executor lock/);
    writer.exec("PRAGMA user_version = 0; BEGIN IMMEDIATE");
    await assert.rejects(executor.step(), /locked/);
    writer.exec("ROLLBACK");
    assert.equal(f.first.operation(f.command.operationId)?.receipts.length, 0);
    await assert.rejects(f.first.exclusive(async () => { throw new Error("fixture callback failure"); }),
      /callback failure/);
    assert.equal(await f.second.exclusive(async () => "released"), "released");
  } finally { writer.close(); await f.close(); }
});

test("a corrupt lock sidecar fails explicitly without starting or repairing journal work", async () => {
  const f = await fixture();
  try {
    await writeFile(`${f.path}.executor-lock.sqlite`, "not a SQLite database");
    await assert.rejects(createAgentProvisioningExecutor(f.first, {
      async apply() { assert.fail("Unexpected apply"); }, async observe() { assert.fail("Unexpected observe"); },
    }, f.options).step(), /not a database/);
    assert.equal(f.first.next().state, "ready");
    assert.equal(f.first.operation(f.command.operationId)?.receipts.length, 0);
  } finally { await f.close(); }
});
