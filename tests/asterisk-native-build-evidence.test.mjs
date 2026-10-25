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
const directory = "local/asterisk-build";
const preparation = read("local/asterisk-patches/build-preparation.json");
const candidate = read("local/asterisk-patches/queue-policy-v1.json");
const compile = read(`${directory}/compile-report.json`);
const native = read(`${directory}/native-test-report.json`);
const release = read(`${directory}/release-smoke-report.json`);

test("persisted execution evidence binds exact source and report hashes", () => {
  assert.equal(hash("local/asterisk-patches/queue-policy-v1.patch"), candidate.patchSha256);
  for (const report of [preparation, compile, native, release]) {
    assert.equal(report.patchSha256, candidate.patchSha256);
  }
  const compileHash = hash(`${directory}/compile-report.json`);
  assert.equal(compileHash, preparation.buildExecution.compileReportSha256);
  assert.equal(native.compileReportSha256, compileHash);
  assert.equal(release.compileReportSha256, compileHash);
  assert.equal(hash(`${directory}/native-test-report.json`), preparation.nativeExecution.reportSha256);
  assert.equal(hash(`${directory}/native-test-results.xml`), preparation.nativeExecution.aggregateXmlSha256);
  assert.equal(hash(`${directory}/release-smoke-report.json`), preparation.releaseSmoke.reportSha256);
  assert.equal(hash(`${directory}/dependency-lock.json`), preparation.buildExecution.dependencyLockSha256);
});

test("compiled profiles retain exact output counts and test-only separation", () => {
  assert.deepEqual(compile.profiles.map((profile) => profile.name), ["instrumented", "release"]);
  for (const profile of compile.profiles) {
    const instrumented = profile.name === "instrumented";
    assert.equal(profile.outputs.length, instrumented ? 46 : 44);
    assert.equal(new Set(profile.outputs.map((output) => output.path)).size, profile.outputs.length);
    assert.equal(profile.enabledOptions.includes("TEST_FRAMEWORK"), instrumented);
    assert.equal(profile.enabledOptions.includes("BUILD_NATIVE"), false);
    const testModules = profile.outputs.filter((output) => output.path.startsWith("tests/"));
    assert.equal(testModules.length, instrumented ? 2 : 0);
    assert.deepEqual(profile.supportLibraries, ["libasteriskpj.so", "libasteriskssl.so"]);
  }
});

test("native batch records the exact thirty unique passing definitions", () => {
  assert.equal(native.completed, true);
  assert.equal(native.passed, 30);
  assert.equal(native.failed, 0);
  assert.equal(native.allOwnedProcessesStopped, true);
  assert.deepEqual(native.results.map((result) => result.name), candidate.nativeTests);
  assert.equal(new Set(native.results.map((result) => result.name)).size, 30);
  for (const result of native.results) {
    assert.equal(result.result, "passed");
    assert.equal(result.failure, null);
    assert.match(result.xmlSha256, /^[a-f0-9]{64}$/);
  }
});

test("release evidence records exact loaded-state transitions and queue-only startup", () => {
  assert.equal(release.passed, true);
  assert.equal(release.verifiedReleaseOutputs, 44);
  assert.equal(Object.keys(release.resolvedLibraries).length, 29);
  assert.deepEqual(release.loadedModules, ["app_queue.so"]);
  assert.equal(release.testCommandAbsent, true);
  assert.equal(release.ownedPidGreetingVerified, true);
  assert.deepEqual(release.observations.map((item) => item.stage), [
    "initial-loaded", "disk-edited-without-reload", "after-fixture-reload",
    "disk-restored-without-reload", "after-fixture-restore-reload",
  ]);
  assert.deepEqual(release.observations.map((item) => item.response.objects[0].memberTimeoutSeconds),
    [11, 11, 23, 23, 11]);
  assert.deepEqual(release.observations.map((item) => item.response.objects[0].strategy),
    ["ringall", "ringall", "linear", "linear", "ringall"]);
  for (const { response } of release.observations) {
    assert.equal(response.status, "observed");
    assert.equal(response.objects.length, 2);
    assert.deepEqual(response.objects.map((row) => row.name),
      ["cp-aaaaaaaaaaaaaaaaaaaaaaaa-smoke", "proof-queue"]);
  }
});

test("passing fixture evidence does not grant deployment authority", () => {
  assert.equal(release.ownedProcessStopped, true);
  assert.equal(release.processExitCode, 0);
  assert.equal(release.existingPbxOperated, false);
  for (const report of [compile, native, release]) {
    assert.equal(report.runtimeApplyAuthorized, false);
  }
  assert.equal(preparation.nativeExecution.gateAAcceptanceComplete, false);
  assert.equal(preparation.nativeExecution.gateCAuthorized, false);
  assert.equal(preparation.releaseSmoke.runtimeImageProduced, false);
  assert.equal(candidate.nativeCompiled, false);
  assert.equal(candidate.nativeTestsExecuted, false);
});
