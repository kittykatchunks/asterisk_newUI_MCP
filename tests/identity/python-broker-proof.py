"""Exercises the implementation module, not the experimental broker server."""

import copy
import importlib.util
import json
import logging
import multiprocessing
import os
import queue
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest


spec = importlib.util.spec_from_file_location("broker", "/broker.py")
broker = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = broker
spec.loader.exec_module(broker)
with open("/vectors.json", encoding="utf8") as file:
    vectors = json.load(file)
binding = broker.Binding(**vectors["binding"], uid=1102, gid=2100)


class FakeSource:
    def __init__(self):
        self.calls = 0
        self.kind = None
        self.value = None
        self.fail = False

    def inventory(self, cancellation):
        self.calls += 1
        if self.fail:
            raise RuntimeError("Injected source failure")
        return self.value if self.kind == "inventory" else [vectors["generation"]]

    def generation(self, generation_id, cancellation):
        self.calls += 1
        if self.fail:
            raise RuntimeError("Injected source failure")
        if generation_id != vectors["generation"]["generationId"]:
            return broker.MISSING
        return self.value if self.kind == "observation" else {
            "newCallsBlocked": True, "dialogs": "unknown", "removed": False,
        }


def decode(frame):
    assert struct.unpack("!I", frame[:4])[0] == len(frame) - 4
    return json.loads(frame[4:])


