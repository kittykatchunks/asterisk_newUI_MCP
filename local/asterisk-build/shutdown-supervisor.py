#!/usr/bin/env python3
"""Offline protocol primitives for the disposable Asterisk shutdown fixture."""

import argparse
import dataclasses
import hashlib
import json
import os
import pathlib
import queue
import signal
import socket
import socketserver
import stat
import subprocess
import threading
import time


MAX_MESSAGE_BYTES = 256
PROTOCOL_VERSION = 1
EVENTS = {
    "before-module-shutdown",
    "dispatch-admitted",
    "shutdown-after-modules",
    "lease-released",
    "shutdown-retry",
    "shutdown-denied",
    "shutdown-complete",
}


@dataclasses.dataclass
class ControlEvent:
    name: str
    value: int
    wait_for_continue: bool
    _continue: threading.Event = dataclasses.field(default_factory=threading.Event)

    def continue_child(self):
        self._continue.set()


class _ControlHandler(socketserver.StreamRequestHandler):
    def handle(self):
        payload = self.rfile.readline(MAX_MESSAGE_BYTES + 1)
        if not payload.endswith(b"\n") or len(payload) > MAX_MESSAGE_BYTES:
            return
        try:
            version, name, value, wait = payload.decode("ascii").strip().split(" ")
            event = ControlEvent(name, int(value), wait == "1")
            if version != str(PROTOCOL_VERSION) or name not in EVENTS or wait not in {"0", "1"}:
                return
        except (UnicodeDecodeError, ValueError):
            return
        self.server.events.put(event)
        self.server.history.append((event.name, event.value, event.wait_for_continue))
        self.server.pending.append(event)
        if event.wait_for_continue:
            if not event._continue.wait(self.server.barrier_timeout):
                self.wfile.write(b"E")
                self.wfile.flush()
                return
        self.wfile.write(b"C")
        self.wfile.flush()


_UnixStreamServer = getattr(socketserver, "UnixStreamServer", None)

if _UnixStreamServer is None:
    class _ThreadedUnixServer:
        def __init__(self, address, barrier_timeout):
            raise RuntimeError("Shutdown supervisor requires Unix-domain socket support")
else:
    class _ThreadedUnixServer(socketserver.ThreadingMixIn, _UnixStreamServer):
        daemon_threads = True
        allow_reuse_address = False

        def __init__(self, address, barrier_timeout):
            self.events = queue.Queue()
            self.history = []
            self.pending = []
            self.barrier_timeout = barrier_timeout
            super().__init__(address, _ControlHandler)


class ShutdownControlServer:
    """Private, bounded Unix-domain event channel used only by an owned child."""

    def __init__(self, run_directory, barrier_timeout=15):
        self.run_directory = pathlib.Path(run_directory).resolve()
        self.run_directory.mkdir(mode=0o700, parents=True, exist_ok=False)
        self.socket_path = self.run_directory / "c"
        if len(os.fsencode(self.socket_path)) >= 100:
            raise ValueError("Control socket path is too long for sockaddr_un")
        self.server = _ThreadedUnixServer(str(self.socket_path), barrier_timeout)
        os.chmod(self.socket_path, 0o600)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def next_event(self, timeout):
        try:
            event = self.server.events.get(timeout=timeout)
        except queue.Empty as error:
            raise TimeoutError("Asterisk child did not report the expected control event") from error
        return event

    def close(self):
        for event in self.server.pending:
            event.continue_child()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        if self.thread.is_alive():
            raise RuntimeError("Control socket server did not stop")


def expect_event(server, expected_name, timeout, expected_value=None, wait_for_continue=None):
    event = server.next_event(timeout)
    if (
        event.name != expected_name
        or (expected_value is not None and event.value != expected_value)
        or (wait_for_continue is not None and event.wait_for_continue != wait_for_continue)
    ):
        event.continue_child()
        raise RuntimeError(
            f"Unexpected shutdown event: {event.name} value={event.value} "
            f"wait={event.wait_for_continue}; expected {expected_name}"
        )
    return event


