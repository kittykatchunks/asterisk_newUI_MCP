import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = path.join(root, "local", "asterisk-patches");
const expected = [
  "apps/app_queue.c",
  "include/asterisk/astobj2.h",
  "include/asterisk/cli.h",
  "include/asterisk/module.h",
  "main/astobj2_hash.c",
  "main/cli.c",
  "main/loader.c",
  "tests/test_bounded_queue_policy.c",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readRegular = (filename) => {
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Expected regular file: ${filename}`);
  }
  return readFileSync(filename);
};

const args = process.argv.slice(2);
if (args.length !== 0 && (args.length !== 2 || args[0] !== "--source")) {
  throw new Error("Usage: node scripts\\Test-AsteriskQueuePolicyPatch.mjs [--source <clean-source-directory>]");
}
const manifest = JSON.parse(readRegular(path.join(directory, "queue-policy-v1.json")));
if (
  manifest.schemaVersion !== 1 ||
  manifest.upstreamCommit !== "874768141f94bc03865cc746eee1c7669e3c46d5" ||
  manifest.patch !== "queue-policy-v1.patch" ||
  manifest.stage !== "gate-a-source-candidate" ||
  manifest.nativeCompiled !== false ||
  manifest.nativeTestsExecuted !== false ||
  manifest.runtimeApplyAuthorized !== false ||
  manifest.gatesBAndCApproved !== false ||
  !Array.isArray(manifest.files) ||
  JSON.stringify(manifest.files.map((file) => file.path)) !== JSON.stringify(expected)
) {
  throw new Error("Unexpected source-candidate manifest or changed approval boundary");
}
const patchFile = path.join(directory, manifest.patch);
const patchBytes = readRegular(patchFile);
if (sha256(patchBytes) !== manifest.patchSha256 || patchBytes.includes(13)) {
  throw new Error("Patch checksum or LF encoding mismatch");
}
const patchText = patchBytes.toString("utf8");
const patchFiles = [...patchText.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)];
if (
  JSON.stringify(patchFiles.map((match) => match[1])) !== JSON.stringify(expected) ||
  patchFiles.some((match) => match[1] !== match[2])
) {
  throw new Error("Patch paths differ from the exact approved source boundary");
}
const nativeTestNames = manifest.nativeTests;
if (
  !Array.isArray(nativeTestNames) ||
  nativeTestNames.length === 0 ||
  nativeTestNames.length > 32 ||
  nativeTestNames.some((name) => typeof name !== "string" || !/^[a-z][a-z0-9_]{0,63}$/.test(name)) ||
  new Set(nativeTestNames).size !== nativeTestNames.length
) {
  throw new Error("Invalid or duplicate native-test inventory");
}
const declaredNames = [...nativeTestNames].sort();
for (const macro of ["DEFINE", "REGISTER", "UNREGISTER"]) {
  const expression = new RegExp(`^\\+\\s*AST_TEST_${macro}\\(([a-z][a-z0-9_]*)\\)`, "gm");
  const names = [...patchText.matchAll(expression)].map((match) => match[1]).sort();
  if (JSON.stringify(names) !== JSON.stringify(declaredNames)) {
    throw new Error(`Native-test inventory differs from added AST_TEST_${macro} source`);
  }
}
for (const file of manifest.files) {
  if (
    !/^[a-f0-9]{64}$/.test(file.afterSha256) ||
    (file.path === "tests/test_bounded_queue_policy.c"
      ? file.beforeSha256 !== null
      : !/^[a-f0-9]{64}$/.test(file.beforeSha256))
  ) {
    throw new Error(`Invalid preimage/postimage hash: ${file.path}`);
  }
}
if (args.length) {
  const source = path.resolve(args[1]);
  for (const file of manifest.files) {
    const filename = path.join(source, ...file.path.split("/"));
    if (file.beforeSha256 === null) {
      try {
        lstatSync(filename);
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      throw new Error(`New test path already exists: ${filename}`);
    }
    if (sha256(readRegular(filename)) !== file.beforeSha256) {
      throw new Error(`Source preimage mismatch: ${file.path}`);
    }
  }
  execFileSync("git", ["-C", source, "-c", "core.autocrlf=false", "apply", "--check", "--whitespace=error-all", patchFile], {
    stdio: "inherit",
    timeout: 30_000,
  });
}
console.log(JSON.stringify({
  status: "source-package-checked",
  patchSha256: manifest.patchSha256,
  sourcePreimagesAndDryRunChecked: args.length !== 0,
  nativeCompiled: false,
  nativeTestsExecuted: false,
  runtimeApplyAuthorized: false,
}, null, 2));
