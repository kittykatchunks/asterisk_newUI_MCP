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
const bundleValidation = read(`${directory}/runtime-bundle-validation.json`);
const bundleManifest = read(`${directory}/runtime-bundle-manifest.json`);
const bundleSmoke = read(`${directory}/runtime-bundle-smoke-report.json`);

test("synthetic Local call proves measured empty-queue timeout and exact channel cleanup", () => {
  const validation = read(`${directory}/synthetic-local-call-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  assert.equal(validation.imageId, startup.imageId);
  assert.equal(validation.bundleManifestSha256, startup.bundleManifestSha256);
  assert.deepEqual(validation.loadedModules, startup.loadedModules);
  assert.deepEqual(validation.startupPolicyObservations, startup.observations);
  assert.deepEqual(validation.isolationSettings, startup.isolationSettings);
  assert.deepEqual(validation.pjsipEmptyObjectChecks, startup.pjsipEmptyObjectChecks);
  assert.equal(validation.testCommandAbsent, true);
  const call = validation.syntheticLocalCall;
  assert.equal(call.passed, true);
  assert.equal(call.queueStatus, "TIMEOUT");
  assert.equal(call.initialPolicy.callerCount, 0);
  assert.equal(call.initialPolicy.callerListEmpty, true);
  assert.equal(call.queuedObservation.policy.callerCount, 1);
  assert.equal(call.queuedObservation.policy.callerListEmpty, false);
  assert.deepEqual(call.finalPolicy, call.initialPolicy);
  assert.equal(call.initialPolicy.memberCount, 0);
  assert.equal(call.finalActiveChannels, 0);
  assert.equal(call.channelNames.length, 2);
  assert(call.channelNames[0].endsWith(";1") && call.channelNames[1].endsWith(";2"));
  assert(call.channelNames.every((name) => name.startsWith("Local/start@isolated-local-queue-proof-")));
  assert.equal(call.queueTimeoutSeconds, 3);
  assert(call.elapsedSeconds >= 3 && call.elapsedSeconds < 25);
  assert.deepEqual(validation.resultVariablesIndependentlyVerified, {
    QUEUESTATUS: "TIMEOUT", QUEUEWAIT_MS: "3000", ANSWEREDTIME_MS: "0", ABANDONED: "TRUE",
  });
  for (const [name, value] of Object.entries(validation.resultVariablesIndependentlyVerified)) {
    assert(call.resultChannelDetails.split("\n").includes(`${name}=${value}`), name);
  }
  assert.equal(validation.ownedContainerRemoved, true);
  assert.equal(validation.processExitCode, 0);
  assert.equal(validation.watchdogExpired, false);
  assert.equal(validation.syntheticCallsTested, true);
  for (const flag of ["sipTested", "mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "existingContainersChanged", "imageRebuilt", "registryPushed", "runtimeApplyAuthorized",
    "redistributionApproved", "licenseClosureComplete", "gateAAcceptanceComplete", "gateCAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
});

test("corrected NSS image startup evidence is exact, hash-bound and isolated", () => {
  const validation = read(`${directory}/image-startup-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const build = read(`${directory}/image-build-validation-nss.json`);
  const payload = read(`${directory}/image-payload-validation-nss.json`);
  const smoke = read(`${directory}/desktop-image-smoke-report.json`);
  const native = read(`${directory}/runtime-bundle-smoke-report-nss.json`);
  assert.equal(preparation.containerStartup.imageId, validation.imageId);
  assert.equal(build.dockerfileCanonicalLfSha256, createHash("sha256")
    .update(bytes(`${directory}/runtime.Dockerfile`).toString("utf8").replace(/\r\n/g, "\n"))
    .digest("hex"));
  for (const record of [build, payload, smoke]) {
    assert.equal(record.imageId, validation.imageId);
    assert.equal(record.bundleManifestSha256, hash(`${directory}/runtime-bundle-manifest-nss.json`));
  }
  assert.equal(smoke.payloadValidationSha256, hash(`${directory}/image-payload-validation-nss.json`));
  assert.equal(smoke.passed, true);
  assert.equal(smoke.ownedContainerRemoved, true);
  assert.equal(smoke.watchdogExpired, false);
  assert.equal(smoke.processExitCode, 0);
  assert.equal(smoke.testCommandAbsent, true);
  assert.deepEqual(smoke.observations, bundleSmoke.observations);
  assert.deepEqual(native.observations, smoke.observations);
  assert.deepEqual(smoke.loadedModules, read(`${directory}/full-module-smoke-report.json`).loadedModules);
  assert.deepEqual(smoke.pjsipEmptyObjectChecks,
    { endpoints: "No objects found.", transports: "No objects found." });
  assert.deepEqual(smoke.isolationSettings, {
    NetworkMode: "none", ReadonlyRootfs: true, Privileged: false,
    Memory: 4294967296, MemorySwap: 4294967296, NanoCpus: 4000000000, PidsLimit: 256,
    capDrop: ["ALL"], securityOpt: ["no-new-privileges:true"], portBindings: {},
  });
  assert.equal(validation.allOwnedSmokeContainersRemoved, true);
  assert.equal(validation.ownedDistributionStopped, true);
  assert(validation.attempts.every((attempt) => attempt.containerRemoved));
  assert.equal(validation.attempts.filter((attempt) => attempt.passed).length, 1);
  for (const flag of ["runtimeApplyAuthorized", "registryPushed", "redistributionApproved",
    "licenseClosureComplete", "callsOrMediaTested", "gateAAcceptanceComplete", "gateCAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
  assert(smoke.diagnostics.length > 0);
  assert(smoke.diagnostics.every((item) => item.stream === "stdout" && item.text ===
    "No ethernet interface found for seeding global EID. You will have to set it manually.\n"));
});

test("NSS runtime closure retains the thirteen installed package files and original compiled outputs", () => {
  const manifest = read(`${directory}/runtime-bundle-manifest-nss.json`);
  const entries = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  assert.equal(entries.size, 389);
  assert.equal(manifest.entries.reduce((sum, item) => sum + item.bytes, 0), 135344626);
  assert.equal(manifest.nssInstalledPackageIntegrityVerified, true);
  assert.equal(Object.keys(manifest.nssRuntimeFiles).length, 13);
  for (const [name, sha256] of Object.entries(manifest.nssRuntimeFiles)) {
    assert.equal(entries.get(`runtime-libs/${name}`).sha256, sha256);
  }
  for (const name of ["libsoftokn3.so", "libsoftokn3.chk", "libfreeblpriv3.so", "libfreeblpriv3.chk"]) {
    assert(entries.has(`runtime-libs/${name}`), name);
  }
  for (const output of read(`${directory}/compile-report-optional-api.json`)
    .profiles.find((profile) => profile.name === "release").outputs) {
    assert.equal(entries.get(output.path).sha256, output.sha256);
  }
  const payload = read(`${directory}/image-payload-validation-nss.json`);
  assert.equal(payload.payloadFilesVerified, 390);
  assert.equal(payload.moduleAliasesVerified, 41);
  assert.equal(payload.allPayloadHashesSizesModesAndOwnershipVerified, true);
  assert.equal(payload.exactNonDirectoryImageInventoryVerified, true);
});

test("built image evidence binds actual inspected payload without implying container execution", () => {
  const build = read(`${directory}/image-build-validation.json`);
  const payload = read(`${directory}/image-payload-validation.json`);
  assert.equal(build.imageId, payload.imageId);
  assert.equal(build.imageId, preparation.localImageBuild.imageId);
  assert.equal(build.bundleManifestSha256, hash(`${directory}/runtime-bundle-manifest.json`));
  assert.equal(payload.bundleManifestSha256, build.bundleManifestSha256);
  assert.equal(build.dockerfileCanonicalLfSha256, createHash("sha256")
    .update(bytes(`${directory}/runtime-initial.Dockerfile`).toString("utf8").replace(/\r\n/g, "\n"))
    .digest("hex"));
  assert.equal(hash(`${directory}/image-payload-validation.json`),
    build.evidence["image-payload-validation.json"].sha256);
  assert.equal(payload.payloadFilesVerified, bundleManifest.entries.length + 1);
  assert.equal(payload.moduleAliasesVerified, 41);
  assert.equal(payload.imageLayersVerified, 3);
  assert.equal(payload.allPayloadHashesSizesModesAndOwnershipVerified, true);
  assert.equal(payload.exactNonDirectoryImageInventoryVerified, true);
  assert.equal(payload.imageConfigurationMatchesRecipe, true);
  assert.equal(build.imageBuilt, true);
  assert.equal(build.hostBinaryExported, true);
  assert.equal(build.imageRuntimeAuthorized, false);
  assert.equal(build.buildPullEnabled, false);
  assert.equal(build.buildNetwork, "none");
  assert.equal(build.ownedDistributionStopped, true);
  assert.equal(build.existingContainersChanged, false);
  assert.equal(build.resourceBoundary.reportedStorageThresholdExceeded, false);
  for (const record of [build, payload]) {
    for (const flag of ["imageRuntimeExecuted", "registryPushed", "redistributionApproved",
      "licenseClosureComplete", "runtimeApplyAuthorized"]) {
      assert.equal(record[flag], false, flag);
    }
  }
});

test("local bundle evidence binds the corrected build and every staged release output", () => {
  assert.equal(bundleValidation.patchSha256, candidate.patchSha256);
  const compiledHash = hash(`${directory}/compile-report-optional-api.json`);
  for (const report of [bundleValidation, bundleManifest, bundleSmoke]) {
    assert.equal(report.compileReportSha256, compiledHash);
  }
  for (const [name, evidence] of Object.entries(bundleValidation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  assert.equal(bundleSmoke.bundleManifestSha256, hash(`${directory}/runtime-bundle-manifest.json`));
  assert.equal(bundleManifest.entries.length, 378);
  assert.equal(new Set(bundleManifest.entries.map((entry) => entry.path)).size, 378);
  assert.equal(bundleManifest.entries.reduce((sum, entry) => sum + entry.bytes, 0), 132821098);
  const entries = new Map(bundleManifest.entries.map((entry) => [entry.path, entry]));
  for (const entry of bundleManifest.entries) {
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    assert.match(entry.mode, /^0o[0-7]{3}$/);
    assert(entry.bytes >= 0 && Number.isSafeInteger(entry.bytes));
    assert(!entry.path.startsWith("/") && !entry.path.split("/").includes(".."));
  }
  const corrected = read(`${directory}/compile-report-optional-api.json`);
  for (const output of corrected.profiles.find((profile) => profile.name === "release").outputs) {
    assert.equal(entries.get(output.path)?.sha256, output.sha256, output.path);
  }
  assert.equal(entries.get("build-records/compile-report.json")?.sha256, compiledHash);
  assert.equal(entries.get("build-records/full-startup-validation.json")?.sha256,
    hash(`${directory}/full-startup-validation.json`));
  assert.equal(entries.get("build-records/queue-policy-v1.patch")?.sha256, candidate.patchSha256);
  assert.equal(entries.get("build-records/dependency-lock.json")?.sha256,
    hash(`${directory}/dependency-lock.json`));
  for (const source of read(`${directory}/source-lock.json`).sources) {
    assert.equal(entries.get(`sources/${source.filename}`)?.sha256, source.sha256);
  }
  for (const file of ["notices/asterisk-LICENSE", "notices/asterisk-COPYING",
    "notices/pjproject-COPYING", "notices/GPL-2", "notices/LGPL-2.1",
    ...Object.values(bundleManifest.dependencyCopyrightFiles)]) {
    assert(entries.has(file), file);
  }
  assert(bundleManifest.entries.every((entry) => !entry.path.startsWith("tests/")));
});

test("bundle startup maps core, exact module set, support and system libraries locally", () => {
  assert.equal(bundleSmoke.passed, true);
  assert.equal(bundleSmoke.allExpectedModulesRunning, true);
  const plan = read(`${directory}/module-plan.json`);
  assert.deepEqual(bundleSmoke.loadedModules, plan.requestedModules.map((name) => `${name}.so`).sort());
  assert.equal(bundleSmoke.allFileBackedMappingsInsideBundle, true);
  const mapped = new Set(bundleSmoke.mappedBundleFiles);
  const entries = new Set(bundleManifest.entries.map((entry) => entry.path));
  for (const file of mapped) assert(entries.has(file), file);
  for (const file of ["main/asterisk", "main/libasteriskpj.so.2", "main/libasteriskssl.so.1",
    ...Object.keys(bundleManifest.systemLibraries).map((name) => `runtime-libs/${name}`)]) {
    assert(mapped.has(file), file);
  }
  for (const file of bundleManifest.entries.filter((entry) =>
    entry.path.endsWith(".so") && !entry.path.startsWith("main/") &&
    !entry.path.startsWith("runtime-gconv/"))) {
    assert(mapped.has(file.path), file.path);
  }
  assert.equal(Object.keys(bundleManifest.systemLibraries).length, 27);
  assert.equal(bundleManifest.localeDataIncluded, true);
  assert.equal(bundleManifest.glibcConversionDataIncluded, true);
  assert(mapped.has("runtime-locale/C.utf8/LC_CTYPE"));
  assert(bundleManifest.entries.some((entry) => entry.path.startsWith("runtime-gconv/")));
  assert.equal(bundleValidation.allPayloadHashesSizesModesAndExactInventoryVerified, true);
  assert.equal(bundleValidation.allReleaseOutputsMatchCorrectedBuild, true);
});

test("bundle smoke preserves exact loaded-policy behavior and disposable cleanup", () => {
  const full = read(`${directory}/full-module-smoke-report.json`);
  assert.deepEqual(bundleSmoke.observations, full.observations);
  assert.deepEqual(bundleSmoke.pjsipEmptyObjectChecks,
    { endpoints: "No objects found.", transports: "No objects found." });
  assert.equal(bundleSmoke.testCommandAbsent, true);
  assert.equal(bundleSmoke.ownedPidGreetingVerified, true);
  assert.equal(bundleSmoke.ownedProcessStopped, true);
  assert.equal(bundleSmoke.processExitCode, 0);
  assert.equal(bundleValidation.noOwnedBundleProcessesOrRuntimeEntriesRemain, true);
});

test("staged payload and successful smoke do not grant redistribution or deployment", () => {
  for (const report of [bundleValidation, bundleManifest, preparation.localRuntimeBundle]) {
    for (const flag of ["runtimeApplyAuthorized", "hostExported",
      "redistributionApproved", "licenseClosureComplete"]) {
      assert.equal(report[flag], false, flag);
    }
  }
  assert.equal(bundleManifest.packagedRuntimeExecuted, false); // Stage-time record; later smoke is separate.
  assert.equal(bundleValidation.containerImageProduced, false);
  assert.equal(bundleValidation.existingPbxOperated, false);
  assert.equal(bundleSmoke.runtimeApplyAuthorized, false);
  assert.equal(preparation.localRuntimeBundle.ownedDistributionStopped, true);
});

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

test("current corrected build restores upstream optional API and binds all new evidence", () => {
  const validation = read(`${directory}/full-startup-validation.json`);
  assert.equal(validation.patchSha256, candidate.patchSha256);
  assert.equal(validation.buildAttempt, preparation.currentValidation.buildAttempt);
  assert.equal(validation.optionalApiEnabledBothProfiles, true);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const corrected = read(`${directory}/compile-report-optional-api.json`);
  for (const profile of corrected.profiles) {
    assert.equal(profile.enabledOptions.includes("OPTIONAL_API"), true);
    assert.equal(profile.outputs.length, profile.name === "instrumented" ? 46 : 44);
  }
  const compiledHash = hash(`${directory}/compile-report-optional-api.json`);
  for (const name of ["native-test-report-optional-api.json",
    "release-smoke-report-optional-api.json", "full-module-smoke-report.json"]) {
    assert.equal(read(`${directory}/${name}`).compileReportSha256, compiledHash);
  }
});

test("corrected instrumented build reran every native definition successfully", () => {
  const current = read(`${directory}/native-test-report-optional-api.json`);
  assert.equal(current.completed, true);
  assert.equal(current.passed, 30);
  assert.equal(current.failed, 0);
  assert.equal(current.allOwnedProcessesStopped, true);
  assert.deepEqual(current.results.map((item) => item.name), candidate.nativeTests);
  assert(current.results.every((item) => item.result === "passed" && item.failure === null));
});

test("full startup requires all forty-one modules running and no PJSIP objects", () => {
  const current = read(`${directory}/full-module-smoke-report.json`);
  const plan = read(`${directory}/module-plan.json`);
  assert.equal(current.passed, true);
  assert.equal(current.allExpectedModulesRunning, true);
  assert.deepEqual(current.loadedModules, plan.requestedModules.map((name) => `${name}.so`).sort());
  assert.equal(current.loadedModules.length, 41);
  assert.deepEqual(current.pjsipEmptyObjectChecks,
    { endpoints: "No objects found.", transports: "No objects found." });
  assert.equal(current.testCommandAbsent, true);
  assert.equal(current.ownedProcessStopped, true);
  assert.equal(current.processExitCode, 0);
  assert.equal(current.runtimeApplyAuthorized, false);
  assert.equal(current.existingPbxOperated, false);
  for (const name of ["full-module-smoke-report.json", "release-smoke-report-optional-api.json"]) {
    const smoke = read(`${directory}/${name}`);
    assert.deepEqual(smoke.observations.map((item) => item.response.objects[0].memberTimeoutSeconds),
      [11, 11, 23, 23, 11]);
    assert.deepEqual(smoke.observations.map((item) => item.response.objects[0].strategy),
      ["ringall", "ringall", "linear", "linear", "ringall"]);
  }
});
