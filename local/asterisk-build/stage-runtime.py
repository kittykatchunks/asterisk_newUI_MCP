import argparse
import hashlib
import json
import os
import pathlib
import subprocess

from shutdown_compile_binding import validate_cli_output_compile_report


parser = argparse.ArgumentParser()
parser.add_argument("--approve-local-staging", action="store_true")
parser.add_argument("--attempt", type=int, required=True)
parser.add_argument("--build-attempt", type=int, default=4)
parser.add_argument("--smoke-attempt", type=int, default=4)
parser.add_argument("--startup-validation", type=pathlib.Path)
args = parser.parse_args()
if (not args.approve_local_staging
        or min(args.attempt, args.build_attempt, args.smoke_attempt) < 1
        or os.geteuid() == 0):
    raise SystemExit("Explicit local staging approval and unprivileged user required")
home = pathlib.Path("/home/asterisk-build")
build = home / f"native-build-attempt-{args.build_attempt}"
tree = build / "release"
compile_path = build / "compile-report.json"
compile_report = json.loads(compile_path.read_text())
validate_cli_output_compile_report(compile_report)
smoke = json.loads(
    (home / f"full-module-smoke-attempt-{args.smoke_attempt}/release-smoke-report.json")
    .read_text()
)
source_lock = json.loads((home / "source-staging/source-lock.json").read_text())
profile = next(item for item in compile_report["profiles"] if item["name"] == "release")
if smoke["compileReportSha256"] != hashlib.sha256(compile_path.read_bytes()).hexdigest():
    raise ValueError("Full startup evidence is not bound to the selected release")
if not smoke["passed"] or len(smoke["loadedModules"]) != 41:
    raise ValueError("Full module startup evidence is incomplete")
startup_validation = args.startup_validation or home / "full-startup-validation.json"
startup = json.loads(startup_validation.read_text())
if (startup.get("buildAttempt", args.build_attempt) != args.build_attempt
        or startup.get("compileReportSha256") not in (
            None, hashlib.sha256(compile_path.read_bytes()).hexdigest()
        )
        or startup.get("fullStartupModules") != 41):
    raise ValueError("Full-startup validation does not bind the selected release")
root = home / f"runtime-bundle-attempt-{args.attempt}"
root.mkdir(mode=0o700)


