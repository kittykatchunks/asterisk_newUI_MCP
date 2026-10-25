import argparse
import json
import pathlib
import re
import subprocess
import threading
import time
import uuid

import runtime_image as runtime


def command(arguments, timeout=20):
    result = subprocess.run(["docker", "--context", "desktop-linux", *arguments],
                            capture_output=True, timeout=timeout)
    if len(result.stdout) + len(result.stderr) > 2 * 1024 * 1024:
        raise ValueError("Docker response exceeds 2 MiB")
    if result.returncode:
        raise RuntimeError(f"Docker {arguments[0]} failed ({result.returncode}): "
                           f"{result.stderr.decode('utf-8')} {result.stdout.decode('utf-8')}")
    return result.stdout.decode("utf-8"), result.stderr.decode("utf-8")


def cli(container, text, diagnostics):
    stdout, stderr = command([
        "exec", container, *runtime.ENTRYPOINT, "-C", "/fixture/asterisk.conf", "-rx", text,
    ], timeout=15)
    if stderr:
        diagnostics.append(dict(command=text, stream="stderr", text=stderr))
        raise ValueError(f"Remote CLI stderr requires explicit investigation: {stderr!r}")
    eid_notice = ("No ethernet interface found for seeding global EID. "
                  "You will have to set it manually.\n")
    if stdout.startswith(eid_notice):
        diagnostics.append(dict(command=text, stream="stdout", text=eid_notice))
        stdout = stdout[len(eid_notice):]
    if len(stdout.encode()) > 8192:
        raise ValueError("CLI response exceeds 8192 bytes")
    return stdout


def arguments(image, name, owner, root):
    return [
        "run", "--detach", "--pull=never", "--name", name,
        "--label", f"org.asterisk.local.smoke-owner={owner}", "--restart=no",
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true", "--pids-limit=256",
        "--cpus=4", "--memory=4g", "--memory-swap=4g", "--ulimit=core=0",
        "--log-driver=local", "--log-opt=max-size=2m", "--log-opt=max-file=1",
        "--log-opt=compress=false",
        "--user=10001:10001", "--stop-timeout=10",
        "--mount", f"type=bind,src={root / 'etc'},dst=/fixture,readonly",
        "--tmpfs", "/state:rw,noexec,nosuid,size=67108864,uid=10001,gid=10001,mode=0700",
        image,
    ]


