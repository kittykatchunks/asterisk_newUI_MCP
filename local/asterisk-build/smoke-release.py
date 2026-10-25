import argparse
import hashlib
import json
import os
import pathlib
import re
import signal
import socket
import stat
import subprocess
import threading
import time


parser = argparse.ArgumentParser()
parser.add_argument("--approve-release-smoke", action="store_true")
parser.add_argument("--approve-full-module-startup", action="store_true")
parser.add_argument("--attempt", type=int, required=True)
parser.add_argument("--build-attempt", type=int, default=3)
parser.add_argument("--approve-staged-bundle", action="store_true")
parser.add_argument("--bundle-attempt", type=int, default=1)
args = parser.parse_args()
if not args.approve_release_smoke or min(args.attempt, args.build_attempt) < 1 or os.geteuid() == 0:
    raise SystemExit("Explicit release-smoke approval, positive attempt and unprivileged user required")
home = pathlib.Path("/home/asterisk-build")
build = home / f"native-build-attempt-{args.build_attempt}"
tree = build / "release"
bundle = None
if args.approve_staged_bundle:
    if args.bundle_attempt < 1:
        raise ValueError("Positive bundle attempt required")
    tree = home / f"runtime-bundle-attempt-{args.bundle_attempt}"
    bundle = json.loads((tree / "bundle-manifest.json").read_text())
    for entry in bundle["entries"]:
        path = tree / entry["path"]
        if hashlib.sha256(path.read_bytes()).hexdigest() != entry["sha256"]:
            raise ValueError(f"Staged bundle hash mismatch: {path}")
compile_bytes = (build / "compile-report.json").read_bytes()
compile_report = json.loads(compile_bytes)
profile = next(item for item in compile_report["profiles"] if item["name"] == "release")
mode = "bundle-smoke" if bundle else ("full-module-smoke" if args.approve_full_module_startup else "release-smoke")
root = home / f"{mode}-attempt-{args.attempt}"
root.mkdir(mode=0o700)
for name in ["etc", "modules", "data", "db", "keys", "spool", "log", "run", "cache"]:
    (root / name).mkdir()
environment = dict(os.environ, LD_LIBRARY_PATH=str(tree / "main"))
if bundle:
    if not args.approve_full_module_startup:
        raise ValueError("Staged bundle validation requires full-module startup")
    if bundle["compileReportSha256"] != hashlib.sha256(compile_bytes).hexdigest():
        raise ValueError("Staged bundle is bound to a different compile report")
    environment["LD_LIBRARY_PATH"] += ":" + str(tree / "runtime-libs")
    environment["LOCPATH"] = str(tree / "runtime-locale")
    environment["GCONV_PATH"] = str(tree / "runtime-gconv")
libraries = {}
for output in profile["outputs"]:
    path = tree / output["path"]
    if hashlib.sha256(path.read_bytes()).hexdigest() != output["sha256"]:
        raise ValueError(f"Release output hash mismatch: {path}")
    if path.name.startswith("test_"):
        raise ValueError("Test module found in release output set")
    dynamic = subprocess.check_output(["readelf", "-d", str(path)], text=True)
    needed = re.findall(r"\(NEEDED\).*\[([^\]]+)\]", dynamic)
    linked = subprocess.run(
        ["ldd", str(path)], env=environment, capture_output=True,
        text=True, timeout=10, check=True,
    ).stdout
    if "not found" in linked:
        raise ValueError(f"Unresolved dynamic dependency: {path}\n{linked}")
    for line in linked.splitlines():
        match = re.match(r"\s*(\S+) => (/\S+) \(", line)
        direct = re.match(r"\s*(/\S+) \(", line)
        if match:
            soname, library = match.groups()
        elif direct:
            library = direct[1]
            soname = pathlib.Path(library).name
        elif "linux-vdso" in line or not line.strip():
            continue
        elif line.strip() == "statically linked" and not needed:
            print(f"NO_DIRECT_SHARED_LIBRARY_DEPENDENCIES={output['path']}", flush=True)
            continue
        else:
            raise ValueError(f"Unexpected ldd output: {line}")
        resolved = pathlib.Path(library).resolve(strict=True)
        if soname.startswith("libasterisk") and resolved.parent != tree / "main":
            raise ValueError("Custom core linked to foreign Asterisk support library")
        record = dict(
            path=str(resolved),
            sha256=hashlib.sha256(resolved.read_bytes()).hexdigest(),
        )
        if soname in libraries and libraries[soname] != record:
            raise ValueError(f"Inconsistent shared-library resolution: {soname}")
        libraries[soname] = record
    if output["path"].endswith(".so") and not output["path"].startswith("main/"):
        (root / "modules" / path.name).symlink_to(path)

