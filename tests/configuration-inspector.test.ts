import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CONFIGURATION_COMPILER, configurationHash, configurationNamespace } from "../src/configuration-model.ts";
import { CONFIGURATION_FILES, CONFIGURATION_PROOF_IMAGE, CONFIGURATION_PROOF_REPOSITORY_DIGEST, CONFIGURATION_PROOF_LABEL, EMPTY_PROOF_DIALPLAN, EMPTY_PROOF_QUEUE,
  ConfigurationInspectionUnavailable, inspectConfigurationBinding, parseConfigurationBinding, parseConfigurationDialplan,
  readConfigurationBinding, writeConfigurationBinding, type ConfigurationBinding, type ConfigurationInspectionTransport } from "../src/configuration-inspector.ts";

const scope = { customer: "customer-a", runtime: "runtime-a" };
const binding: ConfigurationBinding = {
  version: 1, baseline: "empty-owned-proof-v1", compiler: CONFIGURATION_COMPILER, ...scope,
  namespace: configurationNamespace(scope), project: "asterisk-inspection-abc123", service: "customer-a",
  containerId: "a".repeat(64), imageId: `sha256:${"b".repeat(64)}`, startedAt: "2026-10-25T11:00:00.123456789Z",
  startTicks: "12345", mountSource: "/trusted/bootstrap/customer-a",
  files: Object.fromEntries(CONFIGURATION_FILES.map((name) => [name, configurationHash(name.startsWith("cp-") ? "" : name)])),
  createdAt: "2026-10-25T11:00:01.000Z", operator: "fixture-operator", reason: "Explicit offline fixture bootstrap",
};
function dialplan() {
  const contexts = [...new Set(EMPTY_PROOF_DIALPLAN.map((p) => p.context))];
  const lines: string[] = [];
  for (const context of contexts) {
    lines.push(`[ Context '${context}' created by 'pbx_config' ]`);
    const extensions = [...new Set(EMPTY_PROOF_DIALPLAN.filter((p) => p.context === context).map((p) => p.extension))];
    for (const extension of extensions) {
      for (const p of EMPTY_PROOF_DIALPLAN.filter((p) => p.context === context && p.extension === extension).sort((a, b) => a.priority - b.priority)) {
        lines.push(`  ${p.priority === 1 ? `'${extension}' => ` : ""}${p.priority}. ${p.application}(${p.data}) [${p.source}:${p.priority}]`);
      }
    }
  }
  return lines.join("\n") + "\n-= 4 extensions (18 priorities) in 2 contexts. =-\n";
}
function snapshot() {
  return { startTicks: binding.startTicks, endTicks: binding.startTicks, files: { ...binding.files }, endFiles: { ...binding.files },
    dialplan: dialplan(), queues: EMPTY_PROOF_QUEUE,
    uuid: "Module Description Use Count Status Support Level\nfunc_uuid.so UUID generation dialplan function 0 Running extended\n1 modules loaded",
    channels: "0 active channels\n0 active calls\n0 calls processed" };
}
function metadata() {
  return { Id: binding.containerId, Image: binding.imageId, Config: { Image: CONFIGURATION_PROOF_IMAGE, Labels: {
    "com.docker.compose.project": binding.project, "com.docker.compose.service": binding.service,
    "io.asterisk.configuration-proof": CONFIGURATION_PROOF_LABEL,
  } }, State: { Running: true, StartedAt: binding.startedAt }, HostConfig: { PortBindings: {} },
  Mounts: [{ Destination: "/etc/asterisk", Source: binding.mountSource, Type: "bind", RW: false }] };
}
function transport(sample = snapshot(), meta: unknown = metadata()) {
  const calls: string[][] = [];
  const read: ConfigurationInspectionTransport = async (args) => {
    calls.push(args);
    if (args[0] === "inspect") return JSON.stringify([meta]);
    if (args[0] === "image") return JSON.stringify([{ Id: binding.imageId, RepoDigests: [CONFIGURATION_PROOF_REPOSITORY_DIGEST] }]);
    assert.equal(args[0], "exec"); assert.equal(args[1], binding.containerId);
    assert.deepEqual(args.slice(2, 5), ["python3", "-B", "-c"]); assert.equal(args.length, 6);
    return JSON.stringify(sample);
  };
  return { calls, read };
}
async function fixture(action: (directory: string) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "configuration-inspector-"));
  try { await action(dir); } finally { await rm(dir, { recursive: true }); }
}

