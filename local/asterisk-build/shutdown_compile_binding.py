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