namespace = "cp-aaaaaaaaaaaaaaaaaaaaaaaa"
selected_name = namespace + "-smoke"
config = root / "etc/asterisk.conf"
directories = {
    "astetcdir": root / "etc", "astmoddir": root / "modules",
    "astvarlibdir": root / "data", "astdatadir": root / "data",
    "astdbdir": root / "db", "astkeydir": root / "keys",
    "astspooldir": root / "spool", "astlogdir": root / "log",
    "astrundir": root / "run", "astcachedir": root / "cache",
}
config.write_text("[directories]\n" + "".join(
    f"{key} => {value}\n" for key, value in directories.items()
) + "[options]\nverbose=0\ndebug=0\nnocolor=yes\n")
(root / "etc/modules.conf").write_text("[modules]\nautoload=no\nrequire=app_queue.so\n")
(root / "etc/manager.conf").write_text("[general]\nenabled=no\n")
(root / "etc/http.conf").write_text("[general]\nenabled=no\n")
(root / "etc/logger.conf").write_text("[general]\n[logfiles]\nconsole=notice,warning,error\n")
module_plan = json.loads((home / "source-staging/module-plan.json").read_text())
expected_modules = {"app_queue.so"}
if args.approve_full_module_startup:
    expected_modules = {name + ".so" for name in module_plan["requestedModules"]}
    if len(expected_modules) != 41:
        raise ValueError("Full startup requires the exact 41-module runtime plan")
    (root / "etc/modules.conf").write_text(
        "[modules]\nautoload=no\n"
        + "".join(f"require={name}.so\n" for name in module_plan["requestedModules"])
    )
    fixtures = {
        "pjsip.conf": "",
        "sorcery.conf": "",
        "extensions.conf": "[general]\nstatic=yes\nwriteprotect=yes\n",
        "cdr.conf": "[general]\nenable=no\n",
        "cel.conf": "[general]\nenable=no\n",
        "cel_custom.conf": "[mappings]\nfixture.csv => ${eventtype}\n",
        "pjproject.conf": "[startup]\ntype=startup\n",
        "stasis.conf": "[taskpool]\n",
        "ccss.conf": "[general]\n",
        "features.conf": "[general]\n",
        "acl.conf": "",
        "udptl.conf": "[general]\nudptlstart=4500\nudptlend=4599\n",
        "rtp.conf": "[general]\nrtpstart=10000\nrtpend=10100\nicesupport=no\n",
        "indications.conf": "[general]\ncountry=uk\n[uk]\ndescription=United Kingdom\nringcadence=400,200,400,2000\ndial=350+440\n",
    }
    for name, content in fixtures.items():
        (root / "etc" / name).write_text(content)
    (root / "keys/keys").mkdir()


def write_queues(timeout, strategy):
    (root / "etc/queues.conf").write_text(
        "[general]\npersistentmembers=no\n"
        "[proof-queue]\nstrategy=ringall\ntimeout=7\njoinempty=yes\nleavewhenempty=no\n"
        f"[{selected_name}]\nstrategy={strategy}\ntimeout={timeout}\njoinempty=yes\nleavewhenempty=no\n"
        "[unrelated-queue]\nstrategy=ringall\ntimeout=99\n"
    )


