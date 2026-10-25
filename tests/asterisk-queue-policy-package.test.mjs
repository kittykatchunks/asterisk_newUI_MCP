import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = readFileSync(path.join(root, "scripts", "Test-AsteriskQueuePolicyPatch.mjs"));
const sourceManifest = readFileSync(path.join(root, "local", "asterisk-patches", "queue-policy-v1.json"));
const sourcePatch = readFileSync(path.join(root, "local", "asterisk-patches", "queue-policy-v1.patch"));

function withFixture(action) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "asterisk-policy-package-"));
  const scripts = path.join(directory, "scripts");
  const artifacts = path.join(directory, "local", "asterisk-patches");
  mkdirSync(scripts);
  mkdirSync(artifacts, { recursive: true });
  const script = path.join(scripts, "Test-AsteriskQueuePolicyPatch.mjs");
  const manifest = path.join(artifacts, "queue-policy-v1.json");
  const patch = path.join(artifacts, "queue-policy-v1.patch");
  writeFileSync(script, sourceScript);
  writeFileSync(manifest, sourceManifest);
  writeFileSync(patch, sourcePatch);
  try {
    action({
      directory, manifest, patch,
      run: (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 10_000 }),
    });
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test("package integrity output cannot claim compilation, native tests or runtime authority", () => {
  withFixture(({ run }) => {
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      status: "source-package-checked",
      patchSha256: JSON.parse(sourceManifest).patchSha256,
      sourcePreimagesAndDryRunChecked: false,
      nativeCompiled: false,
      nativeTestsExecuted: false,
      runtimeApplyAuthorized: false,
    });
  });
});

test("unexpected arguments fail explicitly", () => {
  withFixture(({ run }) => {
    const result = run("--apply");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Usage:/);
  });
});

test("altered patch bytes fail checksum verification", () => {
  withFixture(({ run, patch }) => {
    writeFileSync(patch, Buffer.concat([sourcePatch, Buffer.from("\n")]));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum/);
  });
});

test("manifest cannot silently promote the source candidate to native success", () => {
  withFixture(({ run, manifest }) => {
    const changed = JSON.parse(sourceManifest);
    changed.nativeTestsExecuted = true;
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval boundary/);
  });
});

test("manifest source scope cannot expand", () => {
  withFixture(({ run, manifest }) => {
    const changed = JSON.parse(sourceManifest);
    changed.files[0].path = "../outside.c";
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /approval boundary/);
  });
});

test("missing preimages never pass as a clean applicable source tree", () => {
  withFixture(({ run, directory }) => {
    const result = run("--source", directory);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ENOENT/);
    assert.equal(result.stdout, "");
  });
});

test("duplicate native-test names fail inventory validation", () => {
  withFixture(({ run, manifest }) => {
    const changed = JSON.parse(sourceManifest);
    changed.nativeTests.push(changed.nativeTests[0]);
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /duplicate native-test inventory/);
  });
});

test("omitted native-test names cannot hide definitions", () => {
  withFixture(({ run, manifest }) => {
    const changed = JSON.parse(sourceManifest);
    changed.nativeTests.pop();
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AST_TEST_DEFINE/);
  });
});

test("invented native-test names cannot count as implemented coverage", () => {
  withFixture(({ run, manifest }) => {
    const changed = JSON.parse(sourceManifest);
    changed.nativeTests.push("not_implemented");
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AST_TEST_DEFINE/);
  });
});

test("definitions without registrations fail even with an updated patch checksum", () => {
  withFixture(({ run, manifest, patch }) => {
    const changed = JSON.parse(sourceManifest);
    const name = changed.nativeTests[0];
    const original = sourcePatch.toString("utf8");
    const altered = original.replace(`+\tAST_TEST_REGISTER(${name});`, "+\t/* registration omitted */");
    assert.notEqual(altered, original);
    writeFileSync(patch, altered);
    changed.patchSha256 = createHash("sha256").update(altered).digest("hex");
    writeFileSync(manifest, JSON.stringify(changed));
    const result = run();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /AST_TEST_REGISTER/);
  });
});
