import copy
import hashlib
import json
import pathlib
import xml.etree.ElementTree as ET


home = pathlib.Path("/home/asterisk-build")
build = home / "native-build-attempt-4"
compile_path = build / "compile-report.json"
compile_report = json.loads(compile_path.read_text())
candidate = json.loads((home / "source-staging/queue-policy-v1.json").read_text())
plan = json.loads((home / "source-staging/module-plan.json").read_text())
for profile in compile_report["profiles"]:
    tree = build / profile["name"]
    assert "OPTIONAL_API" in profile["enabledOptions"]
    assert len(profile["outputs"]) == (46 if profile["name"] == "instrumented" else 44)
    for output in profile["outputs"]:
        data = (tree / output["path"]).read_bytes()
        assert hashlib.sha256(data).hexdigest() == output["sha256"]
        assert data[:5] == b"\x7fELF\x02"
        assert int.from_bytes(data[18:20], "little") == 62

native_root = home / "native-test-attempt-2"
native_path = native_root / "native-test-report.json"
native = json.loads(native_path.read_text())
assert native["completed"] and native["allOwnedProcessesStopped"]
assert native["passed"] == 30 and native["failed"] == 0
assert [item["name"] for item in native["results"]] == candidate["nativeTests"]
aggregate = ET.Element("testsuites", tests="30", failures="0", errors="0", skipped="0")
suite = ET.SubElement(aggregate, "testsuite", name="optional-api-native-batch",
                      tests="30", failures="0", errors="0", skipped="0")
for result in native["results"]:
    case = native_root / result["name"]
    data = (case / "results.xml").read_bytes()
    assert hashlib.sha256(data).hexdigest() == result["xmlSha256"]
    xml = ET.fromstring(data)
    tests = xml.findall(".//testcase")
    assert len(tests) == 1 and tests[0].get("name") == result["name"]
    assert len(tests[0]) == 0 and result["result"] == "passed"
    assert not (case / "run/asterisk.ctl").exists()
    assert not (case / "run/asterisk.pid").exists()
    suite.append(copy.deepcopy(tests[0]))
ET.indent(aggregate)
xml_path = native_root / "native-test-results.xml"
ET.ElementTree(aggregate).write(xml_path, encoding="utf-8", xml_declaration=True)

reports = {"compile-report-optional-api.json": compile_path,
           "native-test-report-optional-api.json": native_path,
           "native-test-results-optional-api.xml": xml_path}
for name, directory, expected in [
    ("release-smoke-report-optional-api.json", "release-smoke-attempt-5", ["app_queue.so"]),
    ("full-module-smoke-report.json", "full-module-smoke-attempt-4",
     sorted(module + ".so" for module in plan["requestedModules"])),
]:
    case = home / directory
    report_path = case / "release-smoke-report.json"
    report = json.loads(report_path.read_text())
    assert report["passed"] and report["ownedProcessStopped"]
    assert report["processExitCode"] == 0
    assert report["allExpectedModulesRunning"]
    assert report["testCommandAbsent"]
    assert report["loadedModules"] == expected
    assert len(report["resolvedLibraries"]) == 29
    for library in report["resolvedLibraries"].values():
        assert hashlib.sha256(pathlib.Path(library["path"]).read_bytes()).hexdigest() == library["sha256"]
    observations = report["observations"]
    assert len(observations) == 5
    rows = [observation["response"]["objects"][0] for observation in observations]
    assert [row["memberTimeoutSeconds"] for row in rows] == [11, 11, 23, 23, 11]
    assert [row["strategy"] for row in rows] == ["ringall", "ringall", "linear", "linear", "ringall"]
    assert not (case / "run/asterisk.ctl").exists()
    assert not (case / "run/asterisk.pid").exists()
    if len(expected) == 41:
        assert report["pjsipEmptyObjectChecks"] == {
            "endpoints": "No objects found.", "transports": "No objects found."}
        assert report["mode"] == "full-module-smoke"
    assert report["compileReportSha256"] == hashlib.sha256(compile_path.read_bytes()).hexdigest()
    reports[name] = report_path
assert native["compileReportSha256"] == hashlib.sha256(compile_path.read_bytes()).hexdigest()
for path in home.glob("*smoke-attempt-*/run"):
    assert not (path / "asterisk.ctl").exists()
    assert not (path / "asterisk.pid").exists()
for cmdline in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
    try:
        executable = cmdline.read_bytes().split(b"\0")[0]
    except (FileNotFoundError, ProcessLookupError):
        continue
    assert not executable.startswith(str(home / "native-build").encode()) or not executable.endswith(b"/main/asterisk")
for name, path in reports.items():
    if path.suffix == ".json":
        assert json.loads(path.read_text())["patchSha256"] == candidate["patchSha256"]
record = dict(
    schemaVersion=1, stage="optional-api-build-full-startup-verified",
    patchSha256=candidate["patchSha256"], buildAttempt=4,
    optionalApiEnabledBothProfiles=True, nativePassed=30, nativeFailed=0,
    fullStartupModules=41, pjsipEndpoints=0, pjsipTransports=0,
    independentOutputHashesAndElfHeadersVerified=True,
    independentNativeXmlVerified=True, independentLibraryHashesVerified=True,
    exactLoadedStateTransitionsVerified=True, noOwnedAsteriskProcessesRemain=True,
    noSmokeControlSocketsOrPidFilesRemain=True,
    runtimeApplyAuthorized=False, existingPbxOperated=False, runtimeImageProduced=False,
    evidence={
        name: dict(guestPath=str(path), sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        for name, path in reports.items()
    },
)
(home / "full-startup-validation.json").write_text(json.dumps(record, indent=2) + "\n")
print("INDEPENDENT_FULL_STARTUP_AND_CORRECTED_BUILD_VALIDATION_PASSED")
print(json.dumps(record, indent=2))