test("CIU-01: exact known empty loaded inventory is parsed, compared and never represented as publication or apply readiness", async () => {
  assert.deepEqual(parseConfigurationDialplan(dialplan()), EMPTY_PROOF_DIALPLAN);
  const fake = transport(), report = await inspectConfigurationBinding(binding, scope, fake.read);
  assert.equal(report.status, "empty-baseline-observed"); assert.equal(report.baseRevision, 0);
  assert.equal(report.publicationVerified, false); assert.equal(report.executorEnabled, false);
  assert.equal(report.loaded.reservedContextCount, 0); assert.equal(report.loaded.priorityCount, 18);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(fake.calls.map((args) => args[0]), ["inspect", "image", "exec", "inspect"]);
  assert.ok(fake.calls.every((args) => !args.some((arg) => /(?:^| )reload|originate|restart|channel request/.test(arg))));
  assert.equal("readyToApply" in report, false);
});

test("CIU-02: malformed/foreign/arbitrary-command bindings are rejected before transport", async () => {
  for (const input of [null, {}, { ...binding, version: 2 }, { ...binding, compiler: "foreign" },
    { ...binding, customer: "customer-b" }, { ...binding, namespace: "cp-foreign" },
    { ...binding, project: "shared-production" }, { ...binding, containerId: "--privileged" },
    { ...binding, paths: ["/etc/asterisk"] }, { ...binding, command: "reload" },
    { ...binding, operator: "" }, { ...binding, reason: "x\ninjected" },
    { ...binding, files: { ...binding.files, extra: "a".repeat(64) } },
    { ...binding, files: { ...binding.files, "cp-queues.conf": configurationHash("[unadopted]") } }]) {
    assert.throws(() => parseConfigurationBinding(input));
  }
  const fake = transport();
  await assert.rejects(inspectConfigurationBinding(binding, { ...scope, runtime: "foreign" }, fake.read), /does not match/);
  assert.equal(fake.calls.length, 0);
});

test("CIU-03: existing binding serialization is bounded/canonical/hash-bound, exclusive and read-only", async () => {
  await fixture(async (dir) => {
    const path = join(dir, "binding.json");
    await writeConfigurationBinding(path, binding);
    const before = await readFile(path);
    assert.deepEqual(await readConfigurationBinding(path), binding);
    assert.deepEqual(await readFile(path), before);
    await assert.rejects(writeConfigurationBinding(path, binding), /EEXIST/);
    await assert.rejects(readConfigurationBinding(join(dir, "missing.json")));
    assert.deepEqual(await readdir(dir), ["binding.json"]);
    const wrapper = JSON.parse(before.toString());
    for (const text of [
      JSON.stringify({ ...wrapper, sha256: "0".repeat(64) }) + "\n",
      before.toString().replace('"version":1', '"version":1,"version":1'),
      JSON.stringify(wrapper, null, 2), " ".repeat(16385), "{}",
    ]) {
      await writeFile(path, text); await assert.rejects(readConfigurationBinding(path));
    }
    const invalid = join(dir, "invalid.json");
    await assert.rejects(writeConfigurationBinding(invalid, { ...binding, project: "foreign" }));
    assert.equal((await readdir(dir)).includes("invalid.json"), false);
  });
});

test("CIU-04: stopped, restarted, foreign image/project/service/container and writable or shadow mounts fail closed", async () => {
  const samples = [
    { ...metadata(), Id: "c".repeat(64) },
    { ...metadata(), Image: `sha256:${"d".repeat(64)}` },
    { ...metadata(), State: { Running: false, StartedAt: binding.startedAt } },
    { ...metadata(), State: { Running: true, StartedAt: "2026-10-25T12:00:00Z" } },
    { ...metadata(), Config: { ...metadata().Config, Image: "mutable:latest" } },
    { ...metadata(), Config: { ...metadata().Config, Labels: { ...metadata().Config.Labels, "com.docker.compose.project": "foreign" } } },
    { ...metadata(), Config: { ...metadata().Config, Labels: { ...metadata().Config.Labels, "com.docker.compose.service": "customer-b" } } },
    { ...metadata(), HostConfig: { PortBindings: { "5060/udp": [{}] } } },
    { ...metadata(), Mounts: [{ ...metadata().Mounts[0], RW: true }] },
    { ...metadata(), Mounts: [{ ...metadata().Mounts[0], Source: "/foreign" }] },
    { ...metadata(), Mounts: [...metadata().Mounts, { ...metadata().Mounts[0], Destination: "/etc/asterisk/extensions.conf" }] },
  ];
  for (const meta of samples) {
    const fake = transport(snapshot(), meta);
    await assert.rejects(inspectConfigurationBinding(binding, scope, fake.read), ConfigurationInspectionUnavailable);
    assert.equal(fake.calls.length, 1);
  }
});

