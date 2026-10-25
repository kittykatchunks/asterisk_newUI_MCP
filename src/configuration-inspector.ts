import { execFile } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { CONFIGURATION_COMPILER, configurationHash, configurationNamespace, configurationObject,
  configurationScope, type ConfigurationScope } from "./configuration-model.ts";

export const CONFIGURATION_PROOF_IMAGE = "andrius/asterisk:22.11.0_debian-trixie@sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d";
export const CONFIGURATION_PROOF_REPOSITORY_DIGEST = CONFIGURATION_PROOF_IMAGE.replace(/:[^:@]+@/, "@");
export const CONFIGURATION_PROOF_LABEL = "empty-inspection-v1";
export const CONFIGURATION_FILES = ["acl.conf", "asterisk.conf", "ccss.conf", "cdr.conf", "cel.conf", "cel_custom.conf",
  "cp-extensions.conf", "cp-queues.conf", "extensions.conf", "features.conf", "health.sh", "http.conf", "indications.conf",
  "logger.conf", "manager.conf", "modules.conf", "pjproject.conf", "pjsip.conf", "queues.conf", "rtp.conf", "start.sh", "udptl.conf"] as const;
export interface ConfigurationBinding {
  version: 1; baseline: "empty-owned-proof-v1"; compiler: typeof CONFIGURATION_COMPILER;
  customer: string; runtime: string; namespace: string; project: string; service: "customer-a" | "customer-b";
  containerId: string; imageId: string; startedAt: string; startTicks: string; mountSource: string;
  files: Record<string, string>; createdAt: string; operator: string; reason: string;
}
export class ConfigurationInspectionUnavailable extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = "ConfigurationInspectionUnavailable"; this.code = code; }
}
function exact(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  configurationObject(value);
  if (Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw new Error("Invalid configuration inspection fields");
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function date(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && /^\d{4}-\d{2}-\d{2}T/.test(value) && value.length <= 40;
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !!value.trim() && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
}
export function parseConfigurationBinding(input: unknown): ConfigurationBinding {
  exact(input, ["version", "baseline", "compiler", "customer", "runtime", "namespace", "project", "service", "containerId",
    "imageId", "startedAt", "startTicks", "mountSource", "files", "createdAt", "operator", "reason"]);
  if (typeof input.customer !== "string" || typeof input.runtime !== "string") throw new Error("Invalid configuration binding scope");
  const scope = { customer: input.customer, runtime: input.runtime }; configurationScope(scope);
  if (input.version !== 1 || input.baseline !== "empty-owned-proof-v1" || input.compiler !== CONFIGURATION_COMPILER ||
      input.namespace !== configurationNamespace(scope) || input.service !== input.customer ||
      (input.service !== "customer-a" && input.service !== "customer-b") ||
      typeof input.project !== "string" || !/^asterisk-inspection-[a-z0-9]{6,12}$/.test(input.project) ||
      !digest(input.containerId) || typeof input.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(input.imageId) ||
      !date(input.startedAt) || typeof input.startTicks !== "string" || !/^[1-9][0-9]{0,19}$/.test(input.startTicks) ||
      !date(input.createdAt) || !bounded(input.mountSource, 1024) || !bounded(input.operator, 200) || !bounded(input.reason, 2000)) {
    throw new Error("Invalid owned empty-baseline configuration binding");
  }
  exact(input.files, CONFIGURATION_FILES);
  const files: Record<string, string> = {};
  for (const name of CONFIGURATION_FILES) {
    if (!digest(input.files[name])) throw new Error("Invalid configuration dependency digest");
    files[name] = input.files[name];
  }
  if (files["cp-extensions.conf"] !== configurationHash("") || files["cp-queues.conf"] !== configurationHash("")) {
    throw new Error("First binding requires explicitly empty managed fragments");
  }
  return { version: 1, baseline: "empty-owned-proof-v1", compiler: CONFIGURATION_COMPILER,
    ...scope, namespace: input.namespace, project: input.project, service: input.service,
    containerId: input.containerId, imageId: input.imageId, startedAt: input.startedAt, startTicks: input.startTicks,
    mountSource: input.mountSource, files, createdAt: input.createdAt, operator: input.operator, reason: input.reason };
}
function bindingDocument(input: ConfigurationBinding) {
  const binding = parseConfigurationBinding(input);
  const canonical = JSON.stringify(binding);
  return JSON.stringify({ binding, sha256: configurationHash(canonical) }) + "\n";
}
// Trusted bootstrap only. A binding file is local attribution, not an authenticated grant or runtime attestation.
export async function writeConfigurationBinding(path: string, input: ConfigurationBinding) {
  if (!isAbsolute(path)) throw new Error("Binding requires an absolute dedicated path");
  const text = bindingDocument(input);
  const file = await open(path, "wx", 0o600);
  try { await file.writeFile(text); await file.sync(); }
  finally { await file.close(); }
}
export async function readConfigurationBinding(path: string) {
  if (!isAbsolute(path)) throw new Error("Binding requires an absolute dedicated path");
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16384) throw new Error("Binding must be a bounded regular local file");
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (stat.ino !== before.ino || stat.dev !== before.dev || stat.size !== before.size) throw new Error("Binding file changed while opening");
    const buffer = Buffer.alloc(16385);
    let count = 0;
    while (count < buffer.length) {
      const read = await file.read(buffer, count, buffer.length - count, null);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > 16384) throw new Error("Binding exceeds bound");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, count));
    const input: unknown = JSON.parse(text); exact(input, ["binding", "sha256"]);
    const binding = parseConfigurationBinding(input.binding);
    if (text !== bindingDocument(binding)) throw new Error("Binding is not canonical or checksum does not match");
    return binding;
  } finally { await file.close(); }
}

