import hashlib
import json
import pathlib
import re
import stat


EXPECTED_PATHS = [
    "include/asterisk/module.h",
    "main/loader.c",
    "main/asterisk.c",
]
EXPECTED_OUTPUT_PATHS = [
    "apps/app_queue.c",
    "tests/test_bounded_queue_policy.c",
    "tests/test_protected_cli_target.c",
]


def _read_regular_file(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode):
        raise ValueError(f"Expected a regular, non-symlink file: {path}")
    return path.read_bytes()


def load_shutdown_supplement(manifest_path, parent_manifest):
    manifest_path = pathlib.Path(manifest_path).absolute()
    manifest_bytes = _read_regular_file(manifest_path)
    manifest = json.loads(manifest_bytes)
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("stage") != "source-only-shutdown-supervisor-scaffold"
        or manifest.get("upstreamCommit") != parent_manifest["upstreamCommit"]
        or manifest.get("parentManifest") != "queue-policy-v1.json"
        or manifest.get("parentPatchSha256") != parent_manifest["patchSha256"]
        or manifest.get("patch") != "queue-policy-shutdown-v1.patch"
        or manifest.get("changedUpstreamPaths") != EXPECTED_PATHS
        or manifest.get("nativeCompiled") is not False
        or manifest.get("nativeTestsExecuted") is not False
        or manifest.get("patchApplicationVerified") is not False
        or manifest.get("runtimeApplyAuthorized") is not False
        or manifest.get("gatesBAndCApproved") is not False
    ):
        raise ValueError("Shutdown supplement does not match the pinned parent candidate")

    patch_path = manifest_path.parent / manifest["patch"]
    patch_bytes = _read_regular_file(patch_path)
    patch_hash = hashlib.sha256(patch_bytes).hexdigest()
    if manifest.get("patchSha256") != patch_hash:
        raise ValueError("Shutdown supplement patch SHA256 mismatch")
    patch_text = patch_bytes.decode("utf-8")
    patch_paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch_text, re.MULTILINE)
    if patch_paths != [(path, path) for path in EXPECTED_PATHS]:
        raise ValueError("Shutdown supplement diff paths differ from its manifest")

    return manifest, patch_path, patch_hash, hashlib.sha256(manifest_bytes).hexdigest()


def load_cli_output_supplement(
    manifest_path, parent_manifest, shutdown_manifest, shutdown_manifest_hash
):
    manifest_path = pathlib.Path(manifest_path).absolute()
    manifest_bytes = _read_regular_file(manifest_path)
    manifest = json.loads(manifest_bytes)
    if not isinstance(manifest, dict):
        raise ValueError("CLI output supplement manifest must be an object")
    if (
        manifest.get("schemaVersion") != 1
        or manifest.get("stage") != "source-only-cli-output-fixtures-prepared"
        or manifest.get("upstreamCommit") != parent_manifest["upstreamCommit"]
        or manifest.get("parentManifest") != "queue-policy-v1.json"
        or manifest.get("parentPatchSha256") != parent_manifest["patchSha256"]
        or manifest.get("parentSupplementManifest") != "queue-policy-shutdown-v1.json"
        or manifest.get("parentSupplementManifestSha256") != shutdown_manifest_hash
        or manifest.get("parentSupplementPatchSha256") != shutdown_manifest["patchSha256"]
        or manifest.get("patch") != "queue-policy-output-v1.patch"
        or manifest.get("changedUpstreamPaths") != EXPECTED_OUTPUT_PATHS
        or manifest.get("nativeCompiled") is not False
        or manifest.get("nativeTestsExecuted") is not False
        or manifest.get("asteriskStarted") is not False
        or manifest.get("runtimeApplyAuthorized") is not False
        or manifest.get("gatesBAndCApproved") is not False
    ):
        raise ValueError("CLI output supplement does not match the pinned parent supplements")

    if not re.fullmatch(r"[0-9a-f]{64}", shutdown_manifest_hash or ""):
        raise ValueError("CLI output supplement has invalid parent supplement manifest hash")
    for field in ("basisCompileReportSha256", "basisNativeReportSha256"):
        value = manifest.get(field)
        if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
            raise ValueError(f"CLI output supplement has invalid {field}")
    for field in ("basisSourceSha256",):
        hashes = manifest.get(field)
        if (
            not isinstance(hashes, dict)
            or list(hashes) != EXPECTED_OUTPUT_PATHS
            or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
                   for value in hashes.values())
        ):
            raise ValueError(f"CLI output supplement has invalid {field}")
    application = manifest.get("applicationVerification", {})
    if not isinstance(application, dict):
        raise ValueError("CLI output supplement has invalid application evidence")
    postimages = application.get("postimageSha256")
    if (
        not isinstance(postimages, dict)
        or list(postimages) != EXPECTED_OUTPUT_PATHS
        or any(not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value)
               for value in postimages.values())
        or application.get("patchDryRunSucceeded") is not True
        or application.get("zeroFuzz") is not True
        or application.get("zeroOffset") is not True
        or application.get("appliedToTemporarySourceCopy") is not True
        or application.get("originalSuccessorSourceModified") is not False
    ):
        raise ValueError("CLI output supplement has invalid application evidence")

    patch_path = manifest_path.parent / manifest["patch"]
    patch_bytes = _read_regular_file(patch_path)
    patch_hash = hashlib.sha256(patch_bytes).hexdigest()
    if manifest.get("patchSha256") != patch_hash:
        raise ValueError("CLI output supplement patch SHA256 mismatch")
    patch_text = patch_bytes.decode("utf-8")
    patch_paths = re.findall(r"^diff --git a/(\S+) b/(\S+)$", patch_text, re.MULTILINE)
    if patch_paths != [(path, path) for path in EXPECTED_OUTPUT_PATHS]:
        raise ValueError("CLI output supplement diff paths differ from its manifest")

    return manifest, patch_path, patch_hash, hashlib.sha256(manifest_bytes).hexdigest()


def verify_cli_output_basis(tree, manifest):
    for relative, expected in manifest["basisSourceSha256"].items():
        path = pathlib.Path(tree) / relative
        if hashlib.sha256(_read_regular_file(path)).hexdigest() != expected:
            raise ValueError(f"CLI output supplement source preimage mismatch: {relative}")


def verify_cli_output_postimages(tree, manifest):
    postimages = manifest["applicationVerification"]["postimageSha256"]
    records = []
    for relative in EXPECTED_OUTPUT_PATHS:
        digest = hashlib.sha256(_read_regular_file(pathlib.Path(tree) / relative)).hexdigest()
        if digest != postimages[relative]:
            raise ValueError(f"CLI output supplement source postimage mismatch: {relative}")
        records.append(dict(path=relative, sha256=digest))
    return records
