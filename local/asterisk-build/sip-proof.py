"""One explicitly approved, owned-network SIP/RTP proof; no implicit retries."""

import argparse
import hashlib
import importlib.util
import ipaddress
import json
import pathlib
import re
import secrets
import shutil
import threading
import time
import uuid

import runtime_image as runtime
import runtime_sip_queue
import runtime_sip_answer


SPEC = importlib.util.spec_from_file_location("desktop", runtime.HERE / "smoke-desktop.py")
desktop = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(desktop)
CARRIER = "sha256:d6333b8b331563c5887b98b12da9371ef48317e657d17d81770fe085f335041d"
LABEL = "org.asterisk.local.smoke-owner"
TESTS = runtime.HERE.parents[1] / "tests"
PHASES = ("wrong-register", "registered", "wrong-invite", "echo-complete", "unregistered")
QUEUE_PHASES = ("wrong-register", "registered", "wrong-invite",
                "queue-started", "queue-complete", "unregistered")
CONFIG = """[global]
type=global
user_agent=Asterisk-Isolated-Candidate
[transport-udp]
type=transport
protocol=udp
bind=0.0.0.0:5060
[proof-client]
type=endpoint
transport=transport-udp
context=isolated-sip-proof
disallow=all
allow=ulaw
auth=proof-client-auth
aors=proof-client
direct_media=no
dtmf_mode=none
rtp_symmetric=yes
force_rport=yes
rewrite_contact=yes
[proof-client]
type=aor
max_contacts=1
minimum_expiration=1
maximum_expiration=60
default_expiration=60
qualify_frequency=0
[proof-client-auth]
type=auth
auth_type=userpass
username=proof-client
password=@SECRET@
"""


def contacts(output, address=None, port=None):
    values = re.findall(r"^\s*Contact:\s+(\S[^\r\n]*)", output, re.MULTILINE)
    rows = ["Contact: " + value for value in values if not value.startswith("<")]
    expected = 0 if address is None else 1
    if expected == 0:
        if output.strip() != "No objects found.":
            raise ValueError("Expected no dynamic contacts")
    elif (len(rows) != 1 or not re.search(
            r"^Contact:\s+proof-client/sip:proof-client@" + re.escape(address) +
            ":" + str(port) + r"(?:[;\s])", rows[0])
            or not re.search(r"Objects found:\s*1\s*$", output)):
        raise ValueError("Dynamic contact does not match sole client address/port")
    return rows


def object_rows(output, kind, name):
    rows = re.findall(r"^\s*" + kind + r":\s+(\S+)", output, re.MULTILINE)
    rows = [row for row in rows if not row.startswith("<")]
    if (rows != [name] or not re.search(r"Objects found:\s*1\s*$", output)):
        raise ValueError(f"Unexpected configured {kind} inventory")


def check_limits(state, image, network, client=False, queue_timeout=False, queue_answer=False):
    host = state["HostConfig"]
    expected = dict(NetworkMode=network, ReadonlyRootfs=True, Privileged=False,
                    Memory=134217728 if client else 4294967296,
                    MemorySwap=134217728 if client else 4294967296,
                    NanoCpus=500000000 if client else 4000000000,
                    PidsLimit=32 if client else 256)
    if any(host[key] != value for key, value in expected.items()):
        raise ValueError("Container isolation/resource mismatch")
    if (state["Image"] != image or host.get("PortBindings") or host["CapDrop"] != ["ALL"]
            or "no-new-privileges:true" not in host["SecurityOpt"]
            or state["Config"]["User"] != ("1000:999" if client else "10001:10001")
            or host["RestartPolicy"]["Name"] != "no"
            or host["LogConfig"] != dict(Type="local", Config={
                "max-size": "2m", "max-file": "1", "compress": "false"})
            or host.get("Binds") or any(mount["Destination"] == "/var/run/docker.sock"
                                      for mount in state["Mounts"])):
        raise ValueError("Container privilege/image/logging mismatch")
    core = [row for row in host["Ulimits"] if row["Name"] == "core"]
    if core != [dict(Name="core", Hard=0, Soft=0)]:
        raise ValueError("Core dump restriction missing")
    if client:
        expected_command = ["-B", "/client/sip_candidate_client.py", "--host=pbx", "--control=/control"]
        if queue_timeout:
            expected_command.append("--queue-timeout")
        if queue_answer:
            expected_command.append("--queue-answer")
        if (state["Config"]["Entrypoint"] != ["python3"]
                or state["Config"]["Cmd"] != expected_command):
            raise ValueError("Carrier must run Python only")
    elif state["Config"]["Entrypoint"] != runtime.ENTRYPOINT:
        raise ValueError("PBX loader entrypoint mismatch")
    return expected


