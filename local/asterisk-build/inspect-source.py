import hashlib
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET


payload = json.load(sys.stdin)
staging = pathlib.Path("/home/asterisk-build/source-staging")
source_lock = json.loads((staging / "source-lock.json").read_text())
tree = pathlib.Path(source_lock["asteriskSourceDirectory"])
candidate = payload["candidate"]
for entry in candidate["files"]:
    path = tree / entry["path"]
    expected = entry["beforeSha256"]
    if expected is None:
        if path.exists():
            raise ValueError(f"New patch path already exists: {entry['path']}")
    elif hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise ValueError(f"Pristine source hash mismatch: {entry['path']}")

requested = re.findall(r"^\s*load\s*=\s*(\w+)\.so\s*$", payload["modules"], re.MULTILINE)
if not requested:
    raise ValueError("Runtime module list is empty")
paths = {
    path.stem: path
    for directory in ["apps", "bridges", "cdr", "cel", "channels", "codecs",
                      "formats", "funcs", "pbx", "res", "tests"]
    for path in (tree / directory).glob("*")
    if path.suffix in [".c", ".cc"]
}
resolved = {}
pending = list(requested)
while pending:
    name = pending.pop()
    if name in resolved:
        continue
    if name not in paths:
        raise ValueError(f"Required module source missing: {name}")
    path = paths[name]
    info = re.search(r"/\*\*\* MODULEINFO\s+(.*?)\*/", path.read_text(), re.DOTALL)
    dependencies = []
    if info:
        node = ET.fromstring("<module>" + info[1] + "</module>")
        dependencies = [element.text.strip() for element in node.findall("depend")]
    module_deps = [dependency for dependency in dependencies if dependency in paths]
    pending.extend(module_deps)
    resolved[name] = dict(
        source=str(path.relative_to(tree)),
        moduleDependencies=module_deps,
        externalDependencies=[dep for dep in dependencies if dep not in paths],
    )
record = dict(
    schemaVersion=1,
    stage="source-inspected-not-configured",
    upstreamCommit=candidate["upstreamCommit"],
    patchSha256=candidate["patchSha256"],
    verifiedPristinePaths=len(candidate["files"]),
    requestedModules=requested,
    resolvedRuntimeModules=dict(sorted(resolved.items())),
    testOnlyModules=["test_bounded_queue_policy", "test_protected_cli_target"],
    testOnlyCompilerOption="TEST_FRAMEWORK",
    menuselectDependencyCheckExecuted=False,
    nativeCompiled=False,
)
(staging / "module-plan.json").write_text(json.dumps(record, indent=2) + "\n")
print(f"VERIFIED_PRISTINE_PATHS={len(candidate['files'])}")
print(f"REQUESTED_RUNTIME_MODULES={len(requested)}")
print(f"RESOLVED_RUNTIME_MODULES={len(resolved)}")
print("ADDED_MODULE_DEPENDENCIES=" + ",".join(sorted(set(resolved) - set(requested))))
print("EXTERNAL_DEPENDENCIES=" + ",".join(sorted({
    dep for module in resolved.values() for dep in module["externalDependencies"]
})))
print("NATIVE_CONFIGURE_COMPILE_AND_RUNTIME_NOT_EXECUTED")
