import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openFakeProvisioningRuntime } from "./identity/fake-provisioning-runtime.ts";

const driver = fileURLToPath(new URL("./identity/fake-broker-source-proof.py", import.meta.url));

test("Python source reads the TypeScript fake runtime without mutation and fails closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "asterisk-python-source-"));
  const path = join(directory, "runtime #1.sqlite");
  const binding = { customer: "customer-a", epoch: randomUUID() };
  const generationId = randomUUID();
  const runtime = openFakeProvisioningRuntime(path, binding, { now: () => 100000 });
  const read = (action: string, epoch = binding.epoch, id = generationId, sourcePath = path) =>
    spawnSync(process.platform === "win32" ? "python" : "python3",
      ["-B", driver, sourcePath, binding.customer, epoch, id, action],
      { encoding: "utf8", timeout: action === "listener" ? 20000 : 5000 });
  const success = (action: string) => {
    const result = read(action);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const failure = (result: ReturnType<typeof read>, message: RegExp) => {
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, message);
  };
  const snapshot = async () => ({
    files: await readdir(directory),
    bytes: await readFile(path),
    effects: runtime.effectCount(),
  });
  const compare = async () => {
    const before = await snapshot();
    const signal = AbortSignal.timeout(5000);
    assert.deepEqual(success("inventory").generations, await runtime.expiry.inventory(signal));
    assert.deepEqual(success("generation").observation, await runtime.expiry.observe(generationId, signal));
    if (process.env.ASTERISK_SYNTHETIC_LISTENER_PROOF === "1") {
      assert.equal(process.platform, "linux");
      const responses = success("listener");
      for (const client of ["python", "node"]) {
        const inventory = success("inventory");
        assert.deepEqual(responses[client], {
          denied: null, scope: null, inventory, generation: success("generation"),
          missing: null, recovery: inventory,
        });
      }
    }
    assert.deepEqual(await snapshot(), before);
  };
  const apply = async (action: "prepare" | "activate" | "drain" | "revoke") => {
    const base = {
      version: 1 as const, ...binding, revision: 1, operationId: randomUUID(), leaseId: randomUUID(),
      notAfter: 160000,
    };
    await runtime.execution.apply(action === "prepare" ? {
      ...base, action, payload: { generationId, extension: "1001" },
    } : {
      ...base, action, payload: { generationId },
    }, AbortSignal.timeout(5000));
  };
  try {
    assert.deepEqual(success("inventory").generations, []);
    await apply("prepare");
    await compare();
    await apply("activate");
    runtime.startCall(generationId);
    await compare();
    runtime.setDialogs(generationId, "unknown");
    await compare();
    await apply("drain");
    await compare();
    runtime.setDialogs(generationId, 0);
    await apply("revoke");
    await compare();
    const before = await snapshot();
    assert.deepEqual(success("cancel"), { cancelled: true });
    assert.deepEqual(success("readonly"), { readonly: true });
    failure(read("inventory", randomUUID()), /Fake runtime binding mismatch/);
    failure(read("generation", binding.epoch, randomUUID()), /Invalid or missing fake generation/);
    failure(read("inventory", binding.epoch, generationId, join(directory, "absent.sqlite")),
      /unable to open database file/);
    assert.deepEqual(await snapshot(), before);
    if (process.env.ASTERISK_SYNTHETIC_LISTENER_PROOF === "1") {
      t.diagnostic("Authenticated synthetic source: 5 state snapshots, 60 Python/Node connections, " +
        "40 source entries, 30 expected denials/rejections, exact responses and unchanged database.");
    }

    const corrupt = new DatabaseSync(path);
    try {
      corrupt.prepare("UPDATE fake_generations SET phase = 'broken'").run();
      failure(read("inventory"), /Invalid or missing fake generation/);
      failure(read("generation"), /Invalid or missing fake generation/);
      corrupt.prepare("DELETE FROM fake_binding").run();
      failure(read("inventory"), /Fake runtime binding mismatch/);
    } finally { corrupt.close(); }
  } finally {
    runtime.close();
    await rm(directory, { recursive: true });
  }
});