def smoke(root, trace_loader=False):
    build = runtime.read_json(runtime.HERE / "image-build-validation-nss.json")
    payload_path = runtime.HERE / "image-payload-validation-nss.json"
    if runtime.digest(payload_path) != build["evidence"][payload_path.name]["sha256"]:
        raise ValueError("Image payload evidence hash mismatch")
    payload = runtime.read_json(payload_path)
    image = build["imageId"]
    if (payload["imageId"] != image or not payload["imageConfigurationMatchesRecipe"]
            or payload["bundleManifestSha256"] != runtime.MANIFEST_SHA256
            or runtime.digest(runtime.HERE / runtime.MANIFEST_NAME) != runtime.MANIFEST_SHA256):
        raise ValueError("Image evidence mismatch")
    inspected = json.loads(command(["image", "inspect", image])[0])[0]
    if (inspected["Id"] != image or inspected["Config"]["Entrypoint"] != runtime.ENTRYPOINT
            or inspected["Config"]["Cmd"] != runtime.COMMAND):
        raise ValueError("Local image identity/config mismatch")
    root.mkdir()
    runtime.fixture(root)
    config = root / "etc/asterisk.conf"
    content = config.read_text()
    for name in ["data", "db", "spool", "log", "run", "cache"]:
        content = content.replace("/state/" + name, "/state")
    content = content.replace("/state/keys", "/fixture/keys")
    config.write_text(content)
    (root / "etc/keys/keys").mkdir(parents=True)
    owner = uuid.uuid4().hex
    name = "asterisk-desktop-smoke-" + owner[:12]
    report = dict(
        schemaVersion=1, imageId=image, bundleManifestSha256=runtime.MANIFEST_SHA256,
        stage="docker-desktop-image-smoke", passed=False, containerName=name,
        payloadValidationSha256=runtime.digest(payload_path),
        observations=[], diagnostics=[], runtimeApplyAuthorized=False,
        loaderDiagnosticsEnabled=trace_loader,
        existingPbxOperated=False, registryPushed=False, callsOrMediaTested=False,
        redistributionApproved=False, licenseClosureComplete=False,
    )
    lock = threading.Lock()
    timed_out = threading.Event()

    def cleanup():
        with lock:
            matches = command(["ps", "--all", "--filter",
                               f"label=org.asterisk.local.smoke-owner={owner}", "--format", "{{.ID}}"])[0].splitlines()
            if len(matches) > 1:
                raise RuntimeError("Multiple containers match owned label")
            if matches:
                owned = json.loads(command(["inspect", matches[0]])[0])[0]
                if (owned["Name"] != "/" + name
                        or owned["Config"]["Labels"].get("org.asterisk.local.smoke-owner") != owner):
                    raise RuntimeError("Refusing cleanup of foreign container")
                try:
                    if owned["State"]["Status"] == "created":
                        (root / "console.log").write_text(
                            "Container never started.\n" + json.dumps(owned["State"], indent=2))
                    else:
                        stdout, stderr = command(["logs", "--tail=10000", owned["Id"]])
                        (root / "console.log").write_text(stdout + stderr)
                finally:
                    command(["rm", "--force", owned["Id"]])
                    report["ownedContainerRemoved"] = True

    def watchdog():
        timed_out.set()
        try:
            cleanup()
        except Exception as error:
            report["watchdogCleanupError"] = repr(error)

    timer = threading.Timer(300, watchdog)
    timer.start()
    try:
        launch = arguments(image, name, owner, root)
        if trace_loader:
            launch[-1:-1] = ["--env=LD_DEBUG=libs"]
        container = command(launch)[0].strip()
        if not re.fullmatch(r"[a-f0-9]{64}", container):
            raise ValueError("Docker did not return a container ID")
        report["containerId"] = container
        state = json.loads(command(["inspect", container])[0])[0]
        host = state["HostConfig"]
        for key, value in dict(NetworkMode="none", ReadonlyRootfs=True, Privileged=False,
                               Memory=4294967296, MemorySwap=4294967296,
                               NanoCpus=4000000000, PidsLimit=256).items():
            if host[key] != value:
                raise ValueError(f"Isolation/resource mismatch: {key}")
        if (host.get("PortBindings") or host["CapDrop"] != ["ALL"]
                or "no-new-privileges:true" not in host["SecurityOpt"]):
            raise ValueError("Container lacks required privilege/port restrictions")
        report["isolationSettings"] = {key: host[key] for key in [
            "NetworkMode", "ReadonlyRootfs", "Privileged", "Memory", "MemorySwap", "NanoCpus", "PidsLimit"]}
        report["isolationSettings"].update(capDrop=host["CapDrop"], securityOpt=host["SecurityOpt"],
                                           portBindings=host.get("PortBindings"))
        deadline = time.monotonic() + 30
        while True:
            top = json.loads(command(["inspect", "--format", "{{json .State}}", container])[0])
            if not top["Running"]:
                raise RuntimeError(f"Container exited before readiness: {top}")
            # Boot completion command itself waits for Asterisk initialization.
            output = cli(container, "core waitfullybooted", report["diagnostics"])
            if output == "Asterisk has fully booted.\n":
                break
            if time.monotonic() > deadline:
                raise RuntimeError(f"Unexpected completed-boot response: {output!r}")
            time.sleep(0.1)
        report["loadedModules"] = runtime.check_modules(cli(container, "module show", report["diagnostics"]))
        report["pjsipEmptyObjectChecks"] = {}
        for key in ["endpoints", "transports"]:
            output = cli(container, f"pjsip show {key}", report["diagnostics"]).strip()
            if output != "No objects found.":
                raise ValueError(f"Unexpected PJSIP {key}: {output}")
            report["pjsipEmptyObjectChecks"][key] = output
        if "No such command" not in cli(container, "core show help test execute", report["diagnostics"]):
            raise ValueError("Release image exposes test command")
        report["testCommandAbsent"] = True
        for index, expected in enumerate(runtime.read_json(
                runtime.HERE / "runtime-bundle-smoke-report.json")["observations"]):
            if index in (1, 3):
                runtime.write_queues(root / "etc", 23 if index == 1 else 11,
                                     "linear" if index == 1 else "ringall")
            if index in (2, 4):
                cli(container, f"queue reload parameters {runtime.NAMESPACE}-smoke", report["diagnostics"])
            raw = cli(container, f"queue policy snapshot {runtime.NAMESPACE}", report["diagnostics"])
            if len(raw.splitlines()) != 1 or json.loads(raw) != expected["response"]:
                raise ValueError(f"Policy mismatch: {expected['stage']}")
            report["observations"].append(expected)
        command(["stop", "--time=10", container], timeout=15)
        exit_code = command(["wait", container], timeout=15)[0].strip()
        state = json.loads(command(["inspect", "--format", "{{json .State}}", container])[0])
        if exit_code != "0" or state["Running"] or state["OOMKilled"]:
            raise ValueError(f"Container did not exit cleanly: {state}")
        report["processExitCode"] = 0
    except Exception as error:
        report["failure"] = repr(error)
        raise
    finally:
        timer.cancel()
        timer.join()
        try:
            cleanup()
        finally:
            report["watchdogExpired"] = timed_out.is_set()
            (root / "desktop-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
    if timed_out.is_set():
        raise TimeoutError("Five-minute container watchdog expired")
    report["passed"] = True
    (root / "desktop-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve-desktop-image-smoke", action="store_true", required=True)
    parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    parser.add_argument("--trace-loader", action="store_true")
    args = parser.parse_args()
    print(json.dumps(smoke(args.work_dir.resolve(), args.trace_loader), indent=2))
