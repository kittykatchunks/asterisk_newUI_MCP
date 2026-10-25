import hashlib
import json
import pathlib


home = pathlib.Path("/home/asterisk-build")
root = home / "runtime-bundle-attempt-3"
manifest_path = root / "bundle-manifest.json"
manifest = json.loads(manifest_path.read_text())
smoke_path = home / "bundle-smoke-attempt-4/release-smoke-report.json"
smoke = json.loads(smoke_path.read_text())
compile_path = home / "native-build-attempt-4/compile-report.json"
compile_report = json.loads(compile_path.read_text())
profile = next(item for item in compile_report["profiles"] if item["name"] == "release")
assert manifest["compileReportSha256"] == hashlib.sha256(compile_path.read_bytes()).hexdigest()
assert smoke["compileReportSha256"] == manifest["compileReportSha256"]
assert smoke["bundleManifestSha256"] == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
expected = {entry["path"] for entry in manifest["entries"]}
actual = {str(path.relative_to(root)) for path in root.rglob("*") if path.is_file()}
assert actual == expected | {"bundle-manifest.json"}
for entry in manifest["entries"]:
    path = root / entry["path"]
    assert not path.is_symlink()
    assert path.stat().st_size == entry["bytes"]
    assert oct(path.stat().st_mode & 0o777) == entry["mode"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == entry["sha256"]
for output in profile["outputs"]:
    assert hashlib.sha256((root / output["path"]).read_bytes()).hexdigest() == output["sha256"]
assert not list(root.glob("tests/*.so"))
assert manifest["localeDataIncluded"] and manifest["glibcConversionDataIncluded"]
assert smoke["passed"] and smoke["allExpectedModulesRunning"]
assert len(smoke["loadedModules"]) == 41 and smoke["testCommandAbsent"]
assert smoke["pjsipEmptyObjectChecks"] == {
    "endpoints": "No objects found.", "transports": "No objects found."}
assert smoke["allFileBackedMappingsInsideBundle"]
assert set(smoke["mappedBundleFiles"]).issubset(expected)
for soname, library in smoke["resolvedLibraries"].items():
    path = pathlib.Path(library["path"])
    if soname == "ld-linux-x86-64.so.2":
        staged_loader = root / "runtime-libs" / soname
        assert "runtime-libs/" + soname in smoke["mappedBundleFiles"]
        assert hashlib.sha256(staged_loader.read_bytes()).hexdigest() == library["sha256"]
    else:
        assert path.is_relative_to(root)
    assert hashlib.sha256(path.read_bytes()).hexdigest() == library["sha256"]
assert smoke["ownedProcessStopped"] and smoke["processExitCode"] == 0
assert len(smoke["observations"]) == 5
assert [item["response"]["objects"][0]["memberTimeoutSeconds"]
        for item in smoke["observations"]] == [11, 11, 23, 23, 11]
assert [item["response"]["objects"][0]["strategy"]
        for item in smoke["observations"]] == ["ringall", "ringall", "linear", "linear", "ringall"]
for directory in home.glob("bundle-smoke-attempt-*/run"):
    assert not (directory / "asterisk.ctl").exists()
    assert not (directory / "asterisk.pid").exists()
for cmdline in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
    try:
        executable = cmdline.read_bytes().split(b"\0")[0]
    except (FileNotFoundError, ProcessLookupError):
        continue
    assert not executable.startswith(str(home / "runtime-bundle").encode())
record = dict(
    schemaVersion=1, stage="local-runtime-bundle-smoke-verified",
    patchSha256=compile_report["patchSha256"],
    compileReportSha256=manifest["compileReportSha256"],
    bundleAttempt=3, smokeAttempt=4,
    filesVerified=len(manifest["entries"]),
    payloadBytes=sum(entry["bytes"] for entry in manifest["entries"]),
    allPayloadHashesSizesModesAndExactInventoryVerified=True,
    allReleaseOutputsMatchCorrectedBuild=True,
    startupFileBackedMappingsAllInsideBundle=True,
    fullModuleStartupPassed=True, nativeTestModulesIncluded=False,
    loadedStateObservations=5, noOwnedBundleProcessesOrRuntimeEntriesRemain=True,
    runtimeApplyAuthorized=False, existingPbxOperated=False,
    containerImageProduced=False, hostExported=False,
    redistributionApproved=False, licenseClosureComplete=False,
    evidence={
        "runtime-bundle-manifest.json": dict(
            guestPath=str(manifest_path), sha256=hashlib.sha256(manifest_path.read_bytes()).hexdigest()),
        "runtime-bundle-smoke-report.json": dict(
            guestPath=str(smoke_path), sha256=hashlib.sha256(smoke_path.read_bytes()).hexdigest()),
    },
)
(home / "runtime-bundle-validation.json").write_text(json.dumps(record, indent=2) + "\n")
print(json.dumps(record, indent=2))
