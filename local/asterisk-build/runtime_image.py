import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import uuid


HERE = pathlib.Path(__file__).resolve().parent
MANIFEST_NAME = "runtime-bundle-manifest.json"
MANIFEST_SHA256 = "1d83ef928916419a836e4297addc7e56c91b75a69314f2ded15035c9b859dffd"
ENTRYPOINT = [
    "/opt/asterisk/runtime-libs/ld-linux-x86-64.so.2", "--library-path",
    "/opt/asterisk/main:/opt/asterisk/runtime-libs", "/opt/asterisk/main/asterisk",
]
COMMAND = ["-C", "/fixture/asterisk.conf", "-f"]
NAMESPACE = "cp-aaaaaaaaaaaaaaaaaaaaaaaa"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path):
    return json.loads(path.read_text())


def manifest():
    path = HERE / MANIFEST_NAME
    if digest(path) != MANIFEST_SHA256:
        raise ValueError("Runtime candidate manifest differs from the reviewed recipe")
    return read_json(path)


def inventory(root):
    files = set()
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Payload symlink forbidden: {path}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"Unexpected payload entry type: {path}")
        files.add(path.relative_to(root).as_posix())
    return files


def verify_bundle(root):
    record = manifest()
    paths = set()
    for entry in record["entries"]:
        relative = pathlib.PurePosixPath(entry["path"])
        if relative.is_absolute() or ".." in relative.parts or str(relative) in paths:
            raise ValueError("Invalid or duplicate manifest path")
        paths.add(str(relative))
    if inventory(root) != paths | {"bundle-manifest.json"}:
        raise ValueError("Bundle file inventory differs from approved manifest")
    if digest(root / "bundle-manifest.json") != MANIFEST_SHA256:
        raise ValueError("Bundle manifest mismatch")
    for entry in record["entries"]:
        path = root / entry["path"]
        if (path.stat().st_size != entry["bytes"]
                or oct(stat.S_IMODE(path.stat().st_mode)) != entry["mode"]
                or digest(path) != entry["sha256"]):
            raise ValueError(f"Bundle content/size/mode mismatch: {path}")
    return record


def module_links(record):
    return {
        pathlib.PurePosixPath(entry["path"]).name: "/opt/asterisk/" + entry["path"]
        for entry in record["entries"]
        if entry["path"].endswith(".so")
        and entry["path"].split("/")[0] in {
            "apps", "bridges", "cel", "channels", "codecs", "formats", "funcs", "pbx", "res"
        }
    }


def verify_context(root):
    record = verify_bundle(root / "bundle")
    if digest(root / "Dockerfile") != digest(HERE / "runtime.Dockerfile"):
        raise ValueError("Prepared Dockerfile differs from reviewed recipe")
    if (root / ".dockerignore").read_bytes() != b"*\n!Dockerfile\n!bundle/\n!bundle/**\n!modules/\n!modules/**\n":
        raise ValueError("Unexpected build-context allowlist")
    links = module_links(record)
    if len(links) != 41 or {path.name for path in (root / "modules").iterdir()} != set(links):
        raise ValueError("Expected exactly 41 module aliases")
    for name, target in links.items():
        path = root / "modules" / name
        if not path.is_symlink() or os.readlink(path) != target:
            raise ValueError(f"Unexpected module alias: {name}")
    if {path.name for path in root.iterdir()} != {
            "Dockerfile", ".dockerignore", "bundle", "modules", "preparation.json"}:
        raise ValueError("Unexpected context root entry")
    prepared = read_json(root / "preparation.json")
    if (prepared["bundleManifestSha256"] != MANIFEST_SHA256
            or prepared["dockerfileSha256"] != digest(root / "Dockerfile")
            or any(prepared[flag] is not False for flag in [
                "imageBuilt", "runtimeExecuted", "redistributionApproved",
                "licenseClosureComplete", "runtimeApplyAuthorized"])):
        raise ValueError("Invalid preparation evidence or authority flags")
    return record


def prepare(bundle, output):
    if sys.platform != "linux":
        raise RuntimeError("Context preparation requires Linux filesystem permissions and symlinks")
    verify_bundle(bundle)
    if output.is_relative_to(bundle) or bundle.is_relative_to(output):
        raise ValueError("Source and destination must not overlap")
    output.mkdir(mode=0o700)
    shutil.copytree(bundle, output / "bundle")
    shutil.copyfile(HERE / "runtime.Dockerfile", output / "Dockerfile")
    (output / ".dockerignore").write_bytes(b"*\n!Dockerfile\n!bundle/\n!bundle/**\n!modules/\n!modules/**\n")
    (output / "modules").mkdir()
    for name, target in module_links(manifest()).items():
        (output / "modules" / name).symlink_to(target)
    record = dict(
        schemaVersion=1, stage="container-context-prepared-not-built",
        bundleManifestSha256=MANIFEST_SHA256, dockerfileSha256=digest(output / "Dockerfile"),
        imageBuilt=False, runtimeExecuted=False,
        redistributionApproved=False, licenseClosureComplete=False, runtimeApplyAuthorized=False,
    )
    (output / "preparation.json").write_text(json.dumps(record, indent=2) + "\n")
    verify_context(output)
    return record


