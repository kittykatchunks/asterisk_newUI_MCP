"""Linux-only synthetic SQLite source through the actual authenticated listener."""

import json
import logging
import multiprocessing
import os
from pathlib import Path
import queue
import re
import socket
import stat
import struct
import subprocess
import tempfile
import uuid


def prove(broker, source_type, database, binding, generation_id):
    assert os.getuid() == 0, "Listener proof requires the isolated Linux test supervisor"
    os.setgroups([2100])
    os.setgid(2100)
    context = multiprocessing.get_context("fork")
    stop, ready = context.Event(), context.Event()
    calls = context.Value("i", 0)
    diagnostics = context.Queue()

    class CountedSource(source_type):
        def inventory(self, cancellation):
            with calls.get_lock():
                calls.value += 1
            return super().inventory(cancellation)

        def generation(self, generation_id, cancellation):
            with calls.get_lock():
                calls.value += 1
            return super().generation(generation_id, cancellation)

    def drop(uid, groups=()):
        os.setgroups(groups)
        os.setgid(2100)
        os.setuid(uid)
        with open("/proc/self/status", encoding="ascii") as status:
            assert re.search(r"^CapEff:\s+0+$", status.read(), re.MULTILINE)

    # The root supervisor keeps ownership; only the broker's extra reader group
    # can read the synthetic DB. Worker clients receive no such group.
    database_stat = os.stat(database)
    parent_stat = os.stat(Path(database).parent)
    os.chown(Path(database).parent, 0, 2100)
    os.chmod(Path(database).parent, 0o750)
    os.chown(database, 0, 1101)
    os.chmod(database, 0o440)
    with tempfile.TemporaryDirectory(dir="/proof") as directory:
        os.chmod(directory, 0o750)
        os.chown(directory, 1101, 2100)
        path = os.path.join(directory, "readback.sock")

        def serve():
            drop(1101, [1101])

            class Handler(logging.Handler):
                def emit(self, record):
                    diagnostics.put(record.getMessage())

            broker.LOG.handlers = [Handler()]
            broker.LOG.propagate = False
            broker.LOG.setLevel(logging.WARNING)
            broker.Broker(binding, CountedSource(database, binding)).serve(path, stop, ready)

        server = context.Process(target=serve)
        clients = []
        results = {}
        expected_calls = 0
        expected_diagnostics = []
        base = {"version": 1, "customer": binding.customer, "epoch": binding.epoch}
        server.start()
        try:
            assert ready.wait(3), "Synthetic source listener did not become ready"
            for runtime in ("python", "node"):
                results[runtime] = {}
                cases = [
                    ("denied", {**base, "action": "inventory"}, "denied", 0),
                    ("scope", {**base, "epoch": str(uuid.uuid4()), "action": "inventory"}, "rejected", 0),
                    ("inventory", {**base, "action": "inventory"}, "accepted", 1),
                    ("generation", {**base, "action": "generation", "generationId": generation_id}, "accepted", 1),
                    ("missing", {**base, "action": "generation", "generationId": str(uuid.uuid4())}, "rejected", 1),
                    ("recovery", {**base, "action": "inventory"}, "accepted", 1),
                ]
                for name, request, outcome, entries in cases:
                    uid = 1103 if outcome == "denied" else 1102
                    if runtime == "node":
                        result = subprocess.run(
                            ["node", str(Path(__file__).with_name("fake-broker-socket-client.ts")),
                             path, json.dumps(request), outcome],
                            user=uid, group=2100, extra_groups=[], capture_output=True, text=True, timeout=7)
                        assert result.returncode == 0 and result.stderr == "", result.stderr
                        value = json.loads(result.stdout)
                        pid = None
                    else:
                        receiver, sender = context.Pipe(duplex=False)

                        def execute():
                            drop(uid)
                            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                                connection.settimeout(5)
                                connection.connect(path)
                                if outcome != "denied":
                                    connection.sendall(broker.encode_frame(json.dumps(request), 8192))
                                    connection.shutdown(socket.SHUT_WR)
                                data = bytearray()
                                while chunk := connection.recv(4096):
                                    data.extend(chunk)
                                if outcome == "accepted":
                                    assert len(data) >= 4 and struct.unpack("!I", data[:4])[0] == len(data) - 4
                                    sender.send(json.loads(data[4:]))
                                else:
                                    assert not data
                                    sender.send(None)
                            sender.close()

                        process = context.Process(target=execute)
                        clients.append(process)
                        process.start()
                        sender.close()
                        try:
                            process.join(6)
                            assert not process.is_alive() and process.exitcode == 0, process.exitcode
                            assert receiver.poll(1), "Synthetic client produced no result"
                            value = receiver.recv()
                        finally:
                            receiver.close()
                        pid = process.pid
                    results[runtime][name] = value
                    expected_calls += entries
                    assert calls.value == expected_calls, (runtime, name, calls.value, expected_calls)
                    if outcome == "denied":
                        # Node PID belongs to the directly spawned process.
                        if pid is None:
                            message = diagnostics.get(timeout=1)
                            assert re.fullmatch(
                                r"Broker peer denied: pid=[1-9][0-9]* uid=1103 gid=2100", message), message
                            expected_diagnostics.append(message)
                        else:
                            expected_diagnostics.append(f"Broker peer denied: pid={pid} uid=1103 gid=2100")
                    elif outcome == "rejected":
                        expected_diagnostics.append("Broker read-only connection rejected")
                    # Consume each record before the next case; no hidden outcomes.
                    if outcome != "accepted" and not (outcome == "denied" and runtime == "node"):
                        assert diagnostics.get(timeout=1) == expected_diagnostics[-1]
            stop.set()
            server.join(3)
            assert not server.is_alive() and server.exitcode == 0, server.exitcode
            assert not os.path.exists(path)
            try:
                extra = diagnostics.get(timeout=0.1)
            except queue.Empty:
                pass
            else:
                raise AssertionError(f"Unexpected broker diagnostic: {extra}")
            assert calls.value == 8 and len(expected_diagnostics) == 6
            return results
        finally:
            stop.set()
            for process in [*clients, server]:
                process.join(1)
                if process.is_alive():
                    process.kill()
                    process.join(2)
                    assert not process.is_alive()
            os.chown(directory, 0, 2100)
            os.chmod(directory, 0o700)
            os.chown(database, database_stat.st_uid, database_stat.st_gid)
            os.chmod(database, stat.S_IMODE(database_stat.st_mode))
            os.chown(Path(database).parent, parent_stat.st_uid, parent_stat.st_gid)
            os.chmod(Path(database).parent, stat.S_IMODE(parent_stat.st_mode))
