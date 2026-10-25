import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CONFIGURATION_COMPILER, configurationHash, configurationNamespace, configurationObject, compileConfiguration } from "../../src/configuration-model.ts";
import { CONFIGURATION_FILES, CONFIGURATION_PROOF_LABEL, CONFIGURATION_PROOF_IMAGE, inspectConfigurationBinding, parseConfigurationBinding,
  writeConfigurationBinding, readConfigurationBinding, type ConfigurationBinding } from "../../src/configuration-inspector.ts";
import { openConfigurationStore } from "../../src/configuration-store.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== "--review-policy")) throw new Error("Only --review-policy is supported");
const reviewPolicy = args[0] === "--review-policy";
const parent = join(root, ".local-proof", "configuration-inspection");
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, "run-"));
const project = `asterisk-inspection-${basename(directory).slice(4).toLowerCase()}`;
const customers = ["customer-a", "customer-b"] as const;
const execute = promisify(execFile);
const override = join(directory, "compose.json");
const compose = ["compose", "--project-name", project, "-f", join(root, "compose.yaml"), "-f", override];
async function docker(args: string[], timeout = 30000) {
  return (await execute("docker", args, { cwd: root, timeout, maxBuffer: 2 * 1024 * 1024 })).stdout.trim();
}
const report: Record<string, unknown> = { passed: false, project, scope: "read-only empty configuration baseline; no apply/reload/canary" };
const bindings = new Map<string, ConfigurationBinding>();
const observations: Awaited<ReturnType<typeof inspectConfigurationBinding>>[] = [];
report.observations = observations;
const checks: { id: string; passed: true }[] = [];
const reviewChecks: { id: string; passed: true }[] = [];
report.checks = checks;
report.reviewChecks = reviewChecks;
const pass = (id: string) => { checks.push({ id, passed: true }); console.log(`PASS ${id}`); };
const reviewPass = (id: string) => { reviewChecks.push({ id, passed: true }); console.log(`PASS ${id}`); };
let attempted = false;
const repositoryFiles = new Map<string, Buffer>();
function singleObject(text: string) {
  const rows: unknown = JSON.parse(text);
  assert.ok(Array.isArray(rows) && rows.length === 1);
  const row: unknown = rows[0]; configurationObject(row); return row;
}
async function candidate(customer: typeof customers[number], files: Record<string, string>) {
  const containerId = await docker([...compose, "ps", "-q", customer]);
  const metadata = singleObject(await docker(["inspect", containerId]));
  configurationObject(metadata.State);
  assert.ok(Array.isArray(metadata.Mounts));
  const mount: unknown = metadata.Mounts.find((m: unknown) => { configurationObject(m); return m.Destination === "/etc/asterisk"; });
  configurationObject(mount);
  const scope = { customer, runtime: `${customer}-proof` };
  return parseConfigurationBinding({ version: 1, baseline: "empty-owned-proof-v1", compiler: CONFIGURATION_COMPILER,
    ...scope, namespace: configurationNamespace(scope), project, service: customer, containerId, imageId: metadata.Image,
    startedAt: metadata.State.StartedAt, startTicks: await docker([...compose, "exec", "-T", customer, "python3", "-B", "-c",
      "print(open('/proc/1/stat').read().rsplit(') ',1)[1].split()[19])"]),
    mountSource: mount.Source,
    files, createdAt: new Date().toISOString(), operator: "owned-inspection-proof", reason: "Explicit fresh empty fixture baseline" });
}
async function observe(binding: ConfigurationBinding) {
  const result = await inspectConfigurationBinding(binding, binding);
  observations.push(result);
  return result;
}
try {
  const baseline = join(root, "local", "asterisk");
  for (const name of await readdir(baseline)) repositoryFiles.set(name, await readFile(join(baseline, name)));
  for (const customer of customers) {
    const config = join(directory, customer);
    await mkdir(config);
    for (const name of await readdir(baseline)) {
      let bytes = await readFile(join(baseline, name));
      if (name === "extensions.conf") bytes = Buffer.from(`${bytes.toString("utf8").replaceAll("\r\n", "\n")}\n#include "cp-extensions.conf"\n`);
      if (name === "queues.conf") bytes = Buffer.from(`${bytes.toString("utf8").replaceAll("\r\n", "\n")}\n#include "cp-queues.conf"\n`);
      if (name === "modules.conf") bytes = Buffer.from(`${bytes.toString("utf8").replaceAll("\r\n", "\n")}\nload = func_uuid.so\n`);
      await writeFile(join(config, name), bytes, { flag: "wx" });
    }
    await writeFile(join(config, "cp-extensions.conf"), "");
    await writeFile(join(config, "cp-queues.conf"), "");
  }
  await writeFile(override, JSON.stringify({ services: Object.fromEntries(customers.map((customer) => [customer, {
    volumes: [{ type: "bind", source: join(directory, customer), target: "/etc/asterisk", read_only: true }],
    labels: { "io.asterisk.configuration-proof": CONFIGURATION_PROOF_LABEL },
  }])) }));
  attempted = true;
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "90", "--pull", "never", "--no-build", ...customers], 120000);
  const image = singleObject(await docker(["image", "inspect", CONFIGURATION_PROOF_IMAGE]));
  for (const customer of customers) {
    const files: Record<string, string> = {};
    for (const name of CONFIGURATION_FILES) files[name] = configurationHash((await readFile(join(directory, customer, name))).toString("utf8"));
    const binding = await candidate(customer, files);
    assert.equal(binding.imageId, image.Id);
    const observed = await observe(binding);
    assert.equal(observed.status, "empty-baseline-observed", JSON.stringify(observed.issues));
    assert.equal(observed.loaded.reservedContextCount, 0);
    assert.equal(observed.loaded.reservedQueueCount, 0);
    await writeConfigurationBinding(join(directory, `${customer}.binding.json`), binding);
    bindings.set(customer, binding);
  }
  pass("CI-01: both owned empty namespaces and exact known unmanaged dialplan observed; bindings published only after inspection");
  for (const customer of customers) {
    const binding = bindings.get(customer)!;
    const before = await readFile(join(directory, `${customer}.binding.json`));
    assert.deepEqual(await readConfigurationBinding(join(directory, `${customer}.binding.json`)), binding);
    const output = await execute(process.execPath, [join(root, "scripts", "Inspect-Configuration.ts"),
      join(directory, `${customer}.binding.json`), customer, binding.runtime], { cwd: root, timeout: 30000 });
    const result: unknown = JSON.parse(output.stdout); configurationObject(result);
    assert.equal(result.status, "empty-baseline-observed");
    assert.equal(result.executorEnabled, false); assert.equal(result.publicationVerified, false);
    assert.deepEqual(await readFile(join(directory, `${customer}.binding.json`)), before);
  }
  pass("CI-02: real read-only operator CLI reloads persistent scoped binding without changing it or publishing");
  const a = bindings.get("customer-a")!, b = bindings.get("customer-b")!;
  if (reviewPolicy) {
    const capabilities: Record<string, string> = {};
    for (const command of ["core show help queue show", "core show function QUEUE_VARIABLES", "core show function QUEUE_EXISTS"]) {
      capabilities[command] = await docker([...compose, "exec", "-T", "customer-a", "asterisk", "-rx", command]);
    }
    assert.match(capabilities["core show function QUEUE_VARIABLES"], /QUEUESTRATEGY/);
    assert.doesNotMatch(capabilities["core show function QUEUE_VARIABLES"], /QUEUETIMEOUT|JOINEMPTY|LEAVEWHENEMPTY/i);
    report.queueCapabilities = capabilities;
    reviewPass("CQ-01: pinned runtime read-only help and queue function fields captured; no channel, AMI privilege or function evaluation");
    const database = join(directory, "review.sqlite");
    const prepared: { binding: ConfigurationBinding; revision: number; draftHash: string; validationHash: string }[] = [];
    const store = openConfigurationStore(database);
    try {
      for (const binding of [a, b]) {
        const actor = { operator: "proof-reviewer", reason: "Explicit bound offline inspection review" };
        const d = store.createDraft(binding, JSON.stringify({ schemaVersion: 1, routeId: "inbound", queueId: "waiting", waitSeconds: 2 }), 0, actor);
        const v = store.validate(binding, d.revision, d.sha256, actor);
        prepared.push({ binding, revision: d.revision, draftHash: d.sha256, validationHash: v.sha256 });
      }
    } finally { store.close(); }
    for (const item of prepared) {
      const bindingPath = join(directory, `${item.binding.customer}.binding.json`);
      const prefix = [join(root, "scripts", "Review-ConfigurationInspection.ts")];
      const output = await execute(process.execPath, [...prefix, "approve", database, bindingPath, item.binding.customer, item.binding.runtime,
        String(item.revision), item.draftHash, item.validationHash, "proof-reviewer", "Explicit bound offline inspection review"], { timeout: 30000 });
      const approved: unknown = JSON.parse(output.stdout); configurationObject(approved); configurationObject(approved.result);
      configurationObject(approved.result.document);
      assert.equal(approved.result.document.runtimeApplyAuthorized, false);
      assert.ok(approved.result.document.inspectionReview);
      const before = await readFile(database);
      const current = await execute(process.execPath, [...prefix, "check", database, bindingPath,
        item.binding.customer, item.binding.runtime, String(item.revision)], { timeout: 30000 });
      const compared: unknown = JSON.parse(current.stdout); configurationObject(compared); configurationObject(compared.result);
      assert.equal(compared.result.status, "reviewed-baseline-matches");
      assert.equal(compared.result.runtimeApplyAuthorized, false);
      assert.deepEqual(await readFile(database), before);
    }
    reviewPass("CQ-02: both customer real CLI approvals durably bind exact draft/validation/binding/observation hashes; fresh check is read-only, not apply authority");
  }
  await assert.rejects(inspectConfigurationBinding(a, b), /does not match provisioned binding/);
  await assert.rejects(inspectConfigurationBinding({ ...a, containerId: b.containerId }, a), /identity changed/);
  await assert.rejects(inspectConfigurationBinding({ ...a, mountSource: `${a.mountSource}-foreign` }, a), /mount changed/);
  pass("CI-03: foreign scope, swapped container and altered mount fail closed");

  const managed = join(directory, "customer-a", "cp-extensions.conf");
  await writeFile(managed, "; injected disk-only drift; never loaded\n");
  const diskDrift = await observe(a);
  assert.equal(diskDrift.status, "blocked");
  assert.deepEqual(diskDrift.issues, [{ code: "managed-disk-drift", object: "cp-extensions.conf" }]);
  const blockedCli = await execute(process.execPath, [join(root, "scripts", "Inspect-Configuration.ts"),
    join(directory, "customer-a.binding.json"), a.customer, a.runtime], { cwd: root, timeout: 30000 }).then(
    () => { throw new Error("Blocked CLI unexpectedly succeeded"); },
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === 2 && "stdout" in error && typeof error.stdout === "string");
      return JSON.parse(error.stdout);
    });
  assert.equal(blockedCli.status, "blocked");
  if (reviewPolicy) {
    const before = await readFile(join(directory, "review.sqlite"));
    await assert.rejects(execute(process.execPath, [join(root, "scripts", "Review-ConfigurationInspection.ts"), "check",
      join(directory, "review.sqlite"), join(directory, "customer-a.binding.json"), a.customer, a.runtime, "1"], { timeout: 30000 }));
    assert.deepEqual(await readFile(join(directory, "review.sqlite")), before);
  }
  assert.equal((await observe(b)).status, "empty-baseline-observed");
  await writeFile(managed, "");
  pass("CI-04: disk-only managed drift blocks, CLI exits 2, loaded state and other customer remain unchanged");

  const dependency = join(directory, "customer-a", "extensions.conf"), dependencyBefore = await readFile(dependency);
  await writeFile(dependency, Buffer.concat([dependencyBefore, Buffer.from("; dependency drift\n")]));
  assert.deepEqual((await observe(a)).issues, [{ code: "dependency-disk-drift", object: "extensions.conf" }]);
  await writeFile(dependency, dependencyBefore);
  await rm(join(directory, "customer-a", "cp-queues.conf"));
  assert.deepEqual((await observe(a)).issues, [{ code: "managed-disk-drift", object: "cp-queues.conf" }]);
  await writeFile(join(directory, "customer-a", "cp-queues.conf"), "");
  const extra = join(directory, "customer-a", "unexpected.conf"); await writeFile(extra, "; unexpected dependency\n");
  assert.deepEqual((await observe(a)).issues, [{ code: "dependency-disk-drift", object: "unexpected.conf" }]);
  await rm(extra);
  const unsafe = join(directory, "customer-a", "unsafe.conf");
  await mkdir(unsafe);
  await assert.rejects(inspectConfigurationBinding(a, a), /Bound runtime read failed/);
  await rm(unsafe, { recursive: true });
  assert.equal((await observe(a)).status, "empty-baseline-observed");
  pass("CI-05: changed/missing/extra disk files block; nonregular file makes inspection unavailable; inspector never repairs");

  await docker([...compose, "stop", "--timeout", "5", "customer-a"], 30000);
  await assert.rejects(inspectConfigurationBinding(a, a), /stopped/);
  await execute(process.execPath, [join(root, "scripts", "Inspect-Configuration.ts"),
    join(directory, "customer-a.binding.json"), a.customer, a.runtime], { cwd: root, timeout: 30000 }).then(
    () => { throw new Error("Stopped-runtime CLI unexpectedly succeeded"); },
    (error: unknown) => {
      assert.ok(error instanceof Error && "code" in error && error.code === 1 && "stderr" in error && typeof error.stderr === "string");
      const output: unknown = JSON.parse(error.stderr); configurationObject(output);
      assert.equal(output.status, "unavailable");
      assert.equal(output.publicationVerified, false);
    });
  assert.equal((await observe(b)).status, "empty-baseline-observed");
  pass("CI-06: owned A outage is unavailable, never stored success; B remains independently responsive");

  const collision = compileConfiguration(a, { schemaVersion: 1, routeId: "inbound", queueId: "waiting", waitSeconds: 2 }, 1);
  await writeFile(managed, collision.dialplan);
  await writeFile(join(directory, "customer-a", "cp-queues.conf"), collision.queues);
  // Fault bootstrap only: no apply/reload path or canary is invoked.
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "90", "--pull", "never", "--no-build", "customer-a"], 120000);
  const collisionCandidate = await candidate("customer-a", a.files);
  await writeFile(managed, "");
  await writeFile(join(directory, "customer-a", "cp-queues.conf"), "");
  const loadedDrift = await observe(collisionCandidate);
  assert.equal(loadedDrift.status, "blocked");
  assert.deepEqual(loadedDrift.disk.files, loadedDrift.disk.expectedFiles);
  assert.deepEqual(loadedDrift.issues.map((issue) => issue.code), ["loaded-dialplan-drift", "loaded-queue-drift"]);
  assert.equal(loadedDrift.loaded.reservedContextCount, 1);
  assert.equal(loadedDrift.loaded.reservedQueueCount, 1);
  assert.equal((await observe(b)).status, "empty-baseline-observed");
  pass("CI-07: deliberate pre-boot collision remains loaded after disk restore; matching disk cannot conceal reserved loaded objects");

  await assert.rejects(inspectConfigurationBinding(a, a), /restarted/);
  assert.deepEqual(await readConfigurationBinding(join(directory, "customer-a.binding.json")), a);
  await docker([...compose, "stop", "--timeout", "5", "customer-a"], 30000);
  await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "90", "--pull", "never", "--no-build", "customer-a"], 120000);
  await assert.rejects(inspectConfigurationBinding(a, a), /restarted/);
  const restoredCandidate = await candidate("customer-a", a.files);
  const restoredObservation = await observe(restoredCandidate);
  assert.equal(restoredObservation.status, "empty-baseline-observed");
  assert.deepEqual(await readConfigurationBinding(join(directory, "customer-a.binding.json")), a);
  pass("CI-08: PBX restart invalidates original binding; clean cold baseline does not automatically rebind or verify publication");

  if (reviewPolicy) {
    const reviewBefore = await readFile(join(directory, "review.sqlite"));
    await assert.rejects(execute(process.execPath, [join(root, "scripts", "Review-ConfigurationInspection.ts"), "check",
      join(directory, "review.sqlite"), join(directory, "customer-a.binding.json"), a.customer, a.runtime, "1"], { timeout: 30000 }));
    assert.deepEqual(await readFile(join(directory, "review.sqlite")), reviewBefore);
    reviewPass("CQ-03: durable reviewed approval cannot survive a restarted binding by silently refreshing its evidence");
    const queueFile = join(directory, "customer-a", "queues.conf"), originalQueue = await readFile(queueFile);
    await docker([...compose, "stop", "--timeout", "5", "customer-a"], 30000);
    const altered = originalQueue.toString().replace("timeout = 2", "timeout = 7")
      .replace("joinempty = yes", "joinempty = no").replace("leavewhenempty = no", "leavewhenempty = yes");
    assert.notEqual(altered, originalQueue.toString());
    await writeFile(queueFile, altered);
    await docker([...compose, "up", "-d", "--wait", "--wait-timeout", "90", "--pull", "never", "--no-build", "customer-a"], 120000);
    const policyCandidate = await candidate("customer-a", a.files);
    await writeFile(queueFile, originalQueue);
    const policy = await observe(policyCandidate);
    assert.equal(policy.status, "empty-baseline-observed");
    assert.equal(policy.loaded.loadedQueuesSha256, restoredObservation.loaded.loadedQueuesSha256);
    assert.deepEqual(policy.queuePolicy, { status: "unsupported", unobservedFields: ["timeout", "joinempty", "leavewhenempty"] });
    assert.equal(policy.publicationVerified, false);
    report.queuePolicyCounterexample = { coldBootstrapChanges: { timeout: [2, 7], joinempty: ["yes", "no"], leavewhenempty: ["no", "yes"] },
      independentLoadedPolicyRead: "unsupported", restoredDiskMatches: true, queueDisplayUnchanged: true,
      noReloadOrCall: true };
    assert.equal((await observe(b)).status, "empty-baseline-observed");
    reviewPass("CQ-04: differing cold-bootstrap timeout/join/leave inputs plus restored disk yield identical queue display; all three loaded values remain explicitly unsupported");
  }
  for (const customer of customers) {
    const binding = bindings.get(customer)!;
    for (const name of CONFIGURATION_FILES) {
      assert.equal(configurationHash((await readFile(join(directory, customer, name))).toString("utf8")), binding.files[name]);
    }
  }
  pass("CI-09: all owned bootstrap bytes restored explicitly by test; bindings unchanged, no credentials or runtime writes by inspector");
  report.checksBeforeCleanupPassed = true;
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : "Unknown owned inspection proof failure";
  throw error;
} finally {
  if (attempted) await docker([...compose, "down", "--volumes", "--remove-orphans", "--timeout", "5"], 60000);
  for (const [kind, args] of [
    ["containers", ["ps", "-a", "-q"]], ["networks", ["network", "ls", "-q"]], ["volumes", ["volume", "ls", "-q"]],
  ] as const) assert.equal(await docker([...args, "--filter", `label=com.docker.compose.project=${project}`]), "", `Owned ${kind} remain`);
  report.ownedResourceAbsenceVerified = true;
  for (const [name, bytes] of repositoryFiles) assert.deepEqual(await readFile(join(root, "local", "asterisk", name)), bytes);
  for (const customer of customers) await rm(join(directory, customer), { recursive: true, force: true });
  await rm(override, { force: true });
  if (report.checksBeforeCleanupPassed) {
    assert.deepEqual((await readdir(directory)).sort(), reviewPolicy ?
      ["customer-a.binding.json", "customer-b.binding.json", "review.sqlite"] :
      ["customer-a.binding.json", "customer-b.binding.json"]);
    report.generatedFilesRemoved = true;
    pass("CI-10: owned resources and generated credentials/config absent; repository baseline unchanged; only synthetic binding/review/report evidence retained");
  }
  report.passed = report.passed === true && checks.length === 10 && (!reviewPolicy || reviewChecks.length === 4);
  await writeFile(join(directory, "result.json"), JSON.stringify(report, null, 2));
  if (report.checksBeforeCleanupPassed) assert.equal(report.passed, true, "Acceptance check count does not match the selected proof");
  console.log(JSON.stringify({ directory, project, passed: report.passed, checks: checks.length, reviewChecks: reviewChecks.length,
    ownedResourceAbsenceVerified: report.ownedResourceAbsenceVerified }));
}