write_queues(11, "ringall")
report = dict(
    schemaVersion=1, patchSha256=compile_report["patchSha256"],
    compileReportSha256=hashlib.sha256(compile_bytes).hexdigest(),
    profile="release", attempt=args.attempt,
    mode=mode,
    verifiedReleaseOutputs=len(profile["outputs"]),
    resolvedLibraries=dict(sorted(libraries.items())),
    observations=[], passed=False, ownedProcessStopped=False,
    runtimeApplyAuthorized=False, existingPbxOperated=False,
)
base = [str(tree / "main/asterisk"), "-C", str(config)]
if bundle:
    base = [str(tree / "runtime-libs/ld-linux-x86-64.so.2"),
            "--library-path", environment["LD_LIBRARY_PATH"], *base]
process = subprocess.Popen(
    [*base, "-f"], cwd=root, env=environment,
    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True,
)
log_errors = []
overflow = threading.Event()


def drain():
    try:
        with (root / "console.log").open("xb") as output:
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
        log_errors.append(error)


thread = threading.Thread(target=drain)
thread.start()


def cli(command):
    deadline = time.monotonic() + 10
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(str(root / "run/asterisk.ctl"))
        greeting = bytearray()
        while not greeting.endswith(b"\n"):
            byte = connection.recv(1)
            if not byte or len(greeting) >= 512 or time.monotonic() > deadline:
                raise ValueError("Invalid control-socket greeting")
            greeting.extend(byte)
        if not re.fullmatch(rb"[^/\n]+/" + str(process.pid).encode() + rb"/[^/\n]+\n", greeting):
            raise ValueError(f"Control socket is not the owned release process: {greeting!r}")
        connection.sendall(b"cli quit after " + command.encode("ascii") + b"\0")
        response = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Release CLI absolute deadline exceeded")
            connection.settimeout(remaining)
            chunk = connection.recv(8193 - len(response))
            if not chunk:
                break
            response.extend(chunk)
            if len(response) > 8192:
                raise ValueError("Release CLI response exceeds 8192 bytes")
        return response.decode("utf-8")


def observe(stage, timeout, strategy):
    raw = cli(f"queue policy snapshot {namespace}")
    lines = raw.splitlines()
    if len(lines) != 1 or len(raw.encode()) > 8192:
        raise ValueError(f"Getter did not return one bounded JSON line: {raw}")
    value = json.loads(raw)
    expected = dict(
        schemaVersion=1, reader="app-queue-policy-v1",
        maskMapping="asterisk-22-empty-v1", status="observed",
        namespace=namespace, consistency="bounded-per-object-sample",
        objects=[
            dict(name=selected_name, origin="static", strategy=strategy,
                 memberTimeoutSeconds=timeout, joinEmptyMask=0, leaveWhenEmptyMask=0,
                 memberCount=0, callerCount=0, callerListEmpty=True),
            dict(name="proof-queue", origin="static", strategy="ringall",
                 memberTimeoutSeconds=7, joinEmptyMask=0, leaveWhenEmptyMask=0,
                 memberCount=0, callerCount=0, callerListEmpty=True),
        ],
    )
    if value != expected:
        raise ValueError(f"Loaded policy mismatch at {stage}: {value}")
    report["observations"].append(dict(stage=stage, response=value))
    print(f"RELEASE_POLICY_OK={stage}", flush=True)


