import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "local", "asterisk-patches");
const regularFile = (filename) => {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected regular file: ${filename}`);
  return readFileSync(filename);
};
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = JSON.parse(regularFile(path.join(artifacts, "queue-policy-shutdown-v1.json")));
const parent = JSON.parse(regularFile(path.join(artifacts, "queue-policy-v1.json")));
const patchPath = path.join(artifacts, manifest.patch);
const patch = regularFile(patchPath);
const patchText = patch.toString("utf8");
const supervisor = regularFile(path.join(root, "local", "asterisk-build", "shutdown-supervisor.py"))
  .toString("utf8");
regularFile(path.join(root, "tests", "asterisk-shutdown-supervisor.test.py"));
const expected = ["include/asterisk/module.h", "main/loader.c", "main/asterisk.c"];

if (
  manifest.schemaVersion !== 1 ||
  manifest.stage !== "source-only-shutdown-supervisor-scaffold" ||
  manifest.upstreamCommit !== parent.upstreamCommit ||
  manifest.parentManifest !== "queue-policy-v1.json" ||
  manifest.parentPatchSha256 !== parent.patchSha256 ||
  manifest.patch !== "queue-policy-shutdown-v1.patch" ||
  manifest.patchSha256 !== sha256(patch) ||
  patch.includes(13) ||
  manifest.nativeCompiled !== false ||
  manifest.nativeTestsExecuted !== false ||
  manifest.patchApplicationVerified !== false ||
  manifest.runtimeApplyAuthorized !== false ||
  manifest.gatesBAndCApproved !== false ||
  JSON.stringify(manifest.changedUpstreamPaths) !== JSON.stringify(expected)
) {
  throw new Error("Shutdown supplement provenance or approval boundary mismatch");
}

const paths = [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
if (JSON.stringify(paths.map((match) => match[1])) !== JSON.stringify(expected) ||
  paths.some((match) => match[1] !== match[2])) {
  throw new Error("Shutdown supplement paths differ from its manifest");
}

const stats = execFileSync("git", ["apply", "--numstat", patchPath], {
  cwd: root,
  encoding: "utf8",
  timeout: 10_000,
});
if (JSON.stringify(stats.trim().split(/\r?\n/).map((line) => line.split("\t")[2])) !==
  JSON.stringify(expected)) {
  throw new Error("Unable to parse exact shutdown supplement file inventory");
}
if (
  !patchText.includes("ASTERISK_CLI_LEASE_TEST_SOCKET") ||
  !patchText.includes("TEST_FRAMEWORK") ||
  !patchText.includes("modules_shutdown()") ||
  !supervisor.includes('hasattr(socket, "AF_UNIX")') ||
  !supervisor.includes("--approve-shutdown-fixture") ||
  !supervisor.includes("shutdown-supervisor-report.json")
) {
  throw new Error("Shutdown supplement is missing its test-only lifecycle hooks");
}

console.log(JSON.stringify({
  status: "shutdown-source-supplement-checked",
  patchSha256: manifest.patchSha256,
  parentPatchSha256: manifest.parentPatchSha256,
  patchSyntaxParsed: true,
  patchApplicationVerified: false,
  nativeCompiled: false,
  nativeTestsExecuted: false,
  runtimeApplyAuthorized: false,
}, null, 2));