def before_shutdown_admission(server, run_cli, timeout=15):
    """Exercise the global shutdown gate before loader teardown begins."""
    boundary = expect_event(server, "before-module-shutdown", timeout, wait_for_continue=True)
    try:
        result = run_cli("test bounded-policy lifecycle-target success", timeout, True)
        if result.returncode == 0:
            raise RuntimeError("The protected target command unexpectedly succeeded during shutdown")
        output = result.stdout
        if "Protected command unavailable: module busy or closing" not in output:
            raise RuntimeError("Shutdown did not reject the protected target command")
        expect_event(server, "shutdown-denied", timeout, wait_for_continue=False)
    finally:
        boundary.continue_child()
    expect_event(server, "shutdown-complete", timeout, expected_value=0,
                 wait_for_continue=True).continue_child()


def shutdown_after_admission(server, start_cli, timeout=15):
    """Require shutdown to preserve a leased target until its worker releases."""
    admitted = expect_event(server, "dispatch-admitted", timeout, expected_value=1, wait_for_continue=True)
    shutdown = None
    try:
        stop_process = start_cli("core stop gracefully")
        shutdown = expect_event(server, "shutdown-after-modules", timeout, expected_value=1,
                                wait_for_continue=True)
        admitted.continue_child()
        expect_event(server, "lease-released", timeout, expected_value=0, wait_for_continue=False)
    finally:
        admitted.continue_child()
        if shutdown is not None:
            shutdown.continue_child()
    expect_event(server, "shutdown-retry", timeout, expected_value=0, wait_for_continue=True).continue_child()
    return stop_process


