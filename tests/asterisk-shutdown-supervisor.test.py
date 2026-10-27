import importlib.util
import pathlib
import socket
import socketserver
import subprocess
import tempfile
import threading
import unittest


root = pathlib.Path(__file__).resolve().parents[1]
module_spec = importlib.util.spec_from_file_location(
    "shutdown_supervisor", root / "local" / "asterisk-build" / "shutdown-supervisor.py"
)
supervisor = importlib.util.module_from_spec(module_spec)
module_spec.loader.exec_module(supervisor)


def send_event(path, name, value=0, wait=False):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(str(path))
        client.sendall(f"1 {name} {value} {int(wait)}\n".encode("ascii"))
        return client.recv(1)


class FakeServer:
    def __init__(self, events):
        self.events = iter(events)

    def next_event(self, timeout):
        return next(self.events)


class ShutdownCoordinatorTests(unittest.TestCase):
    def test_process_runner_requires_separate_explicit_execution_approval(self):
        with self.assertRaisesRegex(PermissionError, "Explicit shutdown-fixture approval"):
            supervisor.run_case("", "", "", "before-admission", approved=False)

    def test_before_admission_checks_explicit_shutdown_denial(self):
        boundary = supervisor.ControlEvent("before-module-shutdown", 0, True)
        complete = supervisor.ControlEvent("shutdown-complete", 0, True)
        server = FakeServer([
            boundary,
            supervisor.ControlEvent("shutdown-denied", 0, False),
            complete,
        ])

        def run_cli(command, timeout, expect_failure):
            self.assertEqual(command, "test bounded-policy lifecycle-target success")
            self.assertTrue(expect_failure)
            return subprocess.CompletedProcess(command, 1,
                "Protected command unavailable: module busy or closing\n", "")

        supervisor.before_shutdown_admission(server, run_cli)
        self.assertTrue(boundary._continue.is_set())
        self.assertTrue(complete._continue.is_set())

    def test_after_admission_releases_worker_before_retry(self):
        admitted = supervisor.ControlEvent("dispatch-admitted", 1, True)
        shutdown = supervisor.ControlEvent("shutdown-after-modules", 1, True)
        retry = supervisor.ControlEvent("shutdown-retry", 0, True)
        server = FakeServer([
            admitted,
            shutdown,
            supervisor.ControlEvent("lease-released", 0, False),
            retry,
        ])
        command = []

        def start_cli(value):
            command.append(value)
            return object()

        result = supervisor.shutdown_after_admission(server, start_cli)
        self.assertEqual(command, ["core stop gracefully"])
        self.assertIsNotNone(result)
        self.assertTrue(admitted._continue.is_set())
        self.assertTrue(shutdown._continue.is_set())
        self.assertTrue(retry._continue.is_set())


@unittest.skipUnless(
    hasattr(socketserver, "UnixStreamServer") and hasattr(socket, "AF_UNIX"),
    "Unix-domain socket server is unavailable on this platform",
)
class ShutdownSupervisorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.server = supervisor.ShutdownControlServer(
            pathlib.Path(self.temporary.name) / "control", barrier_timeout=2
        )

    def tearDown(self):
        self.server.close()
        self.temporary.cleanup()

    def test_barrier_requires_explicit_continue(self):
        replies = []
        worker = threading.Thread(
            target=lambda: replies.append(send_event(
                self.server.socket_path, "dispatch-admitted", 1, wait=True
            ))
        )
        worker.start()
        event = supervisor.expect_event(
            self.server, "dispatch-admitted", 2, expected_value=1, wait_for_continue=True
        )
        self.assertTrue(worker.is_alive())
        event.continue_child()
        worker.join(2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(replies, [b"C"])

    def test_before_admission_scenario_checks_shutdown_denial(self):
        def fake_child():
            boundary_reply = send_event(
                self.server.socket_path, "before-module-shutdown", wait=True
            )
            self.assertEqual(boundary_reply, b"C")
            self.assertEqual(
                send_event(self.server.socket_path, "shutdown-complete", 0, wait=True), b"C"
            )

        child = threading.Thread(target=fake_child)
        child.start()

        def run_cli(command, timeout):
            self.assertEqual(command, "test bounded-policy lifecycle-target success")
            self.assertEqual(timeout, 2)
            self.assertEqual(send_event(self.server.socket_path, "shutdown-denied"), b"C")
            return "Protected command unavailable: module busy or closing\n"

        supervisor.before_shutdown_admission(self.server, run_cli, timeout=2)
        child.join(2)
        self.assertFalse(child.is_alive())

    def test_after_admission_waits_for_release_before_retry(self):
        def dispatch_worker():
            self.assertEqual(
                send_event(self.server.socket_path, "dispatch-admitted", 1, wait=True), b"C"
            )
            self.assertEqual(send_event(self.server.socket_path, "lease-released", 0), b"C")

        def stop_child():
            self.assertEqual(
                send_event(self.server.socket_path, "shutdown-after-modules", 1, wait=True), b"C"
            )
            self.assertEqual(
                send_event(self.server.socket_path, "shutdown-retry", 0, wait=True), b"C"
            )

        dispatch = threading.Thread(target=dispatch_worker)
        dispatch.start()

        def start_cli(command):
            self.assertEqual(command, "core stop now")
            process = threading.Thread(target=stop_child)
            process.start()
            return process

        process = supervisor.shutdown_after_admission(self.server, start_cli, timeout=2)
        dispatch.join(2)
        process.join(2)
        self.assertFalse(dispatch.is_alive())
        self.assertFalse(process.is_alive())

    def test_unexpected_event_fails_and_releases_barrier(self):
        def child():
            self.assertEqual(
                send_event(self.server.socket_path, "dispatch-admitted", 1, wait=True), b"C"
            )

        worker = threading.Thread(target=child)
        worker.start()
        with self.assertRaisesRegex(RuntimeError, "Unexpected shutdown event"):
            supervisor.expect_event(self.server, "shutdown-retry", 2)
        worker.join(2)
        self.assertFalse(worker.is_alive())

    def test_missing_event_times_out_explicitly(self):
        with self.assertRaisesRegex(TimeoutError, "did not report"):
            self.server.next_event(0.01)


if __name__ == "__main__":
    unittest.main()
