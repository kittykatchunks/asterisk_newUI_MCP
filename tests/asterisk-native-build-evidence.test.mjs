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

test("unanswered SIP runtime binds ringing, correlated cancellation, zero-answer timeout and cleanup", () => {
  const validation = read(`${directory}/sip-unanswered-queue-validation.json`);
  const report = read(`${directory}/sip-unanswered-queue-smoke-report.json`);
  const outcome = report.sipQueueUnanswered;
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  assert.equal(validation.passed, true);
  assert.equal(validation.authorizedUnansweredSipAttempts, 1);
  assert.equal(validation.executedUnansweredSipAttempts, 1);
  assert.equal(validation.executedRevision, "bb3a3dfe470b057ec7d2b77be312bf0cc907db9c");
  assert.equal(report.passed, true);
  assert.equal(report.sipQueueUnansweredRequested, true);
  assert.equal(report.sipQueueAnswerRequested, false);
  assert.equal(report.sipQueueTimeoutRequested, false);
  assert.equal(report.imageId, validation.imageId);
  assert.equal(report.carrierImageId, validation.carrierImageId);
  assert.equal(report.bundleManifestSha256, validation.bundleManifestSha256);
  assert.deepEqual(report.loadedModules, read(`${directory}/desktop-image-smoke-report.json`).loadedModules);
  assert.equal(report.loadedModules.length, 41);
  assert.equal(report.testCommandAbsent, true);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.configuredTimeoutPriority, "app");
  assert.equal(outcome.memberAddedPolicy.memberCount, 1);
  assert.equal(outcome.ringingObservation.policy.callerCount, 1);
  assert.equal(outcome.ringingObservation.policy.memberCount, 1);
  const ringing = outcome.ringingObservation.channels;
  assert.equal(ringing.length, 2);
  const caller = ringing.find((row) => row.name.startsWith("PJSIP/proof-client-"));
  assert.equal(caller.state, "Up");
  assert.equal(caller.application, "Queue");
  assert.equal(caller.data, "proof-queue,r,,,3");
  assert(ringing.some((row) => row.name.startsWith("PJSIP/proof-agent-") && row.state === "Ringing"));
  assert.deepEqual(outcome.cancellation, {
    phase: "agent-cancelled", cancelCode: 200, inviteFinalCode: 487,
    transactionAckSeen: true, agentAnswered: false,
  });
  assert.deepEqual(outcome.resultVariables, {
    QUEUESTATUS: "TIMEOUT", QUEUEWAIT_MS: "3000", ANSWEREDTIME_MS: "0", ABANDONED: "TRUE",
  });
  const result = outcome.resultProgress.at(-1);
  assert.equal(result.channels.length, 1);
  assert.equal(result.channels[0].name, caller.name);
  assert.equal(result.channels[0].state, "Up");
  assert.equal(result.channels[0].application, "Wait");
  assert.equal(result.policy.callerCount, 0);
  assert.match(outcome.resultChannelDetails, /Bridge ID: \(Not bridged\)/);
  assert.match(outcome.completedQueueOutput, /\bC:0\b/);
  assert.match(outcome.completedQueueOutput, /\bA:1\b/);
  assert.match(outcome.completedQueueOutput, /PJSIP\/proof-agent.*has taken no calls/);
  assert.equal(outcome.memberRemoved, true);
  assert.deepEqual(outcome.initialPolicy, outcome.finalPolicy);
  assert.equal(outcome.finalPolicy.memberCount, 0);
  assert.equal(outcome.finalPolicy.callerCount, 0);
  assert.equal(report.registrationPassed, true);
  assert.equal(report.clientReport.passed, true);
  assert.equal(report.clientReport.unansweredQueueRequested, true);
  assert.equal(report.clientReport.answeredQueueRequested, false);
  assert.notEqual(report.clientReport.clientPort, report.clientReport.agentPort);
  assert.deepEqual(report.phases.map((phase) => phase.client.phase), [
    "registered-both", "agent-ringing", "agent-cancelled", "call-complete", "unregistered-both",
  ]);
  assert.deepEqual(report.phases[0].client.contactExpirySeconds, [59, 59]);
  for (const phase of report.phases.slice(0, 4)) {
    assert.deepEqual([...phase.contacts].sort(), [
      `proof-agent/sip:proof-agent@${report.clientReport.clientAddress}:${report.clientReport.agentPort}`,
      `proof-client/sip:proof-client@${report.clientReport.clientAddress}:${report.clientReport.clientPort}`,
    ].sort());
  }
  assert.equal(report.phases[3].client.callerByeCode, 200);
  assert.deepEqual(report.phases[4].contacts, []);
  assert.equal(report.phases[4].client.code, 200);
  assert.deepEqual(report.preflightClientStopped, { exitCode: 0, oomKilled: false });
  assert.deepEqual(report.processExitCodes, { pbx: 0, client: 0 });
  assert.deepEqual(report.initialInventory, report.finalInventory);
  assert.equal(report.finalInventory.containers.length, 4);
  assert(report.finalInventory.containers.every((row) => row.endsWith(" exited")));
  assert.deepEqual(report.initialBridge, report.finalBridge);
  assert.equal(report.ownedResourcesRemoved, true);
  assert.equal(report.credentialFilesRemoved, true);
  assert.equal(report.watchdogExpired, false);
  assert.equal(report.elapsedSeconds, 22.343);
  assert.equal(report.mediaTested, false);
  assert.equal(report.mediaPassed, false);
  for (const [name, digest] of Object.entries(report.toolCanonicalLfHashes)) {
    const canonical = createHash("sha256").update(bytes(name.replaceAll("\\", "/")).toString().replaceAll("\r\n", "\n")).digest("hex");
    assert.equal(canonical, digest, name);
  }
  for (const flag of ["mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "imageRebuilt", "dependenciesInstalled", "runtimeApplyAuthorized",
    "gateAAcceptanceComplete", "gateCAuthorized", "redistributionApproved",
    "licenseClosureComplete", "furtherRuntimeAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
  assert.equal(preparation.sipUnansweredExecution.passed, true);
});

test("registered SIP no-answer preparation remains offline and requires explicit isolated opt-in", () => {
  const record = read(`${directory}/sip-unanswered-preparation.json`);
  assert.equal(record.stage, "synthetic-sip-unanswered-queue-implemented-offline-only");
  assert.equal(record.runtimeAttemptsAuthorized, 0);
  assert.equal(record.runtimeAttemptsExecuted, 0);
  assert.equal(record.additionalApprovalFlagRequired, "--approve-sip-queue-unanswered");
  assert.equal(record.baseApprovalFlagAlsoRequired, "--approve-isolated-sip-rtp-proof");
  assert.equal(record.defaultEchoBehaviorRetained, true);
  assert.equal(record.queueModesMutuallyExclusive, true);
  assert.deepEqual(record.implementation.identities, ["proof-client", "proof-agent"]);
  assert.equal(record.implementation.distinctPerRunSecretsRequired, true);
  assert.equal(record.implementation.queueSeconds, 3);
  assert.equal(record.implementation.timeoutpriority, "app");
  assert.equal(record.implementation.resultHoldSeconds, 10);
  assert.equal(record.implementation.rtpVerified, false);
  assert.equal(record.implementation.humanAnsweringTested, false);
  assert.equal(record.offlineValidation.pythonTestsPassed, 91);
  assert.equal(record.offlineValidation.sourceEvidenceTestsPassed, 39);
  assert.equal(preparation.sipUnansweredPreparation.runtimePassed, false);
  assert.equal(preparation.sipUnansweredPreparation.runtimeAttemptsAuthorized, 0);
  assert.equal(preparation.sipUnansweredPreparation.runtimeAttemptsExecuted, 0);
  assert.equal(preparation.sipUnansweredPreparation.newNetworkOrContainerStarted, false);
  assert.equal(read(`${directory}/${record.latestExecutedQueueEvidence}`).passed, true);
  for (const flag of ["runtimeExecuted", "runtimePassed", "containerStartupAuthorized",
    "networkCreationAuthorized", "sipTrafficAuthorized", "runtimeApplyAuthorized",
    "gateAAcceptanceComplete", "gateCAuthorized", "redistributionApproved"]) {
    assert.equal(record[flag], false, flag);
  }
  const entrypoint = bytes(`${directory}/${record.entrypoint}`).toString();
  assert.match(entrypoint, /parser\.add_argument\("--approve-sip-queue-unanswered", action="store_true"\)/);
  assert.match(entrypoint, /if sum\(\(queue_timeout, queue_answer, queue_unanswered\)\) > 1:/);
  assert.match(entrypoint, /member_fixture = runtime_sip_unanswered if queue_unanswered else runtime_sip_answer/);
  const agent = bytes("tests/sip_queue_answer_client.py").toString();
  assert.match(agent, /487 Request Terminated/);
  assert.match(agent, /headers\["via"\] == self\.dialog\["via"\]/);
  assert.match(agent, /No-answer agent must not answer/);
});

test("answered SIP queue runtime binds dual registrations, bridged legs, measured continuation and cleanup", () => {
  const validation = read(`${directory}/sip-answered-queue-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const report = read(`${directory}/sip-answered-queue-smoke-report.json`);
  const answer = report.sipQueueAnswer;
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  assert.equal(validation.passed, true);
  assert.equal(report.passed, true);
  assert.equal(report.sipQueueAnswerRequested, true);
  assert.equal(report.sipQueueTimeoutRequested, false);
  assert.equal(report.imageId, validation.imageId);
  assert.equal(report.bundleManifestSha256, validation.bundleManifestSha256);
  assert.deepEqual(report.loadedModules, startup.loadedModules);
  assert.equal(report.testCommandAbsent, true);
  assert.equal(answer.passed, true);
  assert.equal(answer.memberAddedPolicy.memberCount, 1);
  assert.equal(answer["agent-ringing"].policy.callerCount, 1);
  const ringing = answer["agent-ringing"].channels;
  assert.equal(ringing.length, 2);
  assert(ringing.some((row) => row.name.startsWith("PJSIP/proof-agent-") && row.state === "Ringing"));
  assert(ringing.some((row) => row.name.startsWith("PJSIP/proof-client-") && row.application === "Queue"));
  assert.equal(answer["agent-answered"].channels.length, 2);
  assert(answer["agent-answered"].channels.every((row) => row.state === "Up"));
  assert.match(answer.bridgeId, /^[a-f0-9-]{36}$/);
  assert.deepEqual(answer.resultVariables, {
    QUEUESTATUS: "CONTINUE", ANSWEREDTIME_MS: "5182", DIALEDTIME_MS: "6448",
  });
  assert(Number(answer.resultVariables.ANSWEREDTIME_MS) >= 3500);
  assert(Number(answer.resultVariables.ANSWEREDTIME_MS) < 7000);
  assert.match(answer.completedQueueOutput, /\bC:1\b/);
  assert.match(answer.completedQueueOutput, /\bA:0\b/);
  assert.match(answer.completedQueueOutput, /PJSIP\/proof-agent.*has taken 1 calls/);
  assert.equal(answer.memberRemoved, true);
  assert.deepEqual(answer.initialPolicy, answer.finalPolicy);
  assert.equal(answer.finalPolicy.memberCount, 0);
  assert.equal(answer.finalPolicy.callerCount, 0);
  assert.equal(report.registrationPassed, true);
  assert.equal(report.clientReport.passed, true);
  assert.equal(report.clientReport.answeredQueueRequested, true);
  assert.deepEqual(report.phases.map((phase) => phase.client.phase), [
    "registered-both", "agent-ringing", "agent-answered", "agent-ended", "call-complete", "unregistered-both",
  ]);
  for (const phase of report.phases.slice(0, 5)) {
    assert.equal(phase.contacts.length, 2);
    assert(phase.contacts.includes(`proof-client/sip:proof-client@${report.clientReport.clientAddress}:${report.clientReport.clientPort}`));
    assert(phase.contacts.includes(`proof-agent/sip:proof-agent@${report.clientReport.clientAddress}:${report.clientReport.agentPort}`));
  }
  assert.notEqual(report.clientReport.clientPort, report.clientReport.agentPort);
  assert.equal(report.phases[2].client.ackSeen, true);
  assert.equal(report.phases[3].client.byeCode, 200);
  assert.equal(report.phases[4].client.callerByeCode, 200);
  assert.deepEqual(report.phases[5].contacts, []);
  assert.equal(report.phases[5].client.code, 200);
  assert.deepEqual(report.preflightClientStopped, { exitCode: 0, oomKilled: false });
  assert.deepEqual(report.processExitCodes, { pbx: 0, client: 0 });
  assert.deepEqual(report.initialInventory, report.finalInventory);
  assert.deepEqual(report.initialBridge, report.finalBridge);
  assert.equal(report.ownedResourcesRemoved, true);
  assert.equal(report.credentialFilesRemoved, true);
  assert.equal(report.watchdogExpired, false);
  assert.equal(report.elapsedSeconds, 26.61);
  for (const [name, digest] of Object.entries(report.toolCanonicalLfHashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/, name);
    if (name.endsWith("smoke-desktop.py")) {
      const canonical = createHash("sha256").update(bytes(name.replaceAll("\\", "/")).toString().replaceAll("\r\n", "\n")).digest("hex");
      assert.equal(canonical, digest, name);
    }
  }
  for (const flag of ["mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "runtimeApplyAuthorized", "gateAAcceptanceComplete", "gateCAuthorized",
    "redistributionApproved", "licenseClosureComplete", "furtherRuntimeAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
  assert.equal(report.mediaTested, false);
  assert.equal(report.mediaPassed, false);
  assert.equal(preparation.sipAnsweredExecution.passed, true);
});

test("answered SIP preparation retains offline-only authority and distinct synthetic identities", () => {
  const record = read(`${directory}/sip-answer-preparation.json`);
  assert.equal(record.stage, "synthetic-sip-answered-queue-implemented-offline-only");
  assert.equal(record.runtimeAttemptsAuthorized, 0);
  assert.equal(record.runtimeAttemptsExecuted, 0);
  assert.deepEqual(record.implementation.identities, ["proof-client", "proof-agent"]);
  assert.equal(record.implementation.distinctPerRunSecretsRequired, true);
  assert.equal(record.implementation.member, "PJSIP/proof-agent");
  assert.equal(record.implementation.syntheticAgentHoldSeconds, 4);
  assert.equal(record.implementation.rtpVerified, false);
  assert.equal(record.defaultEchoBehaviorRetained, true);
  assert.equal(record.queueModesMutuallyExclusive, true);
  for (const flag of ["runtimeExecuted", "runtimePassed", "containerStartupAuthorized",
    "networkCreationAuthorized", "sipTrafficAuthorized", "runtimeApplyAuthorized",
    "gateAAcceptanceComplete", "gateCAuthorized", "redistributionApproved"]) {
    assert.equal(record[flag], false, flag);
  }
  assert.equal(preparation.sipAnsweredPreparation.runtimePassed, false);
  assert.equal(read(`${directory}/${record.latestExecutedQueueEvidence}`).passed, true);
});

test("SIP empty-queue runtime binds one queued caller, exact timeout and authenticated cleanup", () => {
  const validation = read(`${directory}/sip-queue-timeout-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const report = read(`${directory}/sip-queue-timeout-smoke-report.json`);
  const queue = report.sipQueueTimeout;
  assert.equal(validation.passed, true);
  assert.equal(report.passed, true);
  assert.equal(report.sipQueueTimeoutRequested, true);
  assert.equal(report.imageId, validation.imageId);
  assert.equal(report.bundleManifestSha256, validation.bundleManifestSha256);
  assert.equal(report.loadedModules.length, 41);
  assert.equal(report.testCommandAbsent, true);
  assert.equal(queue.passed, true);
  assert.match(queue.channelName, /^PJSIP\/proof-client-[a-f0-9]+$/);
  assert.equal(queue.queuedPolicy.memberCount, 0);
  assert.equal(queue.queuedPolicy.callerCount, 1);
  assert.equal(queue.queuedPolicy.callerListEmpty, false);
  assert.equal(queue.resultPolicy.callerCount, 0);
  assert.equal(queue.resultPolicy.callerListEmpty, true);
  assert.deepEqual(queue.resultVariables, {
    QUEUESTATUS: "TIMEOUT", QUEUEWAIT_MS: "3000", ANSWEREDTIME_MS: "0", ABANDONED: "TRUE",
  });
  assert.equal(queue.progress.length, 8);
  assert.deepEqual(queue.progress, report.sipQueueProgress);
  assert(queue.progress.some((item) => item.channel.application === "Queue" && item.policy.callerCount === 1));
  assert.equal(queue.progress.at(-1).channel.application, "Wait");
  assert.equal(new Set(queue.progress.map((item) => item.channel.name)).size, 1);
  assert.equal(queue.mediaVerified, false);
  assert.deepEqual(report.phases.map((item) => item.client.phase), [
    "wrong-register", "registered", "wrong-invite", "queue-started", "queue-complete", "unregistered",
  ]);
  assert.equal(report.phases[0].client.code, 401);
  assert.equal(report.phases[1].client.code, 200);
  assert.equal(report.phases[2].client.code, 401);
  assert.equal(report.phases[3].client.ackSent, true);
  assert.equal(report.phases[4].client.byeCode, 200);
  assert.equal(report.phases[5].client.code, 200);
  assert.deepEqual(report.phases[5].contacts, []);
  assert.equal(report.registrationPassed, true);
  assert.equal(report.clientReport.passed, true);
  assert.equal(report.clientReport.queueTimeoutRequested, true);
  assert.equal(report.mediaTested, false);
  assert.equal(report.mediaPassed, false);
  assert.deepEqual(report.preflightClientStopped, { exitCode: 0, oomKilled: false });
  assert.deepEqual(report.processExitCodes, { pbx: 0, client: 0 });
  assert.deepEqual(report.initialInventory, report.finalInventory);
  assert.deepEqual(report.initialBridge, report.finalBridge);
  assert.equal(report.ownedResourcesRemoved, true);
  assert.equal(report.credentialFilesRemoved, true);
  assert.equal(report.watchdogExpired, false);
  assert.equal(report.elapsedSeconds, 19.546);
  for (const [name, digest] of Object.entries(report.toolCanonicalLfHashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/);
  }
  for (const flag of ["mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "runtimeApplyAuthorized", "gateAAcceptanceComplete", "gateCAuthorized",
    "redistributionApproved", "licenseClosureComplete", "furtherRuntimeAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
  assert.equal(preparation.sipQueueExecution.passed, true);
});

test("SIP-to-queue preparation stays offline and cannot promote echo evidence to queue runtime success", () => {
  const record = read(`${directory}/sip-queue-preparation.json`);
  assert.equal(record.stage, "sip-to-empty-queue-timeout-implemented-offline-only");
  assert.equal(record.runtimeAttemptsAuthorized, 0);
  assert.equal(record.runtimeAttemptsExecuted, 0);
  for (const flag of ["runtimeExecuted", "containerStartupAuthorized", "networkCreationAuthorized",
    "sipTrafficAuthorized", "runtimeApplyAuthorized", "gateAAcceptanceComplete", "gateCAuthorized",
    "redistributionApproved"]) {
    assert.equal(record[flag], false, flag);
  }
  assert.equal(record.offlineValidation.runtimeAcceptancePassed, false);
  assert.equal(record.implementation.queueSeconds, 3);
  assert.equal(record.implementation.observerDeadlineSeconds, 8);
  assert.equal(record.implementation.progressSampleLimit, 64);
  assert.equal(record.implementation.mediaEchoTestedByQueueMode, false);
  assert.equal(preparation.sipQueuePreparation.runtimePassed, false);
  assert.equal(preparation.sipRegistrationRtpExecution.passed, true);
  assert.equal(read(`${directory}/${record.latestExecutedSipEvidence}`).passed, true);
});

test("corrected SIP proof binds registration, authenticated call, exact RTP threshold and complete cleanup", () => {
  const validation = read(`${directory}/sip-registration-rtp-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const report = read(`${directory}/sip-proof-attempt-3-report.json`);
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  assert.equal(validation.passed, true);
  assert.equal(report.passed, true);
  assert.equal(validation.totalProtocolAttempts, 3);
  assert.equal(validation.attemptsExecutedThisStep, 1);
  assert.equal(validation.imageId, startup.imageId);
  assert.equal(report.imageId, validation.imageId);
  assert.equal(report.bundleManifestSha256, validation.bundleManifestSha256);
  assert.deepEqual(report.loadedModules, startup.loadedModules);
  assert.equal(report.testCommandAbsent, true);
  assert.deepEqual(report.preflightClientStopped, { exitCode: 0, oomKilled: false });
  assert.deepEqual(report.processExitCodes, { pbx: 0, client: 0 });
  assert.equal(report.registrationPassed, true);
  assert.equal(report.contactRegistrationPassed, true);
  assert.equal(report.mediaPassed, true);
  assert.equal(report.mediaTested, true);
  assert.equal(report.clientReport.passed, true);
  assert.equal(report.clientReport.registrationPassed, true);
  assert.deepEqual(report.phases.map((item) => item.client), [
    { phase: "wrong-register", code: 401 },
    { phase: "registered", code: 200, contactExpirySeconds: 59 },
    { phase: "wrong-invite", code: 401 },
    { phase: "echo-complete", inviteCode: 200, byeCode: 200 },
    { phase: "unregistered", code: 200 },
  ]);
  assert.deepEqual(report.phases[0].contacts, []);
  assert.deepEqual(report.phases[4].contacts, []);
  for (const phase of report.phases.slice(1, 4)) {
    assert.equal(phase.contacts.length, 1);
    assert(phase.contacts[0].includes(`proof-client@${report.clientReport.clientAddress}:${report.clientReport.clientPort} `));
  }
  assert.equal(report.rtp.sentDistinctFrames, 100);
  assert.equal(report.rtp.echoedDistinctFrames, 100);
  assert(report.rtp.echoedDistinctFrames >= validation.acceptance.requiredEchoedDistinctFrames);
  assert.equal(report.rtp.codec, "PCMU/8000");
  assert(report.rtp.pbxMediaPort >= 10000 && report.rtp.pbxMediaPort <= 10100);
  assert.deepEqual(report.initialBridge, report.finalBridge);
  assert.deepEqual(report.initialInventory, report.finalInventory);
  assert.equal(report.networkSettings.internal, true);
  assert.equal(report.networkSettings.publishedPorts, 0);
  assert.equal(report.ownedResourcesRemoved, true);
  assert.equal(report.credentialFilesRemoved, true);
  assert.equal(report.watchdogExpired, false);
  assert.equal(report.elapsedSeconds, 13.969);
  for (const [name, digest] of Object.entries(report.toolCanonicalLfHashes)) {
    assert.match(digest, /^[a-f0-9]{64}$/, name);
    if (name === "local\\asterisk-build\\smoke-desktop.py") {
      const canonical = createHash("sha256").update(bytes(name.replaceAll("\\", "/")).toString().replaceAll("\r\n", "\n")).digest("hex");
      assert.equal(canonical, digest, name);
    }
  }
  for (const flag of ["runtimeApplyAuthorized", "gateCAuthorized", "redistributionApproved"]) {
    assert.equal(report[flag], false, flag);
    assert.equal(validation[flag], false, flag);
  }
  assert.equal(validation.gateAAcceptanceComplete, false);
  assert.equal(validation.furtherRuntimeAuthorized, false);
  assert.equal(preparation.sipRegistrationRtpExecution.passed, true);
});

test("second SIP diagnostic proves header-count bug and stable warmed bridge without promoting runtime acceptance", () => {
  const validation = read(`${directory}/sip-diagnostic-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const report = read(`${directory}/sip-proof-attempt-2-report.json`);
  assert.equal(report.passed, false);
  assert.equal(validation.passed, false);
  assert.equal(validation.totalProtocolAttempts, 2);
  assert.equal(validation.retryAuthorized, false);
  assert.equal(report.imageId, validation.imageId);
  assert.equal(report.loadedModules.length, 41);
  assert.equal(report.pythonPreflightPassed, true);
  assert.deepEqual(report.preflightClientStopped, { exitCode: 137, oomKilled: false });
  assert.deepEqual(report.initialBridge, report.finalBridge);
  assert.deepEqual(report.initialInventory, report.finalInventory);
  assert.notDeepEqual(report.beforePreflightInventory.networks, report.initialInventory.networks);
  assert.deepEqual(report.beforePreflightInventory.containers, report.initialInventory.containers);
  assert.equal(report.lastClientProgress.phases[1].code, 200);
  assert.equal(report.lastClientProgress.phases[1].contactExpirySeconds, 59);
  const contact = report.cliObservations.at(-1).output;
  assert(contact.includes(`proof-client/sip:proof-client@${report.lastClientProgress.clientAddress}:${report.lastClientProgress.clientPort} `));
  assert.match(contact, /Objects found: 1/);
  const legacyRows = contact.split("\n").filter((line) => /^\s*Contact:\s+(?!<)/.test(line));
  assert.equal(legacyRows.length, 2);
  assert.equal(validation.diagnosis.attemptTwoRootCauseProven, true);
  assert.equal(validation.diagnosis.attemptOneRootCauseProven, false);
  assert.equal(report.phases.length, 1);
  assert.equal(report.mediaTested, false);
  assert.equal(report.registrationPassed, false);
  assert.equal(report.ownedResourcesRemoved, true);
  assert.equal(report.credentialFilesRemoved, true);
  assert.equal(report.watchdogExpired, false);
  assert.equal(report.elapsedSeconds, 25.5);
  assert.equal(report.cleanupFailure, undefined);
  for (const flag of ["runtimeApplyAuthorized", "gateCAuthorized", "redistributionApproved"]) {
    assert.equal(report[flag], false);
    assert.equal(validation[flag], false);
  }
});

test("read-only bridge follow-up binds engine wake timeline without granting retry or changing failed evidence", () => {
  const investigation = read(`${directory}/sip-bridge-investigation.json`);
  assert.equal(hash(`${directory}/sip-proof-attempt-1-report.json`), investigation.originalAttemptReportSha256);
  const report = read(`${directory}/sip-proof-attempt-1-report.json`);
  assert.equal(investigation.runtimeAttemptsAdded, 0);
  assert.equal(investigation.findings.engineWakeLogged, true);
  assert.match(investigation.selectedHostLogLines[0], /idle -> busy.*networks\/create/);
  const bridge = investigation.currentBridgeObservation;
  assert(report.finalInventory.networks.includes(`${bridge.id} bridge`));
  const starting = investigation.selectedHostLogLines[2].slice(1, 31);
  const running = investigation.selectedHostLogLines[3].slice(1, 31);
  assert(starting < bridge.created && bridge.created < running);
  assert.equal(bridge.attachedContainerCount, 0);
  for (const flag of ["retryAuthorized", "networkCreatedDuringInvestigation",
    "containerStartedDuringInvestigation", "dockerSettingsChanged", "foreignResourcesRepaired",
    "runtimeApplyAuthorized", "gateCAuthorized"]) {
    assert.equal(investigation[flag], false, flag);
  }
  assert.equal(report.passed, false);
});

test("failed SIP attempt preserves partial registration, unproven discrepancies and cleanup without success authority", () => {
  const validation = read(`${directory}/sip-proof-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const report = read(`${directory}/sip-proof-attempt-1-report.json`);
  const progress = read(`${directory}/sip-proof-attempt-1-registered.json`);
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  assert.equal(validation.executedAttempts, 1);
  assert.equal(validation.retryAuthorized, false);
  assert.equal(validation.passed, false);
  assert.equal(report.passed, false);
  assert.equal(report.imageId, startup.imageId);
  assert.equal(validation.imageId, report.imageId);
  assert.equal(validation.bundleManifestSha256, report.bundleManifestSha256);
  assert.deepEqual(report.loadedModules, startup.loadedModules);
  assert.equal(report.networkSettings.internal, true);
  assert.equal(report.networkSettings.publishedPorts, 0);
  assert.equal(report.phases[0].client.code, 401);
  assert.deepEqual(report.phases[0].contacts, []);
  assert.equal(report.phases.length, 1);
  assert.deepEqual(progress.phases[1], { phase: "registered", code: 200, contactExpirySeconds: 59 });
  assert.equal(report.registrationPassed, false);
  assert.equal(progress.registrationPassed, false);
  assert.equal(report.mediaTested, false);
  assert.equal(report.mediaPassed, false);
  assert.equal(validation.outcomes.inviteExecuted, false);
  assert.equal(validation.outcomes.unregistrationExecuted, false);
  assert.match(report.failure, /Dynamic contact/);
  assert.match(report.cleanupFailure, /inventory changed/);
  assert.equal(validation.failure.primaryRootCauseProven, false);
  assert.equal(validation.failure.secondaryRootCauseProven, false);
  assert.deepEqual(report.initialInventory.containers, report.finalInventory.containers);
  const networks = (inventory) => Object.fromEntries(inventory.networks.map((row) => {
    const [id, name] = row.split(" ");
    return [name, id];
  }));
  const initial = networks(report.initialInventory);
  const final = networks(report.finalInventory);
  assert.notEqual(initial.bridge, final.bridge);
  delete initial.bridge;
  delete final.bridge;
  assert.deepEqual(initial, final);
  for (const flag of ["ownedContainersRemoved", "ownedResourcesRemoved", "credentialFilesRemoved"]) {
    assert.equal(report[flag], true, flag);
  }
  for (const flag of ["runtimeApplyAuthorized", "gateCAuthorized", "redistributionApproved"]) {
    assert.equal(report[flag], false, flag);
  }
  for (const file of ["local/asterisk-build/smoke-desktop.py"]) {
    const canonical = createHash("sha256").update(bytes(file).toString().replaceAll("\r\n", "\n")).digest("hex");
    assert.equal(report.toolCanonicalLfHashes[file.replaceAll("/", "\\")], canonical, file);
  }
  assert.equal(preparation.sipProofExecution.executedAttempts, 1);
  assert.equal(preparation.sipProofExecution.retryAuthorized, false);
});

test("unanswered-member proof binds attempted ringing, no answer, timeout and complete restoration", () => {
  const validation = read(`${directory}/synthetic-unanswered-call-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const smoke = read(`${directory}/synthetic-unanswered-call-smoke-report.json`);
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  const call = smoke.syntheticUnansweredCall;
  assert.equal(validation.imageId, startup.imageId);
  assert.equal(smoke.imageId, validation.imageId);
  assert.equal(smoke.bundleManifestSha256, startup.bundleManifestSha256);
  assert.equal(validation.passed, true);
  assert.equal(smoke.passed, true);
  assert.equal(smoke.syntheticUnansweredCallRequested, true);
  assert.equal(smoke.syntheticAnsweredCallRequested, false);
  assert.equal(smoke.syntheticLocalCallRequested, false);
  assert.deepEqual(smoke.loadedModules, startup.loadedModules);
  assert.deepEqual(smoke.observations, startup.observations);
  assert.deepEqual(smoke.isolationSettings, startup.isolationSettings);
  assert.equal(call.passed, true);
  assert.deepEqual(call.resultVariables, {
    QUEUESTATUS: "TIMEOUT", QUEUEWAIT_MS: "3000", ANSWEREDTIME_MS: "0", ABANDONED: "TRUE",
  });
  assert.equal(validation.queueWaitMilliseconds, 3000);
  assert.equal(validation.answeredMilliseconds, 0);
  assert.equal(call.memberAddedPolicy.memberCount, 1);
  assert.equal(call.queuedObservation.callerCount, 1);
  assert.equal(call.queuedObservation.callerListEmpty, false);
  assert.equal(call.channelNames.length, 4);
  assert.equal(call.channelNames.filter((name) => name.startsWith("Local/member@")).length, 2);
  assert.equal(call.channelNames.filter((name) => name.startsWith("Local/start@")).length, 2);
  assert.equal(call.unansweredMemberObservation.application, "Wait");
  assert.equal(call.unansweredMemberObservation.data, "20");
  assert.match(call.completedQueueOutput, /\bC:0\b/);
  assert.match(call.completedQueueOutput, /\bA:1\b/);
  assert.match(call.completedQueueOutput, /has taken no calls/);
  assert.match(call.completedQueueOutput, /No Callers/);
  assert.equal(call.memberRemoved, true);
  assert.deepEqual(call.finalPolicy, call.initialPolicy);
  assert.equal(call.finalPolicy.memberCount, 0);
  assert.equal(call.finalPolicy.callerCount, 0);
  assert.equal(call.finalActiveChannels, 0);
  assert.equal(call.timeoutPriority, "app");
  assert.equal(smoke.ownedContainerRemoved, true);
  assert.equal(smoke.processExitCode, 0);
  assert.equal(smoke.watchdogExpired, false);
  assert(smoke.syntheticUnansweredProgress.some((item) => item.resultChannelDetails));
  assert.equal(validation.failedAttempt.containerRemoved, true);
  for (const flag of ["sipTested", "mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "existingContainersChanged", "imageRebuilt", "registryPushed", "runtimeApplyAuthorized",
    "redistributionApproved", "licenseClosureComplete", "gateAAcceptanceComplete", "gateCAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
});

test("answered-member proof binds successful continuation, measured answer and complete restoration", () => {
  const validation = read(`${directory}/synthetic-answered-call-validation.json`);
  for (const [name, evidence] of Object.entries(validation.evidence)) {
    assert.equal(hash(`${directory}/${name}`), evidence.sha256, name);
  }
  const smoke = read(`${directory}/synthetic-answered-call-smoke-report.json`);
  const startup = read(`${directory}/desktop-image-smoke-report.json`);
  const call = smoke.syntheticAnsweredCall;
  assert.equal(validation.imageId, startup.imageId);
  assert.equal(smoke.imageId, validation.imageId);
  assert.equal(validation.passed, true);
  assert.equal(smoke.passed, true);
  assert.equal(smoke.syntheticAnsweredCallRequested, true);
  assert.equal(smoke.syntheticLocalCallRequested, false);
  assert.deepEqual(smoke.loadedModules, startup.loadedModules);
  assert.deepEqual(smoke.observations, startup.observations);
  assert.deepEqual(smoke.isolationSettings, startup.isolationSettings);
  assert.equal(call.passed, true);
  assert.equal(call.resultVariables.QUEUESTATUS, "CONTINUE");
  const answered = Number(call.resultVariables.ANSWEREDTIME_MS);
  assert(answered >= 3500 && answered < 7000);
  assert.equal(answered, validation.answeredMilliseconds);
  assert.equal(Number(call.resultVariables.DIALEDTIME_MS), validation.dialedMilliseconds);
  assert(validation.dialedMilliseconds >= answered);
  assert.equal(call.memberAddedPolicy.memberCount, 1);
  assert.equal(call.queuedObservation.callerCount, 1);
  assert.equal(call.queuedObservation.callerListEmpty, false);
  assert.equal(call.channelNames.length, 4);
  assert.equal(call.channelNames.filter((name) => name.startsWith("Local/member@")).length, 2);
  assert.equal(call.channelNames.filter((name) => name.startsWith("Local/start@")).length, 2);
  assert.equal(call.answeredMemberObservation.data, "4");
  assert.match(call.completedQueueOutput, /\bC:1\b/);
  assert.match(call.completedQueueOutput, /has taken 1 calls/);
  assert.match(call.completedQueueOutput, /No Callers/);
  assert.equal(call.memberRemoved, true);
  assert.deepEqual(call.finalPolicy, call.initialPolicy);
  assert.equal(call.finalPolicy.memberCount, 0);
  assert.equal(call.finalPolicy.callerCount, 0);
  assert.equal(call.finalActiveChannels, 0);
  assert.equal(smoke.ownedContainerRemoved, true);
  assert.equal(smoke.processExitCode, 0);
  assert.equal(smoke.watchdogExpired, false);
  assert.equal(validation.failedAttempt.containerRemoved, true);
  for (const flag of ["sipTested", "mediaTested", "humanAnsweringTested", "existingPbxOperated",
    "existingContainersChanged", "imageRebuilt", "registryPushed", "runtimeApplyAuthorized",
    "redistributionApproved", "licenseClosureComplete", "gateAAcceptanceComplete", "gateCAuthorized"]) {
    assert.equal(validation[flag], false, flag);
  }
});

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
