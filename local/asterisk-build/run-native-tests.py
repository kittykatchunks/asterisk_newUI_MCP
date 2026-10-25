import argparse
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import threading
import time
import xml.etree.ElementTree as ET


parser = argparse.ArgumentParser()
parser.add_argument("--approve-native-tests", action="store_true")
parser.add_argument("--attempt", type=int, required=True)
args = parser.parse_args()
if not args.approve_native_tests or args.attempt < 1 or os.geteuid() == 0:
    raise SystemExit("Explicit approval, positive attempt and unprivileged user required")
home = pathlib.Path("/home/asterisk-build")
staging = home / "source-staging"
build = home / "native-build-attempt-3"
tree = build / "instrumented"
compile_report = json.loads((build / "compile-report.json").read_text())
candidate = json.loads((staging / "queue-policy-v1.json").read_text())
if compile_report["patchSha256"] != candidate["patchSha256"]:
    raise ValueError("Compiled candidate binding mismatch")
profile = next(item for item in compile_report["profiles"] if item["name"] == "instrumented")
for output in profile["outputs"]:
    if hashlib.sha256((tree / output["path"]).read_bytes()).hexdigest() != output["sha256"]:
        raise ValueError(f"Compiled output hash mismatch: {output['path']}")
categories = {}
for source in [tree / "apps/app_queue.c", tree / "tests/test_bounded_queue_policy.c"]:
    for block in re.split(r"AST_TEST_DEFINE\(", source.read_text())[1:]:
        name = block.split(")", 1)[0]
        category = re.search(r'info->category = "([^"]+)";', block)
        if category and name in candidate["nativeTests"]:
            categories[name] = category[1]
if set(categories) != set(candidate["nativeTests"]):
    raise ValueError("Unable to resolve the exact native inventory")
root = home / f"native-test-attempt-{args.attempt}"
root.mkdir(mode=0o700)
modules = root / "modules"
modules.mkdir()
for output in profile["outputs"]:
    if output["path"].endswith(".so") and not output["path"].startswith("main/"):
        (modules / pathlib.Path(output["path"]).name).symlink_to(tree / output["path"])
environment = dict(os.environ, LD_LIBRARY_PATH=str(tree / "main"))
report = dict(
    schemaVersion=1,
    patchSha256=candidate["patchSha256"],
    compileReportSha256=hashlib.sha256((build / "compile-report.json").read_bytes()).hexdigest(),
    nativeTestsExecuted=True,
    runtimeApplyAuthorized=False,
    attempt=args.attempt,
    results=[],
    completed=False,
    allOwnedProcessesStopped=False,
)


def save():
    (root / "native-test-report.json").write_text(json.dumps(report, indent=2) + "\n")