export interface LoadedPriority { context: string; extension: string; priority: number; application: string; data: string; source: string }
export function parseConfigurationDialplan(text: string): LoadedPriority[] {
  if (Buffer.byteLength(text) > 256 * 1024) throw new ConfigurationInspectionUnavailable("dialplan-bound", "Loaded dialplan exceeds inspection bound");
  const result: LoadedPriority[] = [], contexts = new Set<string>(), extensions = new Set<string>();
  let context = "", extension = "", summary = false;
  for (const line of text.trim().split(/\r?\n/)) {
    if (!line.trim()) continue;
    const header = /^\[ Context '([a-z0-9-]{1,96})' created by 'pbx_config' \]$/.exec(line);
    if (header && !summary) {
      if (contexts.has(header[1])) throw new ConfigurationInspectionUnavailable("dialplan-shape", "Duplicate loaded context");
      context = header[1]; extension = ""; contexts.add(context); continue;
    }
    const total = /^-= (\d+) extensions \((\d+) priorities\) in (\d+) contexts\. =-$/.exec(line);
    if (total && !summary) {
      if (Number(total[1]) !== extensions.size || Number(total[2]) !== result.length || Number(total[3]) !== contexts.size) {
        throw new ConfigurationInspectionUnavailable("dialplan-shape", "Loaded dialplan totals do not match parsed inventory");
      }
      summary = true; continue;
    }
    const priority = /^\s+(?:'([a-z0-9-]{1,96})'\s+=>\s+)?(\d+)\.\s+([A-Za-z][A-Za-z0-9]*)\((.*)\)\s+\[([a-z0-9_.-]+):(\d+)\]$/.exec(line);
    if (!priority || !context || summary || (!priority[1] && !extension)) {
      throw new ConfigurationInspectionUnavailable("dialplan-shape", "Unsupported loaded dialplan output; cannot prove inventory");
    }
    if (priority[1]) { extension = priority[1]; extensions.add(`${context}:${extension}`); }
    result.push({ context, extension, priority: Number(priority[2]), application: priority[3], data: priority[4], source: priority[5] });
    if (result.length > 2000) throw new ConfigurationInspectionUnavailable("dialplan-bound", "Too many loaded priorities");
  }
  if (!summary || [...contexts].some((name) => !result.some((p) => p.context === name))) {
    throw new ConfigurationInspectionUnavailable("dialplan-shape", "Missing summary or unsupported empty loaded context");
  }
  return result.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
}
function priority(context: string, extension: string, applications: [string, string][]): LoadedPriority[] {
  return applications.map(([application, data], index) => ({ context, extension, priority: index + 1, application, data, source: "extensions.conf" }));
}
export const EMPTY_PROOF_DIALPLAN = [
  ...priority("proof", "tone", [["Answer", ""], ["MixMonitor", "/var/spool/asterisk/monitor/${UNIQUEID}.wav"],
    ["PlayTones", "440"], ["Wait", "2"], ["StopPlayTones", ""], ["StopMixMonitor", ""], ["Hangup", ""]]),
  ...priority("proof", "queue", [["Answer", ""], ["Queue", "proof-queue,,,n,2"], ["Hangup", ""]]),
  ...priority("proof", "sink", [["Answer", ""], ["Wait", "5"], ["Hangup", ""]]),
  ...priority("sip-proof", "echo", [["Answer", ""], ["CELGenUserEvent", "PROOF_SIP_DIALOG,${PJSIP_HEADER(read,Call-ID)}"],
    ["MixMonitor", "/var/spool/asterisk/monitor/sip-${UNIQUEID}.wav"], ["Echo", ""], ["Hangup", ""]]),
].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b), "en"));
export const EMPTY_PROOF_QUEUE = "proof-queue has 0 calls (max unlimited) in 'ringall' strategy (0s holdtime, 0s talktime), W:0, C:0, A:0, SL:0.0%, SL2:0.0% within 0s\nNo Members\nNo Callers";
function normalized(text: string) { return text.trim().split(/\r?\n/).map((line) => line.trim().replace(/[ \t]+/g, " ")).filter(Boolean).join("\n"); }

