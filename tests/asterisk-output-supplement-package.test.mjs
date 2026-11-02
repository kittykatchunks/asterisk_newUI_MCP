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
  assert.equal(supplement.compilerApplicationSupport.implemented, true);
  assert.equal(supplement.fixtures.nativeDefinitionsAdded, 0);
  assert.equal(supplement.fixtures.endToEndQueueSnapshotCommandCovered, false);
  assert.equal(supplement.fixtures.protectedUnregisterCovered, false);
  assert.equal(preparation.cliOutputFixtureSupplement.patchSha256, supplement.patchSha256);
  assert.equal(preparation.cliOutputFixtureSupplement.nativeCompiled, false);
  assert.equal(preparation.cliOutputFixtureSupplement.nativeTestsExecuted, false);
  assert.equal(preparation.cliOutputFixtureSupplement.compilerApplicationSupportImplemented, true);
  assert.equal(preparation.cliOutputFixtureSupplement.gateAAcceptanceComplete, false);
  assert.equal(preparation.cliOutputFixtureSupplement.gateCAuthorized, false);
  const compiler = bytes("local/asterisk-build/compile-profiles.py").toString();
  const binding = bytes("local/asterisk-build/shutdown_compile_binding.py").toString();
  assert.match(compiler, /--cli-output-supplement-manifest/);
  assert.match(compiler, /requires --shutdown-supplement-manifest/);
  assert.match(compiler, /verify_cli_output_basis/);
  assert.match(compiler, /verify_cli_output_postimages/);
  assert.match(compiler, /cliOutputSupplementManifestSha256/);
  assert.match(compiler, /cliOutputSupplementParentPatchSha256/);
  assert.match(compiler, /cliOutputSupplementParentSupplementManifestSha256/);
  assert.match(binding, /def load_cli_output_supplement\(/);
  assert.match(binding, /CLI output supplement source preimage mismatch/);
  assert.match(binding, /CLI output supplement source postimage mismatch/);
  assert.match(binding, /def validate_cli_output_compile_report\(/);
  for (const consumer of [
    "local/asterisk-build/run-native-tests.py",
    "local/asterisk-build/shutdown-supervisor.py",
    "local/asterisk-build/smoke-release.py",
    "local/asterisk-build/stage-runtime.py",
    "local/asterisk-build/verify-full-startup.py",
    "local/asterisk-build/verify-runtime.py",
  ]) {
    assert.match(bytes(consumer).toString(), /validate_cli_output_compile_report\(compile_report\)/);
  }
  const stageRuntime = bytes("local/asterisk-build/stage-runtime.py").toString();
  for (const buildRecord of [
    "queue-policy-v1.patch",
    "queue-policy-v1.json",
    "queue-policy-shutdown-v1.patch",
    "queue-policy-shutdown-v1.json",
    "queue-policy-output-v1.patch",
    "queue-policy-output-v1.json",
    "compile-profiles.py",
    "shutdown_compile_binding.py",
  ]) {
    assert.ok(stageRuntime.includes(`"${buildRecord}"`), `Missing staged build record: ${buildRecord}`);
  }
  assert.ok(
    compiler.indexOf('"-i", shutdown_supplement_patch])') <
      compiler.indexOf("verify_cli_output_basis(tree"),
  );
  assert.ok(
    compiler.indexOf("verify_cli_output_basis(tree") <
      compiler.indexOf('"-i", cli_output_supplement_patch'),
  );
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