for name in candidate["nativeTests"]:
    case = root / name
    case.mkdir(mode=0o700)
    for directory in ["etc", "data", "db", "keys", "spool", "log", "run", "cache"]:
        (case / directory).mkdir()
    directories = {
        "astetcdir": case / "etc", "astmoddir": modules,
        "astvarlibdir": case / "data", "astdatadir": case / "data",
        "astdbdir": case / "db", "astkeydir": case / "keys",
        "astspooldir": case / "spool", "astlogdir": case / "log",
        "astrundir": case / "run", "astcachedir": case / "cache",
    }
    config = case / "etc/asterisk.conf"
    config.write_text(
        "[directories]\n" + "".join(f"{key} => {value}\n" for key, value in directories.items())
        + "[options]\nverbose=0\ndebug=0\nnocolor=yes\n"
    )
    (case / "etc/modules.conf").write_text(
        "[modules]\nautoload=no\nrequire=app_queue.so\nrequire=test_bounded_queue_policy.so\n"
    )
    (case / "etc/queues.conf").write_text("[general]\npersistentmembers=no\n")
    (case / "etc/manager.conf").write_text("[general]\nenabled=no\n")
    (case / "etc/http.conf").write_text("[general]\nenabled=no\n")
    (case / "etc/logger.conf").write_text("[general]\n[logfiles]\nconsole=notice,warning,error\n")
    base = [str(tree / "main/asterisk"), "-C", str(config)]
    process = subprocess.Popen(
        [*base, "-f", "-g"], cwd=case, env=environment,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
    )
    overflow = threading.Event()
    drain_errors = []

    def drain():
        try:
            with (case / "console.log").open("xb") as output:
                total = 0
                while chunk := process.stdout.read(65536):
                    available = 2 * 1024 * 1024 - total
                    output.write(chunk[:available])
                    total += min(len(chunk), available)
                    if len(chunk) > available:
                        overflow.set()
                        os.killpg(process.pid, signal.SIGTERM)
                        return
        except Exception as error:
            drain_errors.append(error)

    thread = threading.Thread(target=drain)
    thread.start()

    def cli(command, timeout=10):
        return subprocess.run(
            [*base, "-rx", command], cwd=case, env=environment,
            capture_output=True, text=True, timeout=timeout, check=True,
        ).stdout

    try:
        deadline = time.monotonic() + 20
        while not (case / "run/asterisk.ctl").exists():
            if process.poll() is not None or time.monotonic() > deadline:
                raise RuntimeError(f"Asterisk startup failed/timed out for {name}; see {case / 'console.log'}")
            time.sleep(0.1)
        loaded = cli("module show")
        (case / "loaded-modules.txt").write_text(loaded)
        if "test_protected_cli_target.so" in loaded:
            raise ValueError("Disposable target was loaded before fixture admission")
        if not all(module in loaded for module in ["app_queue.so", "test_bounded_queue_policy.so"]):
            raise ValueError("Required native-test modules were not loaded")
        started = time.monotonic()
        output = cli(f"test execute category {categories[name]} name {name}", timeout=120)
        (case / "test-cli.txt").write_text(output)
        xml_path = case / "results.xml"
        cli(f"test generate results xml {xml_path}")
        xml = ET.parse(xml_path)
        tests = xml.findall(".//testcase")
        if len(tests) != 1 or tests[0].get("name") != name:
            raise ValueError(f"Native XML did not execute exactly requested test: {name}")
        failed = tests[0].find("failure")
        if tests[0].find("skipped") is not None or tests[0].find("error") is not None:
            raise ValueError(f"Unexpected native XML state: {name}")
        report["results"].append(dict(
            name=name, category=categories[name],
            result="failed" if failed is not None else "passed",
            elapsedSeconds=round(time.monotonic() - started, 3),
            failure=failed.text if failed is not None else None,
            xmlSha256=hashlib.sha256(xml_path.read_bytes()).hexdigest(),
        ))
        print(f"NATIVE_TEST {name} {report['results'][-1]['result']}", flush=True)
    finally:
        if process.poll() is None:
            try:
                cli("core stop now", timeout=5)
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                print(f"GRACEFUL_STOP_FAILED {name}: {error}; sending SIGTERM", flush=True)
                if process.poll() is None:
                    os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print(f"FORCED_STOP {name}: sending SIGKILL", flush=True)
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        thread.join(timeout=5)
        if thread.is_alive():
            raise RuntimeError("Asterisk console worker failed to drain")
        process.stdout.close()
        report["allOwnedProcessesStopped"] = process.poll() is not None
        save()
    if overflow.is_set() or drain_errors:
        raise RuntimeError(f"Asterisk console logging failed: overflow={overflow.is_set()} errors={drain_errors}")
report["completed"] = True
report["passed"] = sum(item["result"] == "passed" for item in report["results"])
report["failed"] = len(report["results"]) - report["passed"]
save()
print(f"NATIVE_BATCH passed={report['passed']} failed={report['failed']}", flush=True)
if report["failed"]:
    raise SystemExit(1)