def write_queues(etc, timeout, strategy):
    (etc / "queues.conf").write_text(
        "[general]\npersistentmembers=no\n"
        "[proof-queue]\nstrategy=ringall\ntimeout=7\njoinempty=yes\nleavewhenempty=no\n"
        f"[{NAMESPACE}-smoke]\nstrategy={strategy}\ntimeout={timeout}\njoinempty=yes\nleavewhenempty=no\n"
        "[unrelated-queue]\nstrategy=ringall\ntimeout=99\n"
    )


def fixture(root):
    etc = root / "etc"
    etc.mkdir()
    state = root / "state"
    state.mkdir()
    for name in ["data", "db", "keys", "keys/keys", "spool", "log", "run", "cache"]:
        (state / name).mkdir()
    directories = {
        "astetcdir": "/fixture", "astmoddir": "/opt/asterisk/modules",
        "astvarlibdir": "/state/data", "astdatadir": "/state/data",
        "astdbdir": "/state/db", "astkeydir": "/state/keys",
        "astspooldir": "/state/spool", "astlogdir": "/state/log",
        "astrundir": "/state/run", "astcachedir": "/state/cache",
    }
    (etc / "asterisk.conf").write_text("[directories]\n" + "".join(
        f"{key} => {value}\n" for key, value in directories.items()
    ) + "[options]\nverbose=0\ndebug=0\nnocolor=yes\n")
    plan = read_json(HERE / "module-plan.json")
    (etc / "modules.conf").write_text(
        "[modules]\nautoload=no\n" + "".join(f"require={name}.so\n" for name in plan["requestedModules"]))
    fixtures = {
        "manager.conf": "[general]\nenabled=no\n",
        "http.conf": "[general]\nenabled=no\n",
        "logger.conf": "[general]\n[logfiles]\nconsole=notice,warning,error\n",
        "pjsip.conf": "", "sorcery.conf": "",
        "extensions.conf": "[general]\nstatic=yes\nwriteprotect=yes\n",
        "cdr.conf": "[general]\nenable=no\n", "cel.conf": "[general]\nenable=no\n",
        "cel_custom.conf": "[mappings]\nfixture.csv => ${eventtype}\n",
        "pjproject.conf": "[startup]\ntype=startup\n", "stasis.conf": "[taskpool]\n",
        "ccss.conf": "[general]\n", "features.conf": "[general]\n", "acl.conf": "",
        "udptl.conf": "[general]\nudptlstart=4500\nudptlend=4599\n",
        "rtp.conf": "[general]\nrtpstart=10000\nrtpend=10100\nicesupport=no\n",
        "indications.conf": "[general]\ncountry=uk\n[uk]\ndescription=United Kingdom\nringcadence=400,200,400,2000\ndial=350+440\n",
    }
    for name, content in fixtures.items():
        (etc / name).write_text(content)
    write_queues(etc, 11, "ringall")


def cli(path, command):
    deadline = time.monotonic() + 10
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(10)
        connection.connect(str(path))
        greeting = bytearray()
        while not greeting.endswith(b"\n"):
            remaining = deadline - time.monotonic()
            if remaining <= 0 or len(greeting) >= 512:
                raise ValueError("Invalid or stalled control-socket greeting")
            connection.settimeout(remaining)
            byte = connection.recv(1)
            if not byte:
                raise ValueError("Truncated control-socket greeting")
            greeting.extend(byte)
        if not re.fullmatch(rb"[^/\n]+/1/[^/\n]+\n", greeting):
            raise ValueError(f"Expected container PID 1 control socket: {greeting!r}")
        connection.sendall(b"cli quit after " + command.encode("ascii") + b"\0")
        response = bytearray()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("CLI absolute deadline exceeded")
            connection.settimeout(remaining)
            chunk = connection.recv(8193 - len(response))
            if not chunk:
                return response.decode("utf-8")
            response.extend(chunk)
            if len(response) > 8192:
                raise ValueError("CLI response exceeds 8192 bytes")


def check_modules(output):
    rows = re.findall(r"^(\S+\.so)\s+.*?\s+\d+\s+(Running|Not Running)\s+\S+\s*$",
                      output, re.MULTILINE)
    expected = {name + ".so" for name in read_json(HERE / "module-plan.json")["requestedModules"]}
    if (len(rows) != 41 or {name for name, _ in rows} != expected
            or any(state != "Running" for _, state in rows)):
        raise ValueError("Expected exactly 41 Running runtime module rows")
    return sorted(expected)