def sanitize(text, secret):
    return "\n".join(
        "[credential-bearing line redacted]" if (
            secret in line or re.search(r"authorization|password|nonce=|response=|digest ", line, re.I))
        else line for line in text.splitlines()) + "\n"


def proof(root, queue_timeout=False, queue_answer=False):
    if queue_timeout and queue_answer:
        raise ValueError("Select one SIP queue fixture")
    image, payload_path = desktop.verify_image()
    carrier = json.loads(desktop.command(["image", "inspect", CARRIER])[0])[0]
    if carrier["Id"] != CARRIER or carrier["Os"] != "linux" or carrier["Architecture"] != "amd64":
        raise ValueError("Pinned local Python carrier image mismatch")
    desktop.prepare_fixture(root)
    control = root / "control"
    control.mkdir()
    code = root / "client"
    code.mkdir()
    client_files = ["sip_candidate_client.py", "sip_rtp_proof.py"]
    if queue_answer:
        client_files.append("sip_queue_answer_client.py")
    for filename in client_files:
        shutil.copyfile(TESTS / filename, code / filename)
    secret = secrets.token_hex(32)
    (control / "secret").write_text(secret)
    credential = root / "etc/pjsip.conf"
    config_template = runtime_sip_answer.configuration(CONFIG) if queue_answer else CONFIG
    agent_secret = secrets.token_hex(32) if queue_answer else None
    if queue_answer:
        if agent_secret == secret:
            raise ValueError("Fixture identities require distinct secrets")
        (control / "agent-secret").write_text(agent_secret)
    private_config = config_template.replace("@SECRET@", secret)
    if queue_answer:
        private_config = private_config.replace("@AGENT_SECRET@", agent_secret)
    credential.write_text(private_config)
    (root / "etc/extensions.conf").write_text(
        "[general]\nstatic=yes\nwriteprotect=yes\n[isolated-sip-proof]\n"
        "exten => echo,1,Answer()\n same => n,Echo()\n same => n,Hangup()\n")
    if queue_timeout:
        runtime_sip_queue.prepare(root)
    if queue_answer:
        runtime_sip_answer.prepare(root)
    owner = uuid.uuid4().hex
    network = "asterisk-sip-" + owner[:12]
    names = {"pbx": network + "-pbx", "client": network + "-client"}
    report = dict(
        schemaVersion=1, stage=("custom-image-isolated-sip-queue-answer-proof" if queue_answer else
                               "custom-image-isolated-sip-queue-timeout-proof" if queue_timeout
                               else "custom-image-isolated-sip-rtp-proof"), passed=False,
        sipQueueTimeoutRequested=queue_timeout,
        sipQueueAnswerRequested=queue_answer,
        imageId=image, carrierImageId=CARRIER, bundleManifestSha256=runtime.MANIFEST_SHA256,
        payloadValidationSha256=runtime.digest(payload_path), owner=owner, networkName=network,
        diagnostics=[], cliObservations=[], phases=[], registrationPassed=False, mediaPassed=False,
        sipTested=False, mediaTested=False, existingPbxOperated=False,
        runtimeApplyAuthorized=False, gateCAuthorized=False, redistributionApproved=False,
        toolHashes={str(path.relative_to(runtime.HERE.parents[1])): runtime.digest(path)
                    for path in (pathlib.Path(__file__), runtime.HERE / "smoke-desktop.py",
                                 TESTS / "sip_candidate_client.py", TESTS / "sip_rtp_proof.py")},
        toolCanonicalLfHashes={str(path.relative_to(runtime.HERE.parents[1])): hashlib.sha256(
            path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            for path in (pathlib.Path(__file__), runtime.HERE / "smoke-desktop.py",
                         TESTS / "sip_candidate_client.py", TESTS / "sip_rtp_proof.py")},
        sanitizedConfiguration=config_template.replace("@SECRET@", "[ephemeral-secret-not-exported]").replace(
            "@AGENT_SECRET@", "[ephemeral-agent-secret-not-exported]"),
    )
    if queue_timeout:
        for filename in ("runtime_sip_queue.py", "runtime_local_call.py"):
            key = "local\\asterisk-build\\" + filename
            report["toolHashes"][key] = runtime.digest(runtime.HERE / filename)
            report["toolCanonicalLfHashes"][key] = hashlib.sha256(
                (runtime.HERE / filename).read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    if queue_answer:
        for path in (runtime.HERE / "runtime_sip_answer.py", runtime.HERE / "runtime_answer_call.py",
                     TESTS / "sip_queue_answer_client.py"):
            key = str(path.relative_to(runtime.HERE.parents[1]))
            report["toolHashes"][key] = runtime.digest(path)
            report["toolCanonicalLfHashes"][key] = hashlib.sha256(
                path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    lock = threading.RLock()
    expired = threading.Event()
    ids = {}
    network_id = None

    def redact(text):
        text = sanitize(text, secret)
        return sanitize(text, agent_secret) if agent_secret else text

    def call(args, timeout=20):
        if expired.is_set():
            raise TimeoutError("Five-minute watchdog expired")
        return desktop.command(args, timeout)

    def query(text):
        output = desktop.cli(ids["pbx"], text, report["diagnostics"])
        if text.startswith("pjsip show "):
            report["cliObservations"].append(dict(command=text, output=output))
        return output

    def inspect(identifier):
        return json.loads(call(["inspect", identifier])[0])[0]

    def wait_no_channels():
        deadline = time.monotonic() + 10
        while query("core show channels concise").strip():
            if time.monotonic() >= deadline:
                raise ValueError("Channels remain after ten-second drain deadline")
            time.sleep(0.1)

    def inventory():
        containers = call(["ps", "-a", "--no-trunc", "--format", "{{.ID}} {{.Names}} {{.State}}"])[0].splitlines()
        return dict(containers=sorted(row for row in containers if row.split()[0] not in ids.values()),
                    networks=sorted(call(["network", "ls", "--no-trunc", "--format", "{{.ID}} {{.Name}}"])[0].splitlines()))

    def bridge_snapshot():
        bridge = json.loads(call(["network", "inspect", "bridge"])[0])[0]
        return {key: bridge[key] for key in (
            "Name", "Id", "Created", "Driver", "Internal", "IPAM", "Options", "Containers")}

    def cleanup():
        nonlocal network_id
        with lock:
            matches = desktop.command(["ps", "-a", "--no-trunc", "--filter",
                                       f"label={LABEL}={owner}", "--format", "{{.ID}}"])[0].splitlines()
            if len(matches) > 2:
                raise ValueError("More than two owned containers; refusing cleanup")
            for identifier in matches:
                state = json.loads(desktop.command(["inspect", identifier])[0])[0]
                if (state["Name"].lstrip("/") not in names.values()
                        or state["Config"]["Labels"].get(LABEL) != owner
                        or state["Image"] not in (image, CARRIER)):
                    raise ValueError("Refusing foreign-container cleanup")
                role = "pbx" if state["Name"] == "/" + names["pbx"] else "client"
                try:
                    if state["State"]["Status"] != "created":
                        out, err = desktop.command(["logs", "--tail=1000", identifier])
                        (root / f"{role}-console.log").write_text(redact(out + err))
                finally:
                    desktop.command(["rm", "--force", identifier])
            report["ownedContainersRemoved"] = True
            if network_id:
                state = json.loads(desktop.command(["network", "inspect", network_id])[0])[0]
                if (state["Name"] != network or state["Labels"].get(LABEL) != owner
                        or state.get("Containers")):
                    raise ValueError("Refusing foreign or populated network cleanup")
                desktop.command(["network", "rm", network_id])
                network_id = None
            report["ownedResourcesRemoved"] = True

    def watchdog():
        expired.set()
        try:
            cleanup()
        except Exception as error:
            report["watchdogCleanupError"] = repr(error)

    timer = threading.Timer(270, watchdog)
    started = time.monotonic()
    timer.start()
    try:
        report["beforePreflightInventory"] = inventory()
        if sum(path.stat().st_size for path in root.rglob("*") if path.is_file()) > 256 * 1024 * 1024:
            raise ValueError("Incremental storage stop threshold exceeded")
        pbx = desktop.arguments(image, names["pbx"], owner, root)
        pbx[0] = "create"
        pbx.remove("--detach")
        pbx[pbx.index("--network=none")] = "--network=" + network
        pbx.insert(-1, "--network-alias=pbx")
        client = [
            "create", "--pull=never", "--name", names["client"], "--label", f"{LABEL}={owner}",
            "--restart=no", "--network=none", "--read-only", "--cap-drop=ALL",
            "--security-opt=no-new-privileges:true", "--pids-limit=32", "--cpus=0.5",
            "--memory=128m", "--memory-swap=128m", "--ulimit=core=0",
            "--log-driver=local", "--log-opt=max-size=2m", "--log-opt=max-file=1",
            "--log-opt=compress=false", "--user=1000:999", "--stop-timeout=10",
            "--mount", f"type=bind,src={code},dst=/client,readonly",
            "--mount", f"type=bind,src={control},dst=/control",
            "--entrypoint=python3", CARRIER, "-B", "/client/sip_candidate_client.py",
            "--host=pbx", "--control=/control",
        ]
        if queue_timeout:
            client.append("--queue-timeout")
        if queue_answer:
            client.append("--queue-answer")
        with lock:
            ids["client"] = call(client)[0].strip()
        if not re.fullmatch(r"[a-f0-9]{64}", ids["client"]):
            raise ValueError("Invalid preflight client container ID")
        check_limits(inspect(ids["client"]), CARRIER, "none", True, queue_timeout, queue_answer)
        call(["start", ids["client"]])
        ready_deadline = time.monotonic() + 15
        while not (control / "python-ready.json").exists():
            if not inspect(ids["client"])["State"]["Running"] or time.monotonic() > ready_deadline:
                raise ValueError("Python/engine preflight failed")
            time.sleep(0.1)
        if json.loads((control / "python-ready.json").read_text()) != dict(pythonReady=True):
            raise ValueError("Invalid Python preflight response")
        report["pythonPreflightPassed"] = True
        report["preflightClientId"] = ids["client"]
        (control / "preflight-exit").touch()
        if call(["wait", ids["client"]], timeout=10)[0].strip() != "0":
            raise ValueError("Preflight Python client did not exit zero")
        preflight_state = inspect(ids["client"])["State"]
        if preflight_state["Running"] or preflight_state["OOMKilled"]:
            raise ValueError("Preflight Python client did not stop")
        report["preflightClientStopped"] = dict(exitCode=preflight_state["ExitCode"], oomKilled=False)
        call(["rm", ids["client"]])
        del ids["client"]
        (control / "python-ready.json").unlink()
        (control / "preflight-exit").unlink()
        report["initialInventory"] = inventory()
        report["initialBridge"] = bridge_snapshot()
        if report["initialInventory"]["containers"] != report["beforePreflightInventory"]["containers"]:
            raise ValueError("Existing containers changed during engine preflight")
        with lock:
            network_id = call(["network", "create", "--internal", "--driver=bridge",
                               "--label", f"{LABEL}={owner}", network])[0].strip()
        if not re.fullmatch(r"[a-f0-9]{64}", network_id):
            raise ValueError("Invalid owned network ID")
        report["networkId"] = network_id
        client[client.index("--network=none")] = "--network=" + network
        for role, arguments in (("pbx", pbx), ("client", client)):
            with lock:
                ids[role] = call(arguments)[0].strip()
            if not re.fullmatch(r"[a-f0-9]{64}", ids[role]):
                raise ValueError("Invalid owned container ID")
            state = inspect(ids[role])
            report.setdefault("limits", {})[role] = check_limits(
                state, CARRIER if role == "client" else image, network, role == "client", queue_timeout, queue_answer)
        report["containerIds"] = dict(ids)
        call(["start", ids["pbx"]])
        if query("core waitfullybooted") != "Asterisk has fully booted.\n":
            raise ValueError("PBX did not report completed boot")
        report["loadedModules"] = runtime.check_modules(query("module show"))
        if "No such command" not in query("core show help test execute"):
            raise ValueError("Release image exposes test CLI")
        report["testCommandAbsent"] = True
        baseline = runtime.read_json(runtime.HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        if json.loads(query(f"queue policy snapshot {runtime.NAMESPACE}")) != baseline:
            raise ValueError("Loaded queue policy mismatch")
        def fixture_objects(text, kind):
            output = query(text)
            if queue_answer:
                rows = re.findall(r"^\s*" + kind + r":\s+(\S+)", output, re.MULTILINE)
                if (sorted(row for row in rows if not row.startswith("<")) != ["proof-agent", "proof-client"]
                        or not re.search(r"Objects found:\s*2\s*$", output)):
                    raise ValueError("Expected exactly two configured SIP identities")
            else:
                object_rows(output, kind, "proof-client")
        fixture_objects("pjsip show endpoints", "Endpoint")
        transports = query("pjsip show transports")
        object_rows(transports, "Transport", "transport-udp")
        if not re.search(r"Transport:\s+transport-udp\s+udp\s+0\s+0\s+0\.0\.0\.0:5060\s*$",
                         transports, re.MULTILINE):
            raise ValueError("UDP transport binding mismatch")
        fixture_objects("pjsip show aors", "Aor")
        contacts(query("pjsip show contacts"))
        if query("core show channels concise").strip():
            raise ValueError("Expected zero initial channels")
        call(["start", ids["client"]])
        client_started = time.monotonic()
        net = json.loads(call(["network", "inspect", network_id])[0])[0]
        if (net["Internal"] is not True or net["Driver"] != "bridge"
                or net["Labels"].get(LABEL) != owner or set(net["Containers"]) != set(ids.values())):
            raise ValueError("Network isolation/membership mismatch")
        peers = {role: str(ipaddress.IPv4Interface(net["Containers"][identifier]["IPv4Address"]).ip)
                 for role, identifier in ids.items()}
        report["networkSettings"] = dict(internal=True, driver="bridge", publishedPorts=0, peers=peers)
        (control / "go").touch()
        report["sipAttempted"] = True
        phases = runtime_sip_answer.PHASES if queue_answer else QUEUE_PHASES if queue_timeout else PHASES
        for phase in phases:
            path = control / f"{phase}.json"
            deadline = min(client_started + 60, time.monotonic() + 15)
            while not path.exists():
                state = inspect(ids["client"])["State"]
                if not state["Running"]:
                    raise RuntimeError(f"Client exited before {phase}: exit={state['ExitCode']}")
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Client deadline at {phase}")
                time.sleep(0.1)
            if path.stat().st_size > 8192:
                raise ValueError("Client phase report exceeds 8192 bytes")
            progress = json.loads(path.read_text())
            report["sipTested"] = True
            report["lastClientProgress"] = progress
            if (progress["clientAddress"] != peers["client"] or progress["pbxAddress"] != peers["pbx"]
                    or progress["phases"][-1]["phase"] != phase):
                raise ValueError("Protocol peer/progress mismatch")
            if queue_answer and phase != "unregistered-both":
                observed = runtime_sip_answer.contacts(query("pjsip show contacts"), peers["client"],
                                                      progress["clientPort"], progress["agentPort"])
            elif phase in ("registered", "wrong-invite", "echo-complete", "queue-started", "queue-complete"):
                observed = contacts(query("pjsip show contacts"), peers["client"], progress["clientPort"])
            else:
                observed = contacts(query("pjsip show contacts"))
            if queue_answer:
                report.setdefault("sipQueueAnswer", {})
                runtime_sip_answer.phase(query, phase, progress, report["sipQueueAnswer"])
            elif phase == "queue-started":
                report["sipQueueProgress"] = []
                report["sipQueueTimeout"] = runtime_sip_queue.observe(query, report["sipQueueProgress"])
            else:
                wait_no_channels()
            report["phases"].append(dict(client=progress["phases"][-1], contacts=observed))
            if phase == "registered":
                report["contactRegistrationPassed"] = True
            if phase == "echo-complete":
                report["mediaTested"] = True
                report["mediaPassed"] = progress["mediaPassed"]
                report["rtp"] = progress["rtp"]
            (control / f"{phase}.ack").touch()
        remaining = max(1, int(60 - (time.monotonic() - client_started)))
        if call(["wait", ids["client"]], timeout=remaining)[0].strip() != "0":
            raise ValueError("Client exit was not zero")
        client_report = json.loads((control / "client-report.json").read_text())
        if not client_report["passed"] or not client_report["registrationPassed"]:
            raise ValueError("Client final acceptance incomplete")
        report["registrationPassed"] = True
        report["clientReport"] = client_report
        if queue_answer and not report["sipQueueAnswer"].get("passed"):
            raise ValueError("Answered SIP queue host acceptance incomplete")
        fixture_objects("pjsip show endpoints", "Endpoint")
        if json.loads(query(f"queue policy snapshot {runtime.NAMESPACE}")) != baseline:
            raise ValueError("Queue policy changed during SIP proof")
        call(["stop", "--time=10", ids["pbx"]], timeout=15)
        for role, identifier in ids.items():
            if call(["wait", identifier], timeout=15)[0].strip() != "0":
                raise ValueError(f"{role} did not exit zero")
            state = inspect(identifier)["State"]
            if state["Running"] or state["OOMKilled"]:
                raise ValueError(f"{role} running or OOMKilled")
        report["processExitCodes"] = dict(pbx=0, client=0)
    except Exception as error:
        report["failure"] = redact(repr(error)).strip()
        raise
    finally:
        try:
            cleanup()
            report["finalInventory"] = inventory() if not expired.is_set() else None
            report["finalBridge"] = bridge_snapshot() if not expired.is_set() else None
            if "initialBridge" in report and report["finalBridge"] != report["initialBridge"]:
                raise ValueError("Default bridge configuration or attachments changed after preflight")
            if "initialInventory" in report and report["finalInventory"] != report["initialInventory"]:
                raise ValueError("Existing-resource inventory changed or watchdog expired")
        except Exception as error:
            report["cleanupFailure"] = redact(repr(error)).strip()
            if "failure" not in report:
                raise
        finally:
            timer.cancel()
            timer.join()
            if (control / "media-started.json").exists():
                report["mediaTested"] = True
            if report.get("ownedContainersRemoved"):
                credential.unlink(missing_ok=True)
                (control / "secret").unlink(missing_ok=True)
                (control / "agent-secret").unlink(missing_ok=True)
                report["credentialFilesRemoved"] = True
            report["watchdogExpired"] = expired.is_set()
            report["elapsedSeconds"] = round(time.monotonic() - started, 3)
            report["incrementalStorageBytes"] = sum(
                path.stat().st_size for path in root.rglob("*") if path.is_file())
            (root / "sip-proof-report.json").write_text(json.dumps(report, indent=2) + "\n")
    if expired.is_set() or report["elapsedSeconds"] > 300 or report["incrementalStorageBytes"] > 256 * 1024 * 1024:
        raise ValueError("Proof exceeded approved time/storage boundary")
    report["passed"] = True
    (root / "sip-proof-report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve-isolated-sip-rtp-proof", action="store_true", required=True)
    parser.add_argument("--work-dir", type=pathlib.Path, required=True)
    parser.add_argument("--approve-sip-queue-timeout", action="store_true")
    parser.add_argument("--approve-sip-queue-answer", action="store_true")
    args = parser.parse_args()
    print(json.dumps(proof(args.work_dir.resolve(), args.approve_sip_queue_timeout,
                           args.approve_sip_queue_answer), indent=2))
