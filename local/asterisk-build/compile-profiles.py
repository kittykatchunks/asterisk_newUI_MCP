import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess


parser = argparse.ArgumentParser()
parser.add_argument("--approve-native-compile", action="store_true")
parser.add_argument("--attempt", type=int, required=True)
args = parser.parse_args()
if not args.approve_native_compile or args.attempt < 1 or os.geteuid() == 0:
    raise SystemExit("Requires an unprivileged user and explicit --approve-native-compile")
home = pathlib.Path("/home/asterisk-build")
staging = home / "source-staging"
source_lock = json.loads((staging / "source-lock.json").read_text())
module_plan = json.loads((staging / "module-plan.json").read_text())
candidate = json.loads((staging / "queue-policy-v1.json").read_text())
patch = staging / "queue-policy-v1.patch"
if hashlib.sha256(patch.read_bytes()).hexdigest() != candidate["patchSha256"]:
    raise ValueError("Patch SHA256 differs from approved candidate")
if candidate["patchSha256"] != module_plan["patchSha256"]:
    raise ValueError("Module plan is bound to a different patch")
if candidate["upstreamCommit"] != source_lock["sources"][0]["revision"]:
    raise ValueError("Source revision differs from approved candidate")
for source in source_lock["sources"]:
    archive = staging / source["filename"]
    if hashlib.sha256(archive.read_bytes()).hexdigest() != source["sha256"]:
        raise ValueError(f"Staged source archive hash mismatch: {source['name']}")
pristine = pathlib.Path(source_lock["asteriskSourceDirectory"])
for entry in candidate["files"]:
    path = pristine / entry["path"]
    if entry["beforeSha256"] is None:
        if path.exists():
            raise ValueError(f"New file exists in pristine source: {entry['path']}")
    elif hashlib.sha256(path.read_bytes()).hexdigest() != entry["beforeSha256"]:
        raise ValueError(f"Pristine source hash mismatch: {entry['path']}")
build_root = home / f"native-build-attempt-{args.attempt}"
build_root.mkdir()
report = {
    "schemaVersion": 1,
    "upstreamCommit": candidate["upstreamCommit"],
    "patchSha256": candidate["patchSha256"],
    "profiles": [],
    "nativeTestsExecuted": False,
    "asteriskStarted": False,
    "runtimeApplyAuthorized": False,
}
for profile in ["instrumented", "release"]:
    tree = build_root / profile
    shutil.copytree(pristine, tree)
    def run(arguments):
        print(f"RUN {profile}: " + " ".join(map(str, arguments)), flush=True)
        subprocess.run(list(map(str, arguments)), cwd=tree, check=True)

    run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1", "-i", patch])
    run(["patch", "--batch", "--fuzz=0", "-p1", "-i", patch])
    for entry in candidate["files"]:
        if hashlib.sha256((tree / entry["path"]).read_bytes()).hexdigest() != entry["afterSha256"]:
            raise ValueError(f"Patched source hash mismatch: {entry['path']}")
    configure = [
        "./configure",
        f"--prefix={home}/install/{profile}",
        "--with-pjproject-bundled",
        "--without-jansson-bundled",
        "--without-libjwt-bundled",
        "--without-libjwt",
        f"--with-externals-cache={staging}",
        "--disable-xmldoc",
    ]
    if profile == "instrumented":
        configure.append("--enable-dev-mode")
    run(configure)
    run(["make", "menuselect.makeopts"])
    options = ["menuselect/menuselect", "--disable-all"]
    modules = sorted(module_plan["resolvedRuntimeModules"])
    if profile == "instrumented":
        modules += module_plan["testOnlyModules"]
        options += ["--enable", "TEST_FRAMEWORK"]
    for module in modules:
        options += ["--enable", module]
    options += ["menuselect.makeopts"]
    run(options)
    run(["menuselect/menuselect", "--check-deps", "menuselect.makeopts"])
    categories = subprocess.check_output(
        ["menuselect/menuselect", "--category-list", "menuselect.makeopts"],
        cwd=tree, text=True,
    ).splitlines()
    selected = ""
    for category in categories:
        selected += subprocess.check_output(
            ["menuselect/menuselect", "--list-category", category, "menuselect.makeopts"],
            cwd=tree, text=True,
        )
    (tree / "selected-options.txt").write_text(selected)
    enabled = {line.split()[1] for line in selected.splitlines() if line.startswith("+ ")}
    required = set(modules)
    if profile == "instrumented":
        required.add("TEST_FRAMEWORK")
    if not required.issubset(enabled):
        raise ValueError(f"Menuselect rejected required options: {sorted(required - enabled)}")
    forbidden = {"BUILD_NATIVE", "COMPILE_DOUBLE"}
    if profile == "release":
        forbidden.update(module_plan["testOnlyModules"])
        forbidden.add("TEST_FRAMEWORK")
    if enabled & forbidden:
        raise ValueError(f"Forbidden build options enabled: {sorted(enabled & forbidden)}")
    run(["make", "-j4", "all"])
    binaries = [tree / "main" / "asterisk"]
    support_libraries = sorted((tree / "main").glob("libasterisk*.so"))
    if {path.name for path in support_libraries} != {"libasteriskpj.so", "libasteriskssl.so"}:
        raise ValueError(f"Unexpected core support libraries: {support_libraries}")
    binaries.extend(support_libraries)
    for module in modules:
        matches = list(tree.glob(f"*/{module}.so"))
        if len(matches) != 1:
            raise ValueError(f"Expected exactly one compiled module for {module}: {matches}")
        binaries.extend(matches)
    if profile == "release":
        for module in module_plan["testOnlyModules"]:
            if list(tree.glob(f"*/{module}.so")):
                raise ValueError(f"Test module present in release profile: {module}")
    profile_record = dict(
        name=profile,
        compiled=True,
        supportLibraries=[path.name for path in support_libraries],
        configureArguments=configure,
        enabledOptions=sorted(enabled),
        outputs=[
            dict(path=str(path.relative_to(tree)),
                 sha256=hashlib.sha256(path.read_bytes()).hexdigest())
            for path in binaries
        ],
        menuselectMakeoptsSha256=hashlib.sha256((tree / "menuselect.makeopts").read_bytes()).hexdigest(),
        autoconfigSha256=hashlib.sha256((tree / "include/asterisk/autoconfig.h").read_bytes()).hexdigest(),
    )
    report["profiles"].append(profile_record)
    (build_root / "compile-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"COMPILED_PROFILE={profile} REQUIRED_OUTPUTS={len(binaries)}", flush=True)
print("BOTH_PROFILES_COMPILED_NO_ASTERISK_RUNTIME_OR_NATIVE_TEST_EXECUTION", flush=True)