def docker(arguments, timeout=20, include_stderr=False):
    result = subprocess.run(["docker", *arguments], check=True, capture_output=True,
                            text=True, timeout=timeout)
    if len(result.stdout.encode()) + len(result.stderr.encode()) > 2 * 1024 * 1024:
        raise ValueError("Docker command output exceeds 2 MiB")
    return result.stdout + result.stderr if include_stderr else result.stdout


def run_arguments(image, name, root, owner):
    return [
        "run", "--detach", "--pull=never", "--name", name, "--restart=no",
        "--label", f"org.asterisk.local.smoke-owner={owner}",
        "--network=none", "--read-only", "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true", "--pids-limit=256",
        "--cpus=4", "--memory=4g", "--memory-swap=4g", "--ulimit=core=0",
        "--log-driver=local", "--log-opt=max-size=2m", "--log-opt=max-file=1",
        "--user", f"{os.getuid()}:{os.getgid()}", "--stop-timeout=10",
        "--mount", f"type=bind,src={root / 'etc'},dst=/fixture,readonly",
        "--mount", f"type=bind,src={root / 'state'},dst=/state",
        image,
    ]


def smoke(image, root):
    if sys.platform != "linux" or os.geteuid() == 0:
        raise RuntimeError("Image smoke requires an unprivileged Linux user and local Docker daemon")
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", image):
        raise ValueError("An existing immutable local image ID is required, not a tag")
    if "," in str(root) or len(os.fsencode(root / "state/run/asterisk.ctl")) > 100:
        raise ValueError("Use a short absolute work path without commas for the bind-mounted socket")
    manifest()
    endpoint = os.environ.get("DOCKER_HOST")
    if endpoint is None:
        context = json.loads(docker(["context", "inspect"]))[0]
        endpoint = context["Endpoints"]["docker"]["Host"]
    if not endpoint.startswith("unix://") or os.environ.get("DOCKER_CONTEXT"):
        raise ValueError("Only an explicit local Unix-socket Docker endpoint is supported")
    info = json.loads(docker(["info", "--format", "{{json .}}"]))
    if info["OSType"] != "linux" or info["Architecture"] not in ("x86_64", "amd64"):
        raise ValueError("The candidate requires a local Linux amd64 daemon")
    inspected = json.loads(docker(["image", "inspect", image]))[0]
    config = inspected["Config"]
    if (inspected["Id"] != image or inspected["Os"] != "linux"
            or inspected["Architecture"] != "amd64"
            or config["Entrypoint"] != ENTRYPOINT or config["Cmd"] != COMMAND
            or config["User"] != "10001:10001"
            or config.get("Labels", {}).get("org.asterisk.local.bundle-manifest-sha256") != MANIFEST_SHA256):
        raise ValueError("Image metadata does not match the prepared candidate recipe")
    for value in [
        "LD_LIBRARY_PATH=/opt/asterisk/main:/opt/asterisk/runtime-libs",
        "LOCPATH=/opt/asterisk/runtime-locale", "GCONV_PATH=/opt/asterisk/runtime-gconv",
    ]:
        if value not in config["Env"]:
            raise ValueError(f"Image lacks required environment: {value}")
    root.mkdir(mode=0o700)
    fixture(root)
    owner = uuid.uuid4().hex
    name = "asterisk-image-smoke-" + owner[:12]
    report = dict(
        schemaVersion=1, stage="isolated-image-smoke", imageId=image,
        bundleManifestSha256=MANIFEST_SHA256, passed=False,
        containerName=name, observations=[], runtimeApplyAuthorized=False,
        redistributionApproved=False, licenseClosureComplete=False,
        existingPbxOperated=False, imagePayloadIndependentlyVerified=False,
    )
    created = False
    try:
        # Track the owned name before launch: a timeout can occur after Docker creates it.
        created = True
        container_id = docker(run_arguments(image, name, root, owner)).strip()
        if not re.fullmatch(r"[a-f0-9]{64}", container_id):
            raise ValueError("Docker did not return a container ID")
        report["containerId"] = container_id
        container = json.loads(docker(["inspect", container_id]))[0]
        host = container["HostConfig"]
        for key, value in {
            "NetworkMode": "none", "ReadonlyRootfs": True, "Privileged": False,
            "Memory": 4294967296, "MemorySwap": 4294967296,
            "NanoCpus": 4000000000, "PidsLimit": 256,
        }.items():
            if host[key] != value:
                raise ValueError(f"Container isolation/resource setting mismatch: {key}")
        if (host.get("PortBindings") or host["CapDrop"] != ["ALL"]
                or "no-new-privileges:true" not in host["SecurityOpt"]):
            raise ValueError("Container exposes ports or lacks privilege restrictions")
        report["containerIsolationSettingsVerified"] = True
        control = root / "state/run/asterisk.ctl"
        deadline = time.monotonic() + 30
        while not control.exists():
            state = json.loads(docker(["inspect", "--format", "{{json .State}}", name]))
            if not state["Running"] or time.monotonic() > deadline:
                raise RuntimeError("Image did not create its private control socket")
            time.sleep(0.1)
        if cli(control, "core waitfullybooted") != "Asterisk has fully booted.\n":
            raise ValueError("Container has not fully booted")
        report["loadedModules"] = check_modules(cli(control, "module show"))
        for command in ["pjsip show endpoints", "pjsip show transports"]:
            if cli(control, command).strip() != "No objects found.":
                raise ValueError(f"Unexpected PJSIP objects: {command}")
        if "No such command" not in cli(control, "core show help test execute"):
            raise ValueError("Release image exposes test command")
        expected = read_json(HERE / "runtime-bundle-smoke-report.json")["observations"]
        for index, observation in enumerate(expected):
            if index in (1, 3):
                write_queues(root / "etc", 23 if index == 1 else 11,
                             "linear" if index == 1 else "ringall")
            if index in (2, 4):
                cli(control, f"queue reload parameters {NAMESPACE}-smoke")
            raw = cli(control, f"queue policy snapshot {NAMESPACE}")
            if len(raw.splitlines()) != 1 or json.loads(raw) != observation["response"]:
                raise ValueError(f"Loaded-policy mismatch: {observation['stage']}")
            report["observations"].append(observation)
        cli(control, "core stop now")
        exit_code = docker(["wait", name], timeout=15).strip()
        state = json.loads(docker(["inspect", "--format", "{{json .State}}", name]))
        if exit_code != "0" or state["Running"] or state["OOMKilled"]:
            raise ValueError(f"Container failed clean shutdown: {state}")
        report["processExitCode"] = 0
        report["checksPassed"] = True
    finally:
        try:
            if created:
                matches = docker(["ps", "--all", "--filter",
                                  f"label=org.asterisk.local.smoke-owner={owner}",
                                  "--format", "{{.ID}}"]).splitlines()
                if len(matches) > 1:
                    raise RuntimeError("Multiple containers have the owned smoke label")
                if matches:
                    owned = json.loads(docker(["inspect", matches[0]]))[0]
                    if (owned["Name"] != "/" + name
                            or owned["Config"].get("Labels", {}).get("org.asterisk.local.smoke-owner") != owner):
                        raise RuntimeError("Refusing cleanup: container ownership mismatch")
                    try:
                        (root / "console.log").write_text(
                            docker(["logs", "--tail=1000", owned["Id"]], include_stderr=True))
                    finally:
                        docker(["rm", "--force", owned["Id"]])
                        report["ownedContainerRemoved"] = True
                elif "containerId" in report:
                    raise RuntimeError("Owned container disappeared before cleanup could verify it")
                else:
                    report["ownedContainerNeverCreated"] = True
                for filename in ["asterisk.ctl", "asterisk.pid"]:
                    stale = root / "state/run" / filename
                    if stale.exists() or stale.is_symlink():
                        kind = stale.lstat().st_mode
                        if not ((filename == "asterisk.ctl" and stat.S_ISSOCK(kind))
                                or (filename == "asterisk.pid" and stat.S_ISREG(kind))):
                            raise RuntimeError(f"Unexpected owned runtime entry: {stale}")
                        stale.unlink()
                report["ownedRuntimeEntriesRemoved"] = True
        finally:
            (root / "image-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
    report["passed"] = True
    (root / "image-smoke-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    prepare_parser = commands.add_parser("prepare")
    prepare_parser.add_argument("--approve-context-preparation", action="store_true", required=True)
    prepare_parser.add_argument("--bundle", type=pathlib.Path, required=True)
    prepare_parser.add_argument("--output", type=pathlib.Path, required=True)
    verify_parser = commands.add_parser("verify")
    verify_parser.add_argument("--context", type=pathlib.Path, required=True)
    smoke_parser = commands.add_parser("smoke")
    smoke_parser.add_argument("--approve-image-smoke", action="store_true", required=True)
    smoke_parser.add_argument("--image", required=True)
    smoke_parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.bundle.resolve(), args.output.resolve())
    elif args.command == "verify":
        result = verify_context(args.context.resolve())
        result = dict(contextVerified=True, entries=len(result["entries"]), imageBuilt=False)
    else:
        result = smoke(args.image, args.work_dir.resolve())
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