test("CIU-05: missing/extra/changed files are distinguished as managed or dependency drift without mutation", async () => {
  const sample = snapshot();
  delete sample.files["cp-queues.conf"]; sample.files["cp-extensions.conf"] = configurationHash("drift");
  sample.files["extensions.conf"] = configurationHash("changed"); sample.files["extra.conf"] = configurationHash("extra");
  sample.endFiles = { ...sample.files };
  const before = JSON.stringify(sample);
  const report = await inspectConfigurationBinding(binding, scope, transport(sample).read);
  assert.equal(report.status, "blocked");
  assert.deepEqual(report.issues, [
    { code: "managed-disk-drift", object: "cp-extensions.conf" }, { code: "managed-disk-drift", object: "cp-queues.conf" },
    { code: "dependency-disk-drift", object: "extensions.conf" }, { code: "dependency-disk-drift", object: "extra.conf" },
  ]);
  assert.equal(JSON.stringify(sample), before);
});

test("CIU-06: unchanged disk never substitutes for exact loaded applications, arguments, priorities, queues or modules", async () => {
  for (const sample of [
    { ...snapshot(), dialplan: dialplan().replace("Queue(proof-queue,,,n,2)", "Queue(proof-queue,,,n,30)") },
    { ...snapshot(), dialplan: dialplan().replace("Wait(5)", "Wait(6)") },
    { ...snapshot(), queues: EMPTY_PROOF_QUEUE.replace("ringall", "random") },
    { ...snapshot(), queues: EMPTY_PROOF_QUEUE.replace("No Members", "PJSIP/unexpected (Not in use)") },
    { ...snapshot(), uuid: "0 modules loaded" },
    { ...snapshot(), channels: "1 active channels\n1 active calls\n1 calls processed" },
  ]) {
    const report = await inspectConfigurationBinding(binding, scope, transport(sample).read);
    assert.equal(report.status, "blocked"); assert.deepEqual(report.disk.files, report.disk.expectedFiles);
    assert.equal(report.issues.length, 1);
    assert.notEqual(report.issues[0].code, "managed-disk-drift");
  }
});

test("CIU-07: unsupported/truncated/duplicate dialplan shapes cannot turn missing facts into success", () => {
  for (const value of ["", "No such command 'dialplan show'", dialplan().replace("18 priorities", "17 priorities"),
    dialplan() + "\nUnexpected extra fact", dialplan().replace("created by 'pbx_config'", "created by 'foreign'"),
    dialplan().replace("-= 4 extensions", "[ Context 'cp-empty' created by 'pbx_config' ]\n-= 4 extensions").replace("in 2 contexts", "in 3 contexts"),
    dialplan().replace("  'queue' => 1.", "  1."), "x".repeat(262145)]) {
    assert.throws(() => parseConfigurationDialplan(value), ConfigurationInspectionUnavailable);
  }
});

test("CIU-08: process/disk changes across sampled inspection fail or block rather than become atomic-snapshot claims", async () => {
  const epoch = snapshot(); epoch.endTicks = "98765";
  await assert.rejects(inspectConfigurationBinding(binding, scope, transport(epoch).read), /process changed/);
  const disk = snapshot(); disk.endFiles["extensions.conf"] = configurationHash("raced");
  const report = await inspectConfigurationBinding(binding, scope, transport(disk).read);
  assert.deepEqual(report.issues, [{ code: "snapshot-changed", object: "configuration-files" }]);
  const fake = transport(); let count = 0;
  await assert.rejects(inspectConfigurationBinding(binding, scope, async (args) => {
    if (args[0] === "inspect" && ++count === 2) return JSON.stringify([{ ...metadata(), State: { Running: false, StartedAt: binding.startedAt } }]);
    return fake.read(args);
  }), /stopped/);
});

test("CIU-09: missing pinned image provenance, malformed snapshot and explicit transport failure never return a status report", async () => {
  await assert.rejects(inspectConfigurationBinding(binding, scope, async (args) =>
    args[0] === "image" ? JSON.stringify([{ Id: binding.imageId, RepoDigests: [] }]) : transport().read(args)), /pinned repository digest/);
  for (const text of ["{}", "not-json", JSON.stringify({ ...snapshot(), extra: "unsupported" }),
    JSON.stringify({ ...snapshot(), files: { ...snapshot().files, ["__proto__"]: "a".repeat(64) } }),
    JSON.stringify({ ...snapshot(), files: { wrong: "../not-a-digest" } }), "x".repeat(1048577)]) {
    const fake = transport();
    await assert.rejects(inspectConfigurationBinding(binding, scope, async (args) => args[0] === "exec" ? text : fake.read(args)));
  }
  await assert.rejects(inspectConfigurationBinding(binding, scope, async () => {
    throw new ConfigurationInspectionUnavailable("runtime-unavailable", "Synthetic PBX outage");
  }), /Synthetic PBX outage/);
});