// This fixed read-only probe never accepts filenames, shell text or Asterisk commands from a model/binding.
const snapshotCode = `
import hashlib,json,os,selectors,stat,subprocess,time
def files():
    directory=os.open('/etc/asterisk',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    result={}
    try:
        names=sorted(os.listdir(directory))
        if len(names)>64: raise RuntimeError('file-count-bound')
        total=0
        for name in names:
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=directory)
            try:
                before=os.fstat(fd)
                if not stat.S_ISREG(before.st_mode) or before.st_size>65536: raise RuntimeError('unsafe-file')
                data=b''
                while len(data)<=65536:
                    part=os.read(fd,65537-len(data))
                    if not part: break
                    data+=part
                after=os.fstat(fd)
                if len(data)>65536 or (before.st_ino,before.st_size,before.st_mtime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns): raise RuntimeError('changed-file')
                total+=len(data)
                if total>1048576: raise RuntimeError('total-size-bound')
                result[name]=hashlib.sha256(data).hexdigest()
            finally: os.close(fd)
        return result
    finally: os.close(directory)
def ticks():
    return open('/proc/1/stat').read().rsplit(') ',1)[1].split()[19]
def cli(command):
    run=subprocess.Popen(['/usr/sbin/asterisk','-rx',command],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    data=b''
    deadline=time.monotonic()+5
    try:
        with selectors.DefaultSelector() as select:
            select.register(run.stdout,selectors.EVENT_READ,False)
            select.register(run.stderr,selectors.EVENT_READ,True)
            while select.get_map():
                remaining=deadline-time.monotonic()
                if remaining<=0: raise TimeoutError('cli-timeout')
                ready=select.select(remaining)
                if not ready: raise TimeoutError('cli-timeout')
                for key,_ in ready:
                    chunk=os.read(key.fd,min(8192,262145-len(data)))
                    if not chunk:
                        select.unregister(key.fileobj)
                    elif key.data:
                        raise RuntimeError('cli-stderr')
                    else:
                        data+=chunk
                        if len(data)>262144: raise RuntimeError('cli-output-bound')
        run.wait(timeout=max(0.001,deadline-time.monotonic()))
        if run.returncode: raise RuntimeError('cli-exit-failed')
        return data.decode('utf-8')
    finally:
        if run.poll() is None: run.kill()
        run.wait()
        run.stdout.close()
        run.stderr.close()
try:
    before=ticks()
    disk=files()
    output={key:cli(command) for key,command in [('dialplan','dialplan show'),('queues','queue show'),('uuid','module show like func_uuid.so'),('channels','core show channels count')]}
    print(json.dumps({'startTicks':before,'endTicks':ticks(),'files':disk,'endFiles':files(),**output}))
except (OSError,RuntimeError,subprocess.SubprocessError,UnicodeError):
    print(json.dumps({'error':'read-only-snapshot-failed'}))
    raise SystemExit(1)
`;
const execute = promisify(execFile);
export type ConfigurationInspectionTransport = (args: string[]) => Promise<string>;
export async function configurationDockerRead(args: string[]) {
  try { return (await execute("docker", args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 })).stdout; }
  catch (error) {
    throw new ConfigurationInspectionUnavailable("runtime-unavailable",
      error instanceof Error && "code" in error && error.code === "ENOENT" ? "Docker is unavailable" : "Bound runtime read failed or timed out");
  }
}
function metadata(text: string, binding: ConfigurationBinding) {
  if (Buffer.byteLength(text) > 1024 * 1024) throw new ConfigurationInspectionUnavailable("metadata-bound", "Runtime metadata exceeds inspection bound");
  const input: unknown = JSON.parse(text);
  if (!Array.isArray(input) || input.length !== 1) throw new ConfigurationInspectionUnavailable("runtime-identity", "Expected exactly one bound container");
  const value: unknown = input[0]; configurationObject(value);
  configurationObject(value.Config); configurationObject(value.Config.Labels);
  configurationObject(value.State); configurationObject(value.HostConfig);
  if (value.Id !== binding.containerId || value.Image !== binding.imageId || value.Config.Image !== CONFIGURATION_PROOF_IMAGE ||
      value.Config.Labels["com.docker.compose.project"] !== binding.project ||
      value.Config.Labels["com.docker.compose.service"] !== binding.service ||
      value.Config.Labels["io.asterisk.configuration-proof"] !== CONFIGURATION_PROOF_LABEL ||
      value.State.Running !== true || value.State.StartedAt !== binding.startedAt ||
      !Array.isArray(value.Mounts) || JSON.stringify(value.HostConfig.PortBindings ?? {}) !== "{}") {
    throw new ConfigurationInspectionUnavailable("runtime-identity", "Bound owned runtime identity changed, stopped, restarted or exposes ports");
  }
  const mounts = value.Mounts.filter((mount: unknown) => {
    configurationObject(mount);
    return typeof mount.Destination === "string" && (mount.Destination === "/" || mount.Destination === "/etc" || mount.Destination.startsWith("/etc/asterisk"));
  });
  if (mounts.length !== 1) throw new ConfigurationInspectionUnavailable("runtime-mount", "Unexpected configuration mount inventory");
  const mount: unknown = mounts[0]; configurationObject(mount);
  if (mount.Destination !== "/etc/asterisk" || mount.Source !== binding.mountSource || mount.Type !== "bind" || mount.RW !== false) {
    throw new ConfigurationInspectionUnavailable("runtime-mount", "Owned read-only configuration mount changed");
  }
}
export async function inspectConfigurationBinding(input: ConfigurationBinding, scope: ConfigurationScope,
  transport: ConfigurationInspectionTransport = configurationDockerRead) {
  const binding = parseConfigurationBinding(input); configurationScope(scope);
  if (scope.customer !== binding.customer || scope.runtime !== binding.runtime) {
    throw new ConfigurationInspectionUnavailable("scope-mismatch", "Requested customer/runtime does not match provisioned binding");
  }
  const startedAt = new Date().toISOString();
  metadata(await transport(["inspect", binding.containerId]), binding);
  const imageText = await transport(["image", "inspect", binding.imageId]);
  if (Buffer.byteLength(imageText) > 1024 * 1024) throw new ConfigurationInspectionUnavailable("image-bound", "Image metadata exceeds bound");
  const image: unknown = JSON.parse(imageText);
  if (!Array.isArray(image) || image.length !== 1) throw new ConfigurationInspectionUnavailable("image-identity", "Expected one pinned image");
  const imageMetadata: unknown = image[0]; configurationObject(imageMetadata);
  if (imageMetadata.Id !== binding.imageId || !Array.isArray(imageMetadata.RepoDigests) ||
      !imageMetadata.RepoDigests.includes(CONFIGURATION_PROOF_REPOSITORY_DIGEST)) {
    throw new ConfigurationInspectionUnavailable("image-identity", "Bound image does not retain the pinned repository digest");
  }
  const text = await transport(["exec", binding.containerId, "python3", "-B", "-c", snapshotCode]);
  if (Buffer.byteLength(text) > 1024 * 1024) throw new ConfigurationInspectionUnavailable("snapshot-bound", "Runtime snapshot exceeds bound");
  const snapshot: unknown = JSON.parse(text);
  exact(snapshot, ["startTicks", "endTicks", "files", "endFiles", "dialplan", "queues", "uuid", "channels"]);
  if (snapshot.startTicks !== binding.startTicks || snapshot.endTicks !== binding.startTicks) {
    throw new ConfigurationInspectionUnavailable("runtime-epoch", "Bound PBX process changed during or since provisioning");
  }
  configurationObject(snapshot.files); configurationObject(snapshot.endFiles);
  const files: Record<string, string> = {}, endFiles: Record<string, string> = {};
  for (const [source, target] of [[snapshot.files, files], [snapshot.endFiles, endFiles]] as const) {
    if (Object.keys(source).length > 64) throw new Error("Configuration snapshot file bound exceeded");
    for (const name of Object.keys(source).sort()) {
      if (!/^[a-z0-9][a-z0-9_.-]{0,95}$/.test(name) || !digest(source[name])) throw new Error("Invalid snapshot file name/digest");
      target[name] = source[name];
    }
  }
  metadata(await transport(["inspect", binding.containerId]), binding);
  for (const key of ["dialplan", "queues", "uuid", "channels"] as const) {
    if (typeof snapshot[key] !== "string" || Buffer.byteLength(snapshot[key]) > 256 * 1024) throw new Error("Invalid bounded runtime inventory");
  }
  if (typeof snapshot.dialplan !== "string" || typeof snapshot.queues !== "string" ||
      typeof snapshot.uuid !== "string" || typeof snapshot.channels !== "string") throw new Error("Invalid runtime snapshot");
  const priorities = parseConfigurationDialplan(snapshot.dialplan);
  const issues: { code: string; object: string }[] = [];
  if (JSON.stringify(files) !== JSON.stringify(endFiles)) issues.push({ code: "snapshot-changed", object: "configuration-files" });
  for (const name of [...new Set([...CONFIGURATION_FILES, ...Object.keys(files)])].sort()) {
    if (files[name] !== binding.files[name]) issues.push({ code: name.startsWith("cp-") ? "managed-disk-drift" : "dependency-disk-drift", object: name });
  }
  const loadedDialplanSha256 = configurationHash(JSON.stringify(priorities));
  const expectedDialplanSha256 = configurationHash(JSON.stringify(EMPTY_PROOF_DIALPLAN));
  if (loadedDialplanSha256 !== expectedDialplanSha256) issues.push({ code: "loaded-dialplan-drift", object: "full-proof-dialplan" });
  const queueOutput = normalized(snapshot.queues);
  const queueNames = [...queueOutput.matchAll(/^([a-z0-9][a-z0-9_-]{0,95}) has [0-9]+ calls /gm)].map((match) => match[1]).sort();
  if (queueOutput !== EMPTY_PROOF_QUEUE) issues.push({ code: "loaded-queue-drift", object: "full-proof-queue-inventory" });
  if (normalized(snapshot.uuid) !== "Module Description Use Count Status Support Level\nfunc_uuid.so UUID generation dialplan function 0 Running extended\n1 modules loaded") {
    issues.push({ code: "required-module-drift", object: "func_uuid.so" });
  }
  if (normalized(snapshot.channels) !== "0 active channels\n0 active calls\n0 calls processed") {
    issues.push({ code: "not-quiescent-baseline", object: "channels-and-calls" });
  }
  return { version: 1 as const, customer: binding.customer, runtime: binding.runtime, namespace: binding.namespace,
    bindingSha256: configurationHash(JSON.stringify(binding)), compiler: CONFIGURATION_COMPILER,
    baseline: binding.baseline, baseRevision: 0, startedAt, observedAt: new Date().toISOString(),
    status: issues.length ? "blocked" as const : "empty-baseline-observed" as const,
    executorEnabled: false as const, publicationVerified: false as const, issues,
    disk: { files, expectedFiles: binding.files }, loaded: { loadedDialplanSha256, expectedDialplanSha256,
      loadedQueuesSha256: configurationHash(queueOutput), expectedQueuesSha256: configurationHash(EMPTY_PROOF_QUEUE),
      contexts: [...new Set(priorities.map((p) => p.context))].sort(),
      queues: queueNames, reservedQueueCount: queueNames.filter((name) => name.startsWith("cp-")).length,
      priorityCount: priorities.length, reservedContextCount: new Set(priorities.filter((p) => p.context.startsWith("cp-")).map((p) => p.context)).size },
    limitations: "Sampled empty proof baseline only; not an atomic PBX snapshot, authenticated identity, apply readiness, verified publication or recovery receipt" };
}
