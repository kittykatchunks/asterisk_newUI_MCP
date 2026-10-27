import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const digest = (filename) =>
  createHash("sha256").update(readFileSync(path.join(root, filename))).digest("hex");
const supplement = JSON.parse(readFileSync(path.join(root,
  "local/asterisk-patches/queue-policy-shutdown-v1.json"), "utf8"));
const parent = JSON.parse(readFileSync(path.join(root,
  "local/asterisk-patches/queue-policy-v1.json"), "utf8"));

test("shutdown supplement preserves the immutable parent candidate and reports no native proof", () => {
  assert.equal(supplement.parentPatchSha256, parent.patchSha256);
  assert.equal(digest("local/asterisk-patches/queue-policy-shutdown-v1.patch"),
    supplement.patchSha256);
  assert.equal(supplement.nativeCompiled, false);
  assert.equal(supplement.nativeTestsExecuted, false);
  assert.equal(supplement.patchApplicationVerified, false);
  assert.equal(supplement.runtimeApplyAuthorized, false);
  assert.equal(parent.patchSha256, "ede18f89a22f717411a6f5dfbb1e6e81db0834245d32fd5b378e19ec308a17f0");
});

test("shutdown supplement metadata checker reports syntax only", () => {
  const result = spawnSync(process.execPath,
    [path.join(root, "scripts/Test-AsteriskShutdownPatch.mjs")],
    { cwd: root, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "shutdown-source-supplement-checked");
  assert.equal(report.patchSyntaxParsed, true);
  assert.equal(report.patchApplicationVerified, false);
  assert.equal(report.nativeCompiled, false);
  assert.equal(report.nativeTestsExecuted, false);
  assert.equal(report.runtimeApplyAuthorized, false);
});
