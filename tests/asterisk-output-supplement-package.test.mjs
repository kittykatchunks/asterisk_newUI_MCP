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
const accounting = read("local/asterisk-patches/queue-policy-accounting-v1.json");
const loader = read("local/asterisk-patches/queue-policy-loader-v1.json");
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
    "compile-profiles-accounting-v1.py",
    "shutdown_compile_binding-accounting-v1.py",
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

test("loader lifecycle supplement binds the fifth source layer without executing it", () => {
  const expectedLoaderPaths = [
    "include/asterisk/module.h",
    "main/loader.c",
    "tests/test_bounded_queue_policy.c",
  ];
  assert.equal(loader.stage, "source-only-loader-lifecycle-fixture-prepared");
  assert.equal(loader.upstreamCommit, parent.upstreamCommit);
  assert.equal(loader.parentPatchSha256, parent.patchSha256);
  assert.equal(loader.parentSupplementManifestSha256,
    hash("local/asterisk-patches/queue-policy-shutdown-v1.json"));
  assert.equal(loader.parentSupplementPatchSha256, shutdown.patchSha256);
  assert.equal(loader.parentOutputSupplementManifestSha256, hash(manifestPath));
  assert.equal(loader.parentOutputSupplementPatchSha256, supplement.patchSha256);
  assert.equal(loader.parentAccountingSupplementManifestSha256,
    hash("local/asterisk-patches/queue-policy-accounting-v1.json"));
  assert.equal(loader.parentAccountingSupplementPatchSha256, accounting.patchSha256);
  assert.equal(loader.basisCompileReportSha256,
    hash("local/asterisk-build/compile-report-accounting-v1.json"));
  assert.equal(loader.basisNativeReportSha256,
    hash("local/asterisk-build/native-test-report-accounting-v1.json"));
  assert.equal(
    loader.basisSourceSha256["tests/test_bounded_queue_policy.c"],
    supplement.applicationVerification.postimageSha256["tests/test_bounded_queue_policy.c"],
  );
  assert.equal(hash(`local/asterisk-patches/${loader.patch}`), loader.patchSha256);
  assert.deepEqual(loader.changedUpstreamPaths, expectedLoaderPaths);
  assert.deepEqual(Object.keys(loader.basisSourceSha256), expectedLoaderPaths);
  assert.deepEqual(
    Object.keys(loader.applicationVerification.postimageSha256),
    expectedLoaderPaths,
  );
  assert.equal(loader.applicationVerification.patchDryRunSucceeded, true);
  assert.equal(loader.applicationVerification.zeroFuzz, true);
  assert.equal(loader.applicationVerification.zeroOffset, true);
  assert.equal(loader.applicationVerification.appliedToTemporarySourceCopy, true);
  assert.equal(loader.applicationVerification.originalSuccessorSourceModified, false);
  assert.equal(loader.fixtures.testFrameworkOnly, true);
  assert.equal(loader.fixtures.successfulRemovalWhileLookupPausedCovered, true);
  assert.equal(loader.fixtures.denialBeforeHandlerAssertion, true);
  assert.equal(loader.fixtures.targetAbsentAfterRemovalAssertion, true);
  assert.equal(loader.fixtures.newSuccessfulRemovalSchedules, 1);
  assert.equal(loader.fixtures.nativeDefinitionsAdded, 0);
  assert.equal(loader.nativeCompileAuthorized, false);
  assert.equal(loader.nativeCompiled, false);
  assert.equal(loader.nativeTestsExecuted, false);
  assert.equal(loader.asteriskStarted, false);
  assert.equal(loader.runtimeApplyAuthorized, false);
  assert.equal(loader.gatesBAndCApproved, false);
  assert.equal(loader.compilerApplicationSupport.implemented, true);
  assert.equal(loader.compilerApplicationSupport.offlineValidated, true);
  assert.equal(preparation.loaderLifecycleSupplement.manifestSha256,
    hash("local/asterisk-patches/queue-policy-loader-v1.json"));
  assert.equal(preparation.loaderLifecycleSupplement.patchSha256, loader.patchSha256);
  assert.equal(preparation.loaderLifecycleSupplement.nativeCompiled, false);
  assert.equal(preparation.loaderLifecycleSupplement.nativeTestsExecuted, false);

  const compiler = bytes("local/asterisk-build/compile-profiles.py").toString();
  const binding = bytes("local/asterisk-build/shutdown_compile_binding.py").toString();
  const stageRuntime = bytes("local/asterisk-build/stage-runtime.py").toString();
  assert.match(compiler, /--loader-lifecycle-supplement-manifest/);
  assert.match(compiler, /requires --ao2-accounting-supplement-manifest/);
  assert.match(compiler, /verify_loader_lifecycle_basis/);
  assert.match(compiler, /verify_loader_lifecycle_postimages/);
  assert.match(compiler, /loaderLifecycleSupplementManifestSha256/);
  assert.match(binding, /def load_loader_lifecycle_supplement\(/);
  assert.match(binding, /Loader lifecycle supplement source preimage mismatch/);
  assert.match(binding, /Loader lifecycle supplement source postimage mismatch/);
  assert.match(binding, /Compile profile does not bind the loader lifecycle supplement/);
  for (const buildRecord of [
    "queue-policy-loader-v1.patch",
    "queue-policy-loader-v1.json",
  ]) {
    assert.ok(stageRuntime.includes(`"${buildRecord}"`), `Missing staged build record: ${buildRecord}`);
  }
  assert.ok(
    compiler.indexOf("verify_ao2_accounting_basis(tree") <
      compiler.indexOf("verify_loader_lifecycle_basis(tree"),
  );
  assert.ok(
    compiler.indexOf("verify_loader_lifecycle_basis(tree") <
      compiler.indexOf('"-i", loader_lifecycle_supplement_patch'),
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

test("loader lifecycle patch adds only a paused-lookup removal schedule", () => {
  const patch = bytes(`local/asterisk-patches/${loader.patch}`).toString("utf8");
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    .map((match) => {
      assert.equal(match[1], match[2]);
      return match[1];
    });
  assert.deepEqual(paths, loader.changedUpstreamPaths);
  assert.match(patch, /ast_cli_lease_test_wait_for_event/);
  assert.match(patch, /lifecycle_target_successful_removal_case/);
  assert.match(patch, /AST_CLI_LEASE_TEST_LOOKUP/);
  assert.match(patch, /AST_CLI_LEASE_TEST_UNLOAD/);
  assert.match(patch, /!dispatch\.result \|\| removal\.result \|\| loaded/);
  assert.equal(loader.fixtures.nativeDefinitionsAdded, 0);
});

test("AO2 accounting supplement binds its four-layer source lineage offline", () => {
  const expectedAccountingPaths = [
    "include/asterisk/astobj2.h",
    "main/astobj2.c",
    "main/astobj2_container.c",
    "main/astobj2_hash.c",
  ];
  assert.equal(accounting.stage, "source-only-ao2-work-accounting-prepared");
  assert.equal(accounting.upstreamCommit, parent.upstreamCommit);
  assert.equal(accounting.parentPatchSha256, parent.patchSha256);
  assert.equal(accounting.parentSupplementManifestSha256,
    hash("local/asterisk-patches/queue-policy-shutdown-v1.json"));
  assert.equal(accounting.parentSupplementPatchSha256, shutdown.patchSha256);
  assert.equal(accounting.parentOutputSupplementManifestSha256,
    hash(manifestPath));
  assert.equal(accounting.parentOutputSupplementPatchSha256, supplement.patchSha256);
  assert.equal(accounting.basisCompileReportSha256,
    hash("local/asterisk-build/compile-report-output-v1.json"));
  assert.equal(accounting.basisNativeReportSha256,
    hash("local/asterisk-build/native-test-report-output-v1.json"));
  assert.equal(hash(`local/asterisk-patches/${accounting.patch}`), accounting.patchSha256);
  assert.deepEqual(accounting.changedUpstreamPaths, expectedAccountingPaths);
  assert.deepEqual(Object.keys(accounting.basisSourceSha256), expectedAccountingPaths);
  assert.deepEqual(
    Object.keys(accounting.applicationVerification.postimageSha256),
    expectedAccountingPaths,
  );
  assert.equal(accounting.applicationVerification.patchDryRunSucceeded, true);
  assert.equal(accounting.applicationVerification.zeroFuzz, true);
  assert.equal(accounting.applicationVerification.zeroOffset, true);
  assert.equal(accounting.applicationVerification.originalSuccessorSourceModified, false);
  assert.equal(accounting.instrumentation.testFrameworkOnly, true);
  assert.equal(accounting.instrumentation.nativeDefinitionsAdded, 0);
  assert.deepEqual(accounting.instrumentation.workCounters, [
    "AO2 reference calls",
    "AO2 allocations",
    "AO2 container links",
    "AO2 container unlinks",
    "mutex lock attempts and acquisitions",
    "unlock attempts and successes",
    "bucket reads",
    "physical node reads",
  ]);
  assert.equal(accounting.instrumentation.visitorCallsExcludedFromInternalCounters, true);
  assert.equal(accounting.instrumentation.nonAo2AllocatorsAndIoInstrumented, false);
  assert.equal(accounting.instrumentation.gateAAcceptanceComplete, false);
  assert.equal(accounting.nativeCompileAuthorized, false);
  assert.equal(accounting.nativeCompiled, false);
  assert.equal(accounting.nativeTestsExecuted, false);
  assert.equal(accounting.asteriskStarted, false);
  assert.equal(accounting.runtimeApplyAuthorized, false);
  assert.equal(accounting.gatesBAndCApproved, false);
  assert.equal(accounting.compilerApplicationSupport.implemented, true);
  assert.equal(accounting.compilerApplicationSupport.offlineValidated, true);
  assert.equal(preparation.ao2AccountingSupplement.patchSha256, accounting.patchSha256);
  assert.equal(preparation.ao2AccountingSupplement.manifestSha256,
    hash("local/asterisk-patches/queue-policy-accounting-v1.json"));
  assert.equal(preparation.ao2AccountingSupplement.nativeCompiled, false);
  assert.equal(preparation.ao2AccountingSupplement.gateAAcceptanceComplete, false);
  const compiler = bytes("local/asterisk-build/compile-profiles.py").toString();
  const binding = bytes("local/asterisk-build/shutdown_compile_binding.py").toString();
  assert.match(compiler, /--ao2-accounting-supplement-manifest/);
  assert.match(compiler, /requires --cli-output-supplement-manifest/);
  assert.match(compiler, /verify_ao2_accounting_basis/);
  assert.match(compiler, /verify_ao2_accounting_postimages/);
  assert.match(compiler, /ao2AccountingSupplementManifestSha256/);
  assert.match(binding, /def load_ao2_accounting_supplement\(/);
  assert.match(binding, /AO2 accounting supplement source preimage mismatch/);
  assert.match(binding, /AO2 accounting supplement source postimage mismatch/);
  const stageRuntime = bytes("local/asterisk-build/stage-runtime.py").toString();
  for (const buildRecord of [
    "queue-policy-accounting-v1.patch",
    "queue-policy-accounting-v1.json",
  ]) {
    assert.ok(stageRuntime.includes(`"${buildRecord}"`), `Missing staged build record: ${buildRecord}`);
  }
  assert.ok(
    compiler.indexOf('"-i", cli_output_supplement_patch])') <
      compiler.indexOf("verify_ao2_accounting_basis(tree"),
  );
  assert.ok(
    compiler.indexOf("verify_ao2_accounting_basis(tree") <
      compiler.indexOf('"-i", ao2_accounting_supplement_patch'),
  );
});

test("AO2 accounting source patch is test-framework-only and scope-limited", () => {
  const patch = bytes(`local/asterisk-patches/${accounting.patch}`).toString("utf8");
  const paths = [...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
    .map((match) => {
      assert.equal(match[1], match[2]);
      return match[1];
    });
  assert.deepEqual(paths, accounting.changedUpstreamPaths);
  assert.match(patch, /#ifdef TEST_FRAMEWORK/);
  assert.match(patch, /ao2_bounded_work_finish/);
  assert.match(patch, /ao2_bounded_work_suspended/);
  assert.match(patch, /__ao2_alloc_with_lockobj/);
  assert.match(patch, /result->test_work\.node_reads/);
  assert.match(patch, /return NULL;/);
  const ao2Core = patch.slice(
    patch.indexOf("diff --git a/main/astobj2.c"),
    patch.indexOf("diff --git a/main/astobj2_container.c"),
  );
  assert.match(ao2Core, /ao2_bounded_work_active->lock_attempts/);
  assert.match(ao2Core, /ao2_bounded_work_active->lock_acquisitions/);
  assert.match(ao2Core, /ao2_bounded_work_active->unlock_attempts/);
  assert.match(ao2Core, /ao2_bounded_work_active->unlock_successes/);
  const walk = patch.slice(patch.indexOf("diff --git a/main/astobj2_hash.c"));
  assert.match(walk, /work->unlock_successes != \(unsigned int\) acquired/);
  assert.doesNotMatch(walk, /\+\s*\+\+result->test_work\.lock_attempts/);
  assert.doesNotMatch(walk, /\+\s*\+\+result->test_work\.lock_acquisitions/);
  assert.doesNotMatch(walk, /\+\s*\+\+result->test_work\.unlock_attempts/);
});