def copy_verified(source, destination, expected=None):
    data = source.read_bytes()
    if expected is not None and hashlib.sha256(data).hexdigest() != expected:
        raise ValueError(f"Source hash mismatch: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        if destination.read_bytes() != data:
            raise ValueError(f"Destination collision: {destination}")
        return
    with destination.open("xb") as output:
        output.write(data)
    destination.chmod(source.stat().st_mode & 0o777)


for output in profile["outputs"]:
    copy_verified(tree / output["path"], root / output["path"], output["sha256"])
system_libraries = {}
copyright_files = {}
for soname, entry in smoke["resolvedLibraries"].items():
    source = pathlib.Path(entry["path"])
    if source.parent == tree / "main":
        destination = root / "main" / soname
    else:
        destination = root / "runtime-libs" / soname
        system_libraries[soname] = dict(source=str(source), sha256=entry["sha256"])
        candidates = [str(source)]
        if str(source).startswith("/usr/"):
            candidates.append(str(source)[4:])
        owners = set()
        for candidate in candidates:
            result = subprocess.run(["dpkg-query", "-S", candidate], capture_output=True, text=True)
            if result.returncode not in (0, 1):
                raise RuntimeError(f"dpkg ownership query failed: {result.stderr}")
            for line in result.stdout.splitlines():
                if ": " in line:
                    owners.add(line.split(": ", 1)[0])
        if not owners:
            raise ValueError(f"No installed package owns runtime library: {source}")
        for owner in owners:
            package = owner.split(":", 1)[0]
            notice = pathlib.Path("/usr/share/doc") / package / "copyright"
            if not notice.is_file():
                raise ValueError(f"Missing dependency copyright: {package}")
            target = root / "notices/dependencies" / package / "copyright"
            copy_verified(notice, target)
            copyright_files[owner] = str(target.relative_to(root))
    copy_verified(source, destination, entry["sha256"])

for name, source in {
    "asterisk-LICENSE": tree / "LICENSE",
    "asterisk-COPYING": tree / "COPYING",
    "pjproject-COPYING": tree / "third-party/pjproject/source/COPYING",
    "GPL-2": pathlib.Path("/usr/share/common-licenses/GPL-2"),
    "LGPL-2.1": pathlib.Path("/usr/share/common-licenses/LGPL-2.1"),
}.items():
    copy_verified(source, root / "notices" / name)
locale = pathlib.Path("/usr/lib/locale/C.utf8")
if not locale.is_dir():
    raise ValueError("Asterisk requires C.UTF-8 locale data for this runtime")
for source in locale.rglob("*"):
    if source.is_file():
        copy_verified(source, root / "runtime-locale/C.utf8" / source.relative_to(locale))
gconv = pathlib.Path("/usr/lib/x86_64-linux-gnu/gconv")
if not gconv.is_dir():
    raise ValueError("Missing glibc character-conversion data directory")
for source in gconv.rglob("*"):
    if source.is_file():
        copy_verified(source, root / "runtime-gconv" / source.relative_to(gconv))
nss_integrity = subprocess.run(["dpkg", "-V", "libnss3:amd64"],
                               capture_output=True, text=True, check=True)
if nss_integrity.stdout or nss_integrity.stderr:
    raise ValueError(f"NSS installed-package integrity failure: {nss_integrity}")
nss_paths = subprocess.check_output(["dpkg-query", "-L", "libnss3:amd64"], text=True).splitlines()
nss_runtime = {}
for name in nss_paths:
    source = pathlib.Path(name)
    if source.suffix not in (".so", ".chk"):
        continue
    if source.parent != pathlib.Path("/usr/lib/x86_64-linux-gnu"):
        raise ValueError(f"Unexpected NSS runtime package path: {source}")
    copy_verified(source, root / "runtime-libs" / source.name)
    nss_runtime[source.name] = hashlib.sha256(source.read_bytes()).hexdigest()
if not {"libsoftokn3.so", "libsoftokn3.chk", "libfreeblpriv3.so",
        "libfreeblpriv3.chk"}.issubset(nss_runtime):
    raise ValueError("NSS dynamic crypto module/integrity closure is incomplete")
for source in source_lock["sources"]:
    copy_verified(home / "source-staging" / source["filename"],
                  root / "sources" / source["filename"], source["sha256"])
patch_records = home / "local/asterisk-patches"
for name in [
    "queue-policy-v1.patch",
    "queue-policy-v1.json",
    "queue-policy-shutdown-v1.patch",
    "queue-policy-shutdown-v1.json",
    "queue-policy-output-v1.patch",
    "queue-policy-output-v1.json",
    "queue-policy-accounting-v1.patch",
    "queue-policy-accounting-v1.json",
    "queue-policy-loader-v1.patch",
    "queue-policy-loader-v1.json",
    "queue-policy-unregister-v1.patch",
    "queue-policy-unregister-v1.json",
]:
    copy_verified(patch_records / name, root / "build-records" / name)
unregister_manifest_path = patch_records / "queue-policy-unregister-v1.json"
unregister_manifest = json.loads(unregister_manifest_path.read_text())
if (
    unregister_manifest["patchSha256"]
    != compile_report["protectedUnregisterSupplementPatchSha256"]
    or hashlib.sha256(unregister_manifest_path.read_bytes()).hexdigest()
    != compile_report["protectedUnregisterSupplementManifestSha256"]
):
    raise ValueError("Protected unregister source record differs from the compile report")
copy_verified(
    patch_records / unregister_manifest["patch"],
    root / "build-records" / unregister_manifest["patch"],
    unregister_manifest["patchSha256"],
)
copy_verified(
    unregister_manifest_path,
    root / "build-records/queue-policy-unregister-v1.json",
    compile_report["protectedUnregisterSupplementManifestSha256"],
)
registration_manifest_path = patch_records / "queue-policy-registration-v1.json"
if "registrationFailureSupplementPatchSha256" in compile_report:
    registration_manifest = json.loads(registration_manifest_path.read_text())
    if (
        registration_manifest["patchSha256"]
        != compile_report["registrationFailureSupplementPatchSha256"]
        or hashlib.sha256(registration_manifest_path.read_bytes()).hexdigest()
        != compile_report["registrationFailureSupplementManifestSha256"]
    ):
        raise ValueError("Registration failure source record differs from the compile report")
    copy_verified(
        patch_records / registration_manifest["patch"],
        root / "build-records" / registration_manifest["patch"],
        registration_manifest["patchSha256"],
    )
    copy_verified(
        registration_manifest_path,
        root / "build-records/queue-policy-registration-v1.json",
        compile_report["registrationFailureSupplementManifestSha256"],
    )
for name in [
    "source-lock.json",
    "module-plan.json",
]:
    copy_verified(home / "source-staging" / name, root / "build-records" / name)
for name in [
    "compile-profiles.py",
    "compile-profiles-accounting-v1.py",
    "shutdown_compile_binding.py",
    "shutdown_compile_binding-accounting-v1.py",
    "install-locked-packages.py",
    "stage-runtime.py",
    "smoke-release.py",
    "verify-full-startup.py",
]:
    copy_verified(home / "local/asterisk-build" / name, root / "build-records" / name)
copy_verified(compile_path, root / "build-records/compile-report.json")
copy_verified(startup_validation, root / "build-records/full-startup-validation.json")
for name in ["dependency-lock.json", "installed-packages.tsv"]:
    copy_verified(pathlib.Path("/var/lib/asterisk-build-preparation") / name,
                  root / "build-records" / name)
record = dict(
    schemaVersion=1, stage="local-runtime-bundle-staged-not-redistribution-approved",
    patchSha256=compile_report["patchSha256"],
    compileReportSha256=hashlib.sha256(compile_path.read_bytes()).hexdigest(),
    root=str(root), releaseOutputs=44, runtimeModules=41,
    systemLibraries=system_libraries, dependencyCopyrightFiles=copyright_files,
    runtimeApplyAuthorized=False, hostExported=False, redistributionApproved=False,
    licenseClosureComplete=False, packagedRuntimeExecuted=False,
    locale="C.UTF-8", localeDataIncluded=True, glibcConversionDataIncluded=True,
    nssRuntimePackage="libnss3:amd64", nssInstalledPackageIntegrityVerified=True,
    nssRuntimeFiles=nss_runtime,
    entries=[
        dict(path=str(path.relative_to(root)), bytes=path.stat().st_size,
             sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
             mode=oct(path.stat().st_mode & 0o777))
        for path in sorted(root.rglob("*")) if path.is_file()
    ],
)
(root / "bundle-manifest.json").write_text(json.dumps(record, indent=2) + "\n")
print(f"LOCAL_BUNDLE_STAGED files={len(record['entries'])} bytes={sum(e['bytes'] for e in record['entries'])}")
print("NO_HOST_EXPORT_OR_DISTRIBUTION_LICENSE_APPROVAL")