class ProtocolTests(unittest.TestCase):
    def test_shared_request_corpus(self):
        for vector in vectors["cases"]:
            with self.subTest(case=vector["name"]):
                left, right = socket.socketpair()
                if "hex" in vector:
                    data = bytes.fromhex(vector["hex"])
                else:
                    text = vector["text"].ljust(vector.get("padBytes", 0), " ")
                    data = broker.encode_frame(text, 8192) + bytes.fromhex(vector.get("trailingHex", ""))

                def send():
                    try:
                        left.sendall(data)
                        time.sleep(vector.get("delayEofMs", 0) / 1000)
                        left.shutdown(socket.SHUT_WR)
                    finally:
                        left.close()

                sender = threading.Thread(target=send)
                sender.start()
                source = FakeSource()
                try:
                    if vector["expected"] is None:
                        with self.assertRaises((ValueError, UnicodeError)):
                            text = broker.read_frame(right, time.monotonic() + 5)
                            broker.readback(text, binding, source, threading.Event())
                        self.assertEqual(source.calls, 0)
                    else:
                        text = broker.read_frame(right, time.monotonic() + 5)
                        self.assertEqual(decode(broker.readback(text, binding, source, threading.Event())),
                                         vector["expected"])
                        self.assertEqual(source.calls, 1)
                finally:
                    right.close()
                    sender.join(3)
                    self.assertFalse(sender.is_alive())

    def test_shared_source_corpus(self):
        for original in vectors["sourceCases"]:
            case = copy.deepcopy(original)
            with self.subTest(case=case.get("name")):
                source = FakeSource()
                source.kind = case["kind"]
                source.value = case.get("value")
                if "inventoryCount" in case:
                    source.value = [{"generationId": f"22222222-2222-2222-2222-{index:012x}",
                                     "notAfter": index + 1, "draining": index % 2 == 0}
                                    for index in range(case["inventoryCount"])]
                action = "inventory" if case["kind"] == "inventory" else "generation"
                request = {"version": 1, "customer": binding.customer, "epoch": binding.epoch, "action": action}
                if action == "generation":
                    request["generationId"] = vectors["generation"]["generationId"]
                if case["valid"]:
                    response = decode(broker.readback(json.dumps(request), binding, source, threading.Event()))
                    self.assertEqual(response["generations"] if case["kind"] == "inventory" else
                                     response["observation"], source.value)
                else:
                    with self.assertRaises(ValueError):
                        broker.readback(json.dumps(request), binding, source, threading.Event())
                self.assertEqual(source.calls, 1)

    def test_source_failure_and_cancellation(self):
        source = FakeSource()
        source.fail = True
        with self.assertRaisesRegex(RuntimeError, "Injected source failure"):
            broker.readback(vectors["cases"][1]["text"], binding, source, threading.Event())
        source.fail = False
        self.assertEqual(decode(broker.readback(vectors["cases"][1]["text"], binding, source,
                                               threading.Event()))["state"], "observed")
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(ValueError):
            broker.readback(vectors["cases"][0]["text"], binding, source, cancelled)
        self.assertEqual(source.calls, 2)

    def test_binding_is_strict(self):
        for change in ({"uid": 0}, {"uid": True}, {"gid": -1}, {"customer": "../x"}, {"epoch": "x"},
                       {"principal": "worker\n"}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                broker.Binding(**{**vars(binding), **change})


def drop(uid):
    os.setgroups([])
    os.setgid(2100)
    os.setuid(uid)


def kernel_proof(scenario):
    os.setgroups([2100])
    os.setgid(2100)
    context = multiprocessing.get_context("fork")
    stop, ready, entered, release, cancelled = (context.Event() for _ in range(5))
    calls = context.Value("i", 0)
    half_closed = context.Event()
    diagnostics = context.Queue()

    class HeldSource(FakeSource):
        def inventory(self, cancellation):
            with calls.get_lock():
                calls.value += 1
                entry = calls.value
            if entry == 1:
                entered.set()
                if not cancellation.wait(8):
                    raise RuntimeError("Broker failed to cancel held source")
                cancelled.set()
                if not release.wait(8):
                    raise RuntimeError("Parent failed to release source")
            return [{**vectors["generation"], "notAfter": vectors["generation"]["notAfter"] + entry}]

    with tempfile.TemporaryDirectory(dir="/proof") as directory:
        os.chmod(directory, 0o750)
        os.chown(directory, 1101, 2100)
        path = os.path.join(directory, "broker.sock")

        def serve():
            drop(1101)

            class EvidenceHandler(logging.Handler):
                def emit(self, record):
                    diagnostics.put(record.getMessage())

            broker.LOG.handlers = [EvidenceHandler()]
            broker.LOG.propagate = False
            broker.LOG.setLevel(logging.WARNING)
            broker.Broker(binding, HeldSource()).serve(path, stop, ready)

        server = context.Process(target=serve)
        clients = []

        def run_client(mode, uid=1102, gid=2100):
            def execute():
                os.setgroups([2100] if gid != 2100 else [])
                os.setgid(gid)
                os.setuid(uid)
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(8)
                    connection.connect(path)
                    if mode == "denied":
                        assert connection.recv(1) == b""
                        return
                    connection.sendall(broker.encode_frame(vectors["cases"][0]["text"], 8192))
                    connection.shutdown(socket.SHUT_WR)
                    if mode == "held":
                        half_closed.set()
                        assert connection.recv(1) == b""
                        return
                    data = bytearray()
                    while chunk := connection.recv(4096):
                        data.extend(chunk)
                    assert decode(data)["generations"][0]["notAfter"] == vectors["generation"]["notAfter"] + 2

            process = context.Process(target=execute)
            clients.append(process)
            process.start()
            return process

        def finished(process):
            process.join(9)
            assert not process.is_alive() and process.exitcode == 0, process.exitcode

        server.start()
        try:
            assert ready.wait(3), "Runtime broker did not become ready"
            assert os.stat(path).st_mode & 0o777 == 0o660
            original = os.lstat(path)

            def duplicate():
                drop(1101)
                try:
                    broker.Broker(binding, HeldSource()).serve(path, context.Event(), context.Event())
                except OSError as error:
                    assert error.errno == 98
                else:
                    raise AssertionError("Duplicate broker replaced a live socket")

            duplicate_server = context.Process(target=duplicate)
            clients.append(duplicate_server)
            duplicate_server.start()
            finished(duplicate_server)
            assert os.lstat(path).st_ino == original.st_ino
            finished(run_client("denied", 1103))
            finished(run_client("denied", 1102, 2101))
            assert calls.value == 0
            held = run_client("held")
            assert entered.wait(3)
            assert half_closed.wait(1)
            assert not cancelled.wait(0.2), "Required write half-close was mistaken for peer loss"
            finished(run_client("denied"))
            assert calls.value == 1
            if scenario == "peer loss":
                started = time.monotonic()
                held.kill()
                held.join(2)
                assert held.exitcode == -9
                assert cancelled.wait(2), "Full peer loss did not cancel the actual source"
                assert time.monotonic() - started < 3
            elif scenario == "shutdown":
                started = time.monotonic()
                stop.set()
                assert cancelled.wait(2), "Shutdown did not cancel the actual source"
                finished(held)
                assert time.monotonic() - started < 3
            else:
                finished(held)
                assert cancelled.wait(2), "Deadline did not propagate to source"
            if scenario != "shutdown":
                finished(run_client("denied"))
            else:
                server.join(0.2)
                assert server.is_alive(), "Shutdown abandoned an unsettled source"
                assert os.path.exists(path), "Shutdown removed the path before source settlement"
            assert calls.value == 1
            release.set()
            if scenario != "shutdown":
                time.sleep(0.2)
                finished(run_client("recovery"))
                assert calls.value == 2
                result = subprocess.run(["node", "/tests/identity/broker-cross-client.ts", path, "disconnect-reconnect-3"],
                                        user=1102, group=2100, extra_groups=[], capture_output=True,
                                        text=True, timeout=10)
                assert result.returncode == 0 and result.stdout == "" and result.stderr == "", result.stderr
                assert calls.value == 3
                stop.set()
            finished(server)
            assert not os.path.exists(path)
            assert calls.value == (1 if scenario == "shutdown" else 3), "Unexpected replay or source entry"
            records = []
            while True:
                try:
                    records.append(diagnostics.get(timeout=0.1))
                except queue.Empty:
                    break
            outcomes = [record for record in records if record.startswith("Broker connection terminated:")]
            assert outcomes == [f"Broker connection terminated: {scenario}"], records
            assert records.count("Broker read-only connection rejected") == 1, records
            assert records.count("Broker connection denied: capacity") == (1 if scenario == "shutdown" else 2), records
            assert len([record for record in records if record.startswith("Broker peer denied:")]) == 2, records
            assert len(records) == (5 if scenario == "shutdown" else 6), records
        finally:
            stop.set()
            release.set()
            for process in [*clients, server]:
                process.join(2)
                if process.is_alive():
                    process.kill()
                    process.join()
            os.chown(directory, 0, 0)
            diagnostics.close()
            diagnostics.join_thread()
    print(f"PASS implementation {scenario}: half-close preserved, exact terminal reason, source retained until settlement, cleanup"
          + (", Python/Node fresh recovery" if scenario != "shutdown" else ", shutdown waits without replay"))


if __name__ == "__main__":
    if not unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(ProtocolTests)).wasSuccessful():
        sys.exit(1)
    for scenario in ("deadline", "peer loss", "shutdown"):
        kernel_proof(scenario)
