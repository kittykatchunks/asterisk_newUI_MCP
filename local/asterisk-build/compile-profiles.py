import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess

from shutdown_compile_binding import (
    load_ao2_accounting_supplement,
    load_cli_output_supplement,
    load_loader_lifecycle_supplement,
    load_shutdown_supplement,
    verify_ao2_accounting_basis,
    verify_ao2_accounting_postimages,
    verify_cli_output_basis,
    verify_cli_output_postimages,
    verify_loader_lifecycle_basis,
    verify_loader_lifecycle_postimages,
)


parser = argparse.ArgumentParser()
parser.add_argument("--approve-native-compile", action="store_true")
parser.add_argument("--attempt", type=int, required=True)
parser.add_argument("--shutdown-supplement-manifest")
parser.add_argument("--cli-output-supplement-manifest")
parser.add_argument("--ao2-accounting-supplement-manifest")
parser.add_argument("--loader-lifecycle-supplement-manifest")
args = parser.parse_args()
if not args.approve_native_compile or args.attempt < 1 or os.geteuid() == 0:
    raise SystemExit("Requires an unprivileged user and explicit --approve-native-compile")
if args.cli_output_supplement_manifest and not args.shutdown_supplement_manifest:
    raise SystemExit("CLI output supplement requires --shutdown-supplement-manifest")
if args.ao2_accounting_supplement_manifest and not args.cli_output_supplement_manifest:
    raise SystemExit("AO2 accounting supplement requires --cli-output-supplement-manifest")
if args.loader_lifecycle_supplement_manifest and not args.ao2_accounting_supplement_manifest:
    raise SystemExit("Loader lifecycle supplement requires --ao2-accounting-supplement-manifest")
home = pathlib.Path("/home/asterisk-build")
staging = home / "source-staging"
source_lock = json.loads((staging / "source-lock.json").read_text())
module_plan = json.loads((staging / "module-plan.json").read_text())
candidate = json.loads((staging / "queue-policy-v1.json").read_text())
patch = staging / "queue-policy-v1.patch"
shutdown_supplement = None
shutdown_supplement_patch = None
shutdown_supplement_hash = None
shutdown_supplement_manifest_hash = None
cli_output_supplement = None
cli_output_supplement_patch = None
cli_output_supplement_hash = None
cli_output_supplement_manifest_hash = None
ao2_accounting_supplement = None
ao2_accounting_supplement_patch = None
ao2_accounting_supplement_hash = None
ao2_accounting_supplement_manifest_hash = None
loader_lifecycle_supplement = None
loader_lifecycle_supplement_patch = None
loader_lifecycle_supplement_hash = None
loader_lifecycle_supplement_manifest_hash = None
if args.shutdown_supplement_manifest:
    (
        shutdown_supplement,
        shutdown_supplement_patch,
        shutdown_supplement_hash,
        shutdown_supplement_manifest_hash,
    ) = load_shutdown_supplement(args.shutdown_supplement_manifest, candidate)
if args.cli_output_supplement_manifest:
    (
        cli_output_supplement,
        cli_output_supplement_patch,
        cli_output_supplement_hash,
        cli_output_supplement_manifest_hash,
    ) = load_cli_output_supplement(
        args.cli_output_supplement_manifest,
        candidate,
        shutdown_supplement,
        shutdown_supplement_manifest_hash,
    )
if args.ao2_accounting_supplement_manifest:
    (
        ao2_accounting_supplement,
        ao2_accounting_supplement_patch,
        ao2_accounting_supplement_hash,
        ao2_accounting_supplement_manifest_hash,
    ) = load_ao2_accounting_supplement(
        args.ao2_accounting_supplement_manifest,
        candidate,
        shutdown_supplement,
        shutdown_supplement_manifest_hash,
        cli_output_supplement,
        cli_output_supplement_manifest_hash,
    )
if args.loader_lifecycle_supplement_manifest:
    (
        loader_lifecycle_supplement,
        loader_lifecycle_supplement_patch,
        loader_lifecycle_supplement_hash,
        loader_lifecycle_supplement_manifest_hash,
    ) = load_loader_lifecycle_supplement(
        args.loader_lifecycle_supplement_manifest,
        candidate,
        shutdown_supplement,
        shutdown_supplement_manifest_hash,
        cli_output_supplement,
        cli_output_supplement_manifest_hash,
        ao2_accounting_supplement,
        ao2_accounting_supplement_manifest_hash,
    )
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
if shutdown_supplement is not None:
    report["shutdownSupplementPatchSha256"] = shutdown_supplement_hash
    report["shutdownSupplementManifestSha256"] = shutdown_supplement_manifest_hash
    report["shutdownSupplementParentPatchSha256"] = candidate["patchSha256"]
if cli_output_supplement is not None:
    report["cliOutputSupplementPatchSha256"] = cli_output_supplement_hash
    report["cliOutputSupplementManifestSha256"] = cli_output_supplement_manifest_hash
    report["cliOutputSupplementParentPatchSha256"] = candidate["patchSha256"]
    report["cliOutputSupplementParentSupplementPatchSha256"] = shutdown_supplement_hash
    report["cliOutputSupplementParentSupplementManifestSha256"] = (
        shutdown_supplement_manifest_hash
    )
