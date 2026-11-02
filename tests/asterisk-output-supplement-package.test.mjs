import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bytes = (file) => readFileSync(path.join(root, ...file.split("/")));
const read = (file) => JSON.parse(bytes(file));
const hash = (file) => createHash("sha256").update(bytes(file)).digest("hex");

const manifestPath = "local/asterisk-patches/queue-policy-output-v1.json";
const supplement = read(manifestPath);
const parent = read("local/asterisk-patches/queue-policy-v1.json");
const shutdown = read("local/asterisk-patches/queue-policy-shutdown-v1.json");
const preparation = read("local/asterisk-patches/build-preparation.json");
const expectedPaths = [
  "apps/app_queue.c",
  "tests/test_bounded_queue_policy.c",
  "tests/test_protected_cli_target.c",
];

test("CLI output supplement binds exact parents, source images and offline application", () => {
  assert.equal(supplement.stage, "source-only-cli-output-fixtures-prepared");
  assert.equal(supplement.upstreamCommit, parent.upstreamCommit);
  assert.equal(supplement.parentPatchSha256, parent.patchSha256);
  assert.equal(hash("local/asterisk-patches/queue-policy-v1.patch"), parent.patchSha256);
  assert.equal(supplement.parentSupplementManifestSha256,
    hash("local/asterisk-patches/queue-policy-shutdown-v1.json"));
  assert.equal(supplement.parentSupplementPatchSha256, shutdown.patchSha256);
  assert.equal(hash("local/asterisk-patches/queue-policy-shutdown-v1.patch"),
    shutdown.patchSha256);
  assert.equal(supplement.basisCompileReportSha256,
    hash("local/asterisk-build/compile-report-shutdown-v1.json"));
  assert.equal(supplement.basisNativeReportSha256,
    hash("local/asterisk-build/native-test-report-shutdown-v1.json"));
  assert.equal(hash(`local/asterisk-patches/${supplement.patch}`), supplement.patchSha256);
  assert.deepEqual(supplement.changedUpstreamPaths, expectedPaths);
  assert.deepEqual(Object.keys(supplement.basisSourceSha256).sort(), expectedPaths);
  assert.deepEqual(Object.keys(supplement.applicationVerification.postimageSha256).sort(),
    expectedPaths);
  for (const digest of [
    ...Object.values(supplement.basisSourceSha256),
    ...Object.values(supplement.applicationVerification.postimageSha256),
  ]) {
    assert.match(digest, /^[0-9a-f]{64}$/);
  }
  assert.equal(supplement.applicationVerification.patchDryRunSucceeded, true);
  assert.equal(supplement.applicationVerification.zeroFuzz, true);
  assert.equal(supplement.applicationVerification.zeroOffset, true);
  assert.equal(supplement.applicationVerification.appliedToTemporarySourceCopy, true);
  assert.equal(supplement.applicationVerification.originalSuccessorSourceModified, false);
  assert.equal(supplement.nativeCompileAuthorized, false);
  assert.equal(supplement.nativeCompiled, false);
  assert.equal(supplement.nativeTestsExecuted, false);
  assert.equal(supplement.asteriskStarted, false);
  assert.equal(supplement.runtimeApplyAuthorized, false);
  assert.equal(supplement.gatesBAndCApproved, false);
  assert.equal(supplement.compilerApplicationSupport.implemented, false);
  assert.equal(supplement.fixtures.nativeDefinitionsAdded, 0);
  assert.equal(supplement.fixtures.endToEndQueueSnapshotCommandCovered, false);
  assert.equal(supplement.fixtures.protectedUnregisterCovered, false);
  assert.equal(preparation.cliOutputFixtureSupplement.patchSha256, supplement.patchSha256);
  assert.equal(preparation.cliOutputFixtureSupplement.nativeCompiled, false);
  assert.equal(preparation.cliOutputFixtureSupplement.nativeTestsExecuted, false);
  assert.equal(preparation.cliOutputFixtureSupplement.compilerApplicationSupportImplemented, false);
  assert.equal(preparation.cliOutputFixtureSupplement.gateAAcceptanceComplete, false);
  assert.equal(preparation.cliOutputFixtureSupplement.gateCAuthorized, false);
});

test("CLI output fixture patch has only test-scoped, declared Asterisk paths", () => {
  const patch = bytes(`local/asterisk-patches/${supplement.patch}`).toString("utf8");
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    .map((match) => {
      assert.equal(match[1], match[2]);
      return match[1];
    });
  assert.deepEqual(paths, expectedPaths);
  assert.match(patch, /#include <errno\.h>/);
  assert.match(patch, /#include <unistd\.h>/);
  assert.match(patch, /test_write_prefix/);
  assert.match(patch, /policy_test_output_backpressure/);
  assert.match(patch, /policy_test_partial_response/);
  assert.match(patch, /partial-output/);
  assert.match(patch, /AST_CLI_LEASE_TEST_HANDLER_RETURNED/);
  assert.equal(supplement.fixtures.testFrameworkOnly, true);
});