def _wait_process(process, timeout, label):
    try:
        return process.wait(timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise TimeoutError(f"{label} did not exit within {timeout} seconds") from error


def _stop_process_group(process):
    if process.poll() is not None:
        return
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        process.wait(timeout=5)
        return
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            process.wait(timeout=5)
            return
        process.wait(timeout=5)


def _start_cli(binary, config, case_directory, command, capture=False, timeout=15):
    arguments = [binary, "-C", config, "-rx", command]
    if capture:
        return subprocess.run(arguments, cwd=case_directory, capture_output=True,
                              text=True, timeout=timeout, check=False)
    return subprocess.Popen(
        arguments, cwd=case_directory, stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True,
    )


def _read_sections(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise PermissionError(f"Configuration must be a private regular file: {path}")
    sections = {}
    current = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if line.startswith("#include"):
            raise ValueError(f"Includes are not allowed in the disposable profile: {path}")
        if not line or line.startswith((";", "#")):
            continue
        if line.startswith("[") and line.endswith("]"):
            current = line[1:-1].strip().lower()
            if not current or current in sections:
                raise ValueError(f"Duplicate or empty section in {path}")
            sections[current] = {}
            continue
        if current is None or "=>" not in line:
            raise ValueError(f"Unsupported configuration line in {path}: {raw_line}")
        key, value = (part.strip() for part in line.split("=>", 1))
        key = key.lower()
        if not key or key in sections[current]:
            raise ValueError(f"Duplicate or empty configuration key in {path}: {key}")
        sections[current][key] = value
    return sections


def _validate_private_profile(case_directory, config):
    expected_config = case_directory / "etc" / "asterisk.conf"
    if config != expected_config:
        raise ValueError("Use the private case's etc/asterisk.conf")
    config_sections = _read_sections(config)
    if (
        set(config_sections) != {"directories", "options"}
        or config_sections["options"] != {"verbose": "0", "debug": "0", "nocolor": "yes"}
    ):
        raise ValueError("Asterisk config must contain only private directories and quiet options")
    directories = config_sections["directories"]
    expected_directories = {
        "astetcdir": "etc",
        "astmoddir": "modules",
        "astvarlibdir": "data",
        "astdatadir": "data",
        "astdbdir": "db",
        "astkeydir": "keys",
        "astspooldir": "spool",
        "astlogdir": "log",
        "astrundir": "run",
        "astcachedir": "cache",
    }
    if set(directories) != set(expected_directories):
        raise ValueError("Disposable profile must set exactly the private Asterisk directories")
    for key, relative in expected_directories.items():
        value = pathlib.Path(directories[key])
        if not value.is_absolute() or value.resolve() != case_directory / relative:
            raise ValueError(f"{key} must resolve inside the private case directory")
        directory = case_directory / relative
        info = directory.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise PermissionError(f"Directory is not privately owned: {directory}")

    modules = _read_sections(case_directory / "etc" / "modules.conf")
    if modules != {"modules": {"autoload": "no"}}:
        raise ValueError("Shutdown fixture requires modules.conf with only autoload=no")
    for filename in ("manager.conf", "http.conf"):
        settings = _read_sections(case_directory / "etc" / filename)
        if settings != {"general": {"enabled": "no"}}:
            raise ValueError(f"{filename} must explicitly disable its service")
    target = case_directory / "modules" / "test_protected_cli_target.so"
    target_info = target.lstat()
    if not stat.S_ISREG(target_info.st_mode) or target_info.st_uid != os.geteuid():
        raise ValueError("Disposable target module must be a regular private file")


def _validate_build_binding(binary_path, case_directory):
    repository = pathlib.Path(__file__).resolve().parents[2]
    supplement_path = repository / "local" / "asterisk-patches" / "queue-policy-shutdown-v1.json"
    supplement = json.loads(supplement_path.read_text(encoding="utf-8"))
    supplement_patch = supplement_path.parent / supplement["patch"]
    if hashlib.sha256(supplement_patch.read_bytes()).hexdigest() != supplement["patchSha256"]:
        raise ValueError("Shutdown supplement patch hash mismatch")
    build_directory = binary_path.parent.parent.parent
    report_path = build_directory / "compile-report.json"
    report_info = report_path.lstat()
    if not stat.S_ISREG(report_info.st_mode):
        raise ValueError("Compile report must be a regular build artifact")
    compile_report = json.loads(report_path.read_text(encoding="utf-8"))
    if (
        compile_report.get("patchSha256") != supplement["parentPatchSha256"]
        or compile_report.get("shutdownSupplementPatchSha256") != supplement["patchSha256"]
    ):
        raise ValueError("Build report does not bind the parent and shutdown supplement patches")
    profile = next(
        (item for item in compile_report.get("profiles", []) if item.get("name") == "instrumented"),
        None,
    )
    if not profile or "TEST_FRAMEWORK" not in profile.get("enabledOptions", []):
        raise ValueError("Build report does not confirm the instrumented TEST_FRAMEWORK profile")
    outputs = {item["path"]: item["sha256"] for item in profile.get("outputs", [])}
    required = {
        "main/asterisk": binary_path,
        "tests/test_protected_cli_target.so":
            case_directory / "modules" / "test_protected_cli_target.so",
    }
    for relative, path in required.items():
        expected_hash = outputs.get(relative)
        if not expected_hash or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise ValueError(f"Compiled output does not match build report: {relative}")


def run_case(binary, config, case_directory, mode, approved):
    if not approved:
        raise PermissionError("Explicit shutdown-fixture approval is required")
    if os.name != "posix" or not hasattr(socket, "AF_UNIX"):
        raise OSError("The shutdown supervisor requires POSIX Unix-domain sockets")
    if os.geteuid() == 0:
        raise PermissionError("Run the disposable shutdown fixture as an unprivileged user")
    if mode not in {"before-admission", "after-admission"}:
        raise ValueError("Unknown shutdown fixture mode")

    binary_path = pathlib.Path(binary).resolve(strict=True)
    if not (
        binary_path.name == "asterisk"
        and binary_path.parent.name == "main"
        and binary_path.parent.parent.name == "instrumented"
        and binary_path.parent.parent.parent.name.startswith("native-build-attempt-")
    ):
        raise ValueError("Asterisk binary must come from the instrumented disposable build profile")
    binary = str(binary_path)
    case_directory = pathlib.Path(case_directory).resolve(strict=True)
    config = pathlib.Path(config).resolve(strict=True)
    case_info = case_directory.stat()
    if not stat.S_ISDIR(case_info.st_mode) or case_info.st_uid != os.geteuid() or case_info.st_mode & 0o077:
        raise PermissionError("Case directory must be privately owned by the invoking user")
    if not config.is_relative_to(case_directory) or not stat.S_ISREG(config.stat().st_mode):
        raise ValueError("Configuration must be a regular file within the private case directory")
    _validate_private_profile(case_directory, config)
    _validate_build_binding(binary_path, case_directory)

    control_directory = case_directory / "shutdown-control"
    server = ShutdownControlServer(control_directory)
    environment = dict(os.environ)
    environment["ASTERISK_CLI_LEASE_TEST_SOCKET"] = str(server.socket_path)
    environment["ASTERISK_CLI_LEASE_TEST_MODE"] = mode
    process = subprocess.Popen(
        [binary, "-C", str(config), "-f", "-g"],
        cwd=case_directory,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log_path = case_directory / "shutdown-console.log"
    overflow = threading.Event()
    drain_errors = []

    def drain_output():
        try:
            with log_path.open("xb") as output:
                total = 0
                while chunk := process.stdout.read(65536):
                    available = 2 * 1024 * 1024 - total
                    if available > 0:
                        output.write(chunk[:available])
                        total += min(len(chunk), available)
                    if len(chunk) > available:
                        overflow.set()
        except OSError as error:
            drain_errors.append(error)

    drain_thread = None
    process = None
    clients = []
    stop_process = None
    target_process = None
    report = None

    def cli(command, timeout=10):
        result = _start_cli(binary, str(config), case_directory, command,
                            capture=True, timeout=timeout)
        if result.returncode:
            raise subprocess.CalledProcessError(result.returncode, result.args,
                                                output=result.stdout, stderr=result.stderr)
        return result.stdout

    def cli_expected_failure(command, timeout=10):
        result = _start_cli(binary, str(config), case_directory, command,
                            capture=True, timeout=timeout)
        return result

    def start_cli(command):
        client = _start_cli(binary, str(config), case_directory, command)
        clients.append(client)
        return client

    try:
        process = subprocess.Popen(
            [binary, "-C", str(config), "-f", "-g"],
            cwd=case_directory,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        drain_thread = threading.Thread(target=drain_output, daemon=True)
        drain_thread.start()
        deadline = time.monotonic() + 20
        while True:
            if process.poll() is not None:
                raise RuntimeError(f"Asterisk exited before fixture startup; inspect {log_path}")
            try:
                cli("core show version", timeout=2)
                break
            except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Asterisk did not become ready; inspect {log_path}")
                time.sleep(0.1)

        loaded = cli("module show")
        if "test_protected_cli_target.so" in loaded:
            raise RuntimeError("Disposable target was loaded before supervisor setup")
        cli("module load test_protected_cli_target.so")

        if mode == "before-admission":
            stop_process = start_cli("core stop now")
            before_shutdown_admission(
                server,
                lambda command, timeout, expected: cli_expected_failure(command, timeout)
                if expected else cli(command, timeout),
            )
        else:
            target_process = start_cli("test bounded-policy lifecycle-target success")
            stop_process = shutdown_after_admission(server, start_cli)

        child_exit = _wait_process(process, 10, "Asterisk child")
        if child_exit != 0:
            raise RuntimeError(f"Asterisk shutdown fixture exited with status {child_exit}")
        for client in clients:
            try:
                client.wait(timeout=5)
            except subprocess.TimeoutExpired:
                _stop_process_group(client)
        if target_process is not None and target_process.poll() is None:
            _stop_process_group(target_process)
        if stop_process is not None and stop_process.poll() is None:
            _stop_process_group(stop_process)
        report = {
            "schemaVersion": 1,
            "mode": mode,
            "controlProtocol": PROTOCOL_VERSION,
            "events": server.server.history,
            "childExitCode": child_exit,
            "allOwnedProcessesStopped": all(
                child.poll() is not None for child in [process, *clients]
            ),
            "nativeExecutionAuthorizedByThisTool": False,
        }
    finally:
        if process is not None and process.poll() is None:
            _stop_process_group(process)
        for client in clients:
            if client.poll() is None:
                _stop_process_group(client)
        if target_process is not None and target_process.poll() is None:
            _stop_process_group(target_process)
        if stop_process is not None and stop_process.poll() is None:
            _stop_process_group(stop_process)
        server.close()
        if drain_thread is not None:
            drain_thread.join(timeout=5)
            if drain_thread.is_alive():
                raise RuntimeError("Asterisk output drainer did not stop")
        if process is not None:
            process.stdout.close()
        if overflow.is_set() or drain_errors:
            raise RuntimeError(
                f"Asterisk output handling failed: overflow={overflow.is_set()} errors={drain_errors}"
            )
        if report is not None:
            report_path = case_directory / "shutdown-supervisor-report.json"
            with report_path.open("x", encoding="utf-8") as output:
                json.dump(report, output, indent=2)
                output.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--approve-shutdown-fixture", action="store_true")
    parser.add_argument("--asterisk", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--case-directory", required=True)
    parser.add_argument("--mode", choices=["before-admission", "after-admission"], required=True)
    args = parser.parse_args()
    result = run_case(args.asterisk, args.config, args.case_directory, args.mode,
                      args.approve_shutdown_fixture)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