try:
    deadline = time.monotonic() + 20
    while not (root / "run/asterisk.ctl").exists():
        if process.poll() is not None or time.monotonic() > deadline:
            raise RuntimeError(f"Release startup failed; see {root / 'console.log'}")
        time.sleep(0.1)
    boot_output = cli("core waitfullybooted")
    (root / "boot-output.txt").write_text(boot_output)
    if boot_output != "Asterisk has fully booted.\n":
        raise RuntimeError(f"Unexpected completed-boot response: {boot_output!r}")
    loaded = cli("module show")
    (root / "loaded-modules.txt").write_text(loaded)
    module_rows = re.findall(
        r"^(\S+\.so)\s+.*?\s+\d+\s+(Running|Not Running)\s+\S+\s*$",
        loaded, re.MULTILINE,
    )
    actual = {name for name, state in module_rows}
    if actual != expected_modules or any(state != "Running" for _, state in module_rows):
        raise ValueError(f"Unexpected release startup modules: {actual}")
    report["loadedModules"] = sorted(actual)
    report["allExpectedModulesRunning"] = True
    if args.approve_full_module_startup:
        checks = {}
        for key, command in [
            ("endpoints", "pjsip show endpoints"),
            ("transports", "pjsip show transports"),
        ]:
            output = cli(command)
            if output.strip() != "No objects found.":
                raise ValueError(f"Unexpected PJSIP {key}: {output}")
            checks[key] = output.strip()
        report["pjsipEmptyObjectChecks"] = checks
    if bundle:
        mapped = set()
        for line in pathlib.Path(f"/proc/{process.pid}/maps").read_text().splitlines():
            fields = line.split(maxsplit=5)
            if len(fields) != 6 or not fields[5].startswith("/"):
                continue
            path = pathlib.Path(fields[5]).resolve(strict=True)
            if not path.is_relative_to(tree):
                raise ValueError(f"Runtime mapped file outside staged bundle: {path}")
            mapped.add(str(path.relative_to(tree)))
        required = {"main/asterisk"}
        required.update("runtime-libs/" + name for name in bundle["systemLibraries"])
        required.update(str(pathlib.Path(item["path"]).relative_to(tree))
                        for name, item in libraries.items() if name.startswith("libasterisk"))
        required.update(output["path"] for output in profile["outputs"]
                        if output["path"].endswith(".so") and not output["path"].startswith("main/"))
        if not required.issubset(mapped):
            raise ValueError(f"Staged runtime did not map all required files: {sorted(required - mapped)}")
        report["bundleManifestSha256"] = hashlib.sha256((tree / "bundle-manifest.json").read_bytes()).hexdigest()
        report["mappedBundleFiles"] = sorted(mapped)
        report["allFileBackedMappingsInsideBundle"] = True
    help_text = cli("core show help test execute")
    if "No such command" not in help_text:
        raise ValueError(f"Test command not absent from release CLI: {help_text}")
    report["testCommandAbsent"] = True
    report["cliTransport"] = "unix-control-socket-cli-quit-after"
    report["ownedPidGreetingVerified"] = True
    observe("initial-loaded", 11, "ringall")
    write_queues(23, "linear")
    observe("disk-edited-without-reload", 11, "ringall")
    cli(f"queue reload parameters {selected_name}")
    observe("after-fixture-reload", 23, "linear")
    write_queues(11, "ringall")
    observe("disk-restored-without-reload", 23, "linear")
    cli(f"queue reload parameters {selected_name}")
    observe("after-fixture-restore-reload", 11, "ringall")
finally:
    if process.poll() is None:
        try:
            cli("core stop now")
        except OSError as error:
            print(f"RELEASE_GRACEFUL_STOP_FAILED: {error}; sending SIGTERM", flush=True)
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            print("RELEASE_FORCED_STOP: sending SIGKILL", flush=True)
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=5)
    thread.join(timeout=5)
    if thread.is_alive():
        raise RuntimeError("Release console worker failed to drain")
    process.stdout.close()
    report["ownedProcessStopped"] = process.poll() is not None
    report["processExitCode"] = process.returncode
    for name in ["asterisk.ctl", "asterisk.pid"]:
        stale = root / "run" / name
        if stale.exists():
            kind = stale.lstat().st_mode
            if not ((name == "asterisk.ctl" and stat.S_ISSOCK(kind))
                    or (name == "asterisk.pid" and stat.S_ISREG(kind))):
                raise RuntimeError(f"Unexpected owned runtime entry type: {stale}")
            print(f"REMOVING_STALE_RUNTIME_ENTRY_AFTER_PROCESS_EXIT={stale}", flush=True)
            stale.unlink()
    (root / "release-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
if overflow.is_set() or log_errors:
    raise RuntimeError(f"Release console failure: overflow={overflow.is_set()} errors={log_errors}")
if process.returncode != 0:
    raise RuntimeError(f"Release process did not exit cleanly: {process.returncode}")
if (root / "run/asterisk.ctl").exists() or (root / "run/asterisk.pid").exists():
    raise RuntimeError("Release process left control socket or PID file")
report["passed"] = True
(root / "release-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
print(f"RELEASE_SMOKE_PASSED outputs={len(profile['outputs'])} libraries={len(libraries)} observations=5", flush=True)