if ao2_accounting_supplement is not None:
    report["ao2AccountingSupplementPatchSha256"] = ao2_accounting_supplement_hash
    report["ao2AccountingSupplementManifestSha256"] = ao2_accounting_supplement_manifest_hash
    report["ao2AccountingSupplementParentPatchSha256"] = candidate["patchSha256"]
    report["ao2AccountingSupplementParentSupplementPatchSha256"] = shutdown_supplement_hash
    report["ao2AccountingSupplementParentSupplementManifestSha256"] = (
        shutdown_supplement_manifest_hash
    )
    report["ao2AccountingSupplementParentOutputSupplementPatchSha256"] = (
        cli_output_supplement_hash
    )
    report["ao2AccountingSupplementParentOutputSupplementManifestSha256"] = (
        cli_output_supplement_manifest_hash
    )
if loader_lifecycle_supplement is not None:
    report["loaderLifecycleSupplementPatchSha256"] = loader_lifecycle_supplement_hash
    report["loaderLifecycleSupplementManifestSha256"] = (
        loader_lifecycle_supplement_manifest_hash
    )
    report["loaderLifecycleSupplementParentPatchSha256"] = candidate["patchSha256"]
    report["loaderLifecycleSupplementParentSupplementPatchSha256"] = (
        shutdown_supplement_hash
    )
    report["loaderLifecycleSupplementParentSupplementManifestSha256"] = (
        shutdown_supplement_manifest_hash
    )
    report["loaderLifecycleSupplementParentOutputSupplementPatchSha256"] = (
        cli_output_supplement_hash
    )
    report["loaderLifecycleSupplementParentOutputSupplementManifestSha256"] = (
        cli_output_supplement_manifest_hash
    )
    report["loaderLifecycleSupplementParentAccountingSupplementPatchSha256"] = (
        ao2_accounting_supplement_hash
    )
    report["loaderLifecycleSupplementParentAccountingSupplementManifestSha256"] = (
        ao2_accounting_supplement_manifest_hash
    )
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
    supplement_application = None
    if shutdown_supplement is not None:
        run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1", "-i", shutdown_supplement_patch])
        run(["patch", "--batch", "--fuzz=0", "-p1", "-i", shutdown_supplement_patch])
        supplement_postimages = [
            dict(
                path=relative,
                sha256=hashlib.sha256((tree / relative).read_bytes()).hexdigest(),
            )
            for relative in shutdown_supplement["changedUpstreamPaths"]
        ]
        supplement_application = dict(
            patchSha256=shutdown_supplement_hash,
            appliedWithZeroFuzz=True,
            postimages=supplement_postimages,
        )
    cli_output_application = None
    if cli_output_supplement is not None:
        verify_cli_output_basis(tree, cli_output_supplement)
        run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1",
             "-i", cli_output_supplement_patch])
        run(["patch", "--batch", "--fuzz=0", "-p1", "-i", cli_output_supplement_patch])
        cli_output_application = dict(
            patchSha256=cli_output_supplement_hash,
            appliedWithZeroFuzz=True,
            postimages=verify_cli_output_postimages(tree, cli_output_supplement),
        )
    ao2_accounting_application = None
    if ao2_accounting_supplement is not None:
        verify_ao2_accounting_basis(tree, ao2_accounting_supplement)
        run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1",
             "-i", ao2_accounting_supplement_patch])
        run(["patch", "--batch", "--fuzz=0", "-p1", "-i", ao2_accounting_supplement_patch])
        ao2_accounting_application = dict(
            patchSha256=ao2_accounting_supplement_hash,
            appliedWithZeroFuzz=True,
            postimages=verify_ao2_accounting_postimages(tree, ao2_accounting_supplement),
        )
    loader_lifecycle_application = None
    if loader_lifecycle_supplement is not None:
        verify_loader_lifecycle_basis(tree, loader_lifecycle_supplement)
        run(["patch", "--batch", "--fuzz=0", "--dry-run", "-p1",
             "-i", loader_lifecycle_supplement_patch])
        run(["patch", "--batch", "--fuzz=0", "-p1", "-i", loader_lifecycle_supplement_patch])
        loader_lifecycle_application = dict(
            patchSha256=loader_lifecycle_supplement_hash,
            appliedWithZeroFuzz=True,
            postimages=verify_loader_lifecycle_postimages(tree, loader_lifecycle_supplement),
        )
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
    options = ["menuselect/menuselect", "--disable-all", "--enable", "OPTIONAL_API"]
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
    required = set(modules) | {"OPTIONAL_API"}
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
    if supplement_application is not None:
        profile_record["shutdownSupplement"] = supplement_application
    if cli_output_application is not None:
        profile_record["cliOutputSupplement"] = cli_output_application
    if ao2_accounting_application is not None:
        profile_record["ao2AccountingSupplement"] = ao2_accounting_application
    if loader_lifecycle_application is not None:
        profile_record["loaderLifecycleSupplement"] = loader_lifecycle_application
    report["profiles"].append(profile_record)
    (build_root / "compile-report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"COMPILED_PROFILE={profile} REQUIRED_OUTPUTS={len(binaries)}", flush=True)
print("BOTH_PROFILES_COMPILED_NO_ASTERISK_RUNTIME_OR_NATIVE_TEST_EXECUTION", flush=True)
