"""Test-only readback conformance on an authenticated Linux Unix socket."""

import json
import os
import re
import select
import signal
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time


with open("/vectors.json", encoding="utf8") as file:
    VECTORS = json.load(file)
UID = 1102
GID = 2100
BROKER_UID = 1101


def unprivileged():
    assert os.getuid() != 0
    with open("/proc/self/status", encoding="utf8") as file:
        assert "CapEff:\t0000000000000000" in file.read()


def remaining(connection, deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("Fixture connection deadline")
    connection.settimeout(seconds)


def read_frame(connection, maximum, deadline):
    def exact(count):
        data = bytearray()
        while len(data) < count:
            remaining(connection, deadline)
            chunk = connection.recv(count - len(data))
            if not chunk:
                raise ValueError("Truncated frame")
            data.extend(chunk)
        return bytes(data)

    length = struct.unpack("!I", exact(4))[0]
    if not 1 <= length <= maximum:
        raise ValueError("Invalid frame length")
    payload = exact(length)
    remaining(connection, deadline)
    if connection.recv(1):
        raise ValueError("Trailing frame bytes")
    return payload.decode("utf8", errors="strict")


def frame(text, maximum):
    payload = text.encode("utf8")
    if not 1 <= len(payload) <= maximum:
        raise ValueError("Invalid frame length")
    return struct.pack("!I", len(payload)) + payload


def readback(text):
    request = json.loads(text)
    binding = VECTORS["binding"]
    if not isinstance(request, dict) or type(request.get("version")) is not int or request["version"] != 1:
        raise ValueError("Invalid request")
    if request.get("customer") != binding["customer"] or request.get("epoch") != binding["epoch"]:
        raise ValueError("Foreign scope")
    base = {"version": 1, "customer": binding["customer"], "epoch": binding["epoch"]}
    if request.get("action") == "inventory" and set(request) == {"version", "customer", "epoch", "action"}:
        return {**base, "action": "inventory", "generations": [VECTORS["generation"]]}
    if request.get("action") == "generation" and set(request) == {"version", "customer", "epoch", "action", "generationId"}:
        generation = request["generationId"]
        if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", generation):
            raise ValueError("Invalid generation")
        result = {**base, "action": "generation", "generationId": generation}
        return {**result, "state": "observed", "observation": {
            "newCallsBlocked": True, "dialogs": "unknown", "removed": False,
        }} if generation == VECTORS["generation"]["generationId"] else {**result, "state": "missing"}
    raise ValueError("Unsupported fields/action")


def server(path):
    unprivileged()
    assert os.getuid() == BROKER_UID
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    reads = 0
    rejected = 0
    denied = 0
    try:
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        listener.settimeout(10)
        print(json.dumps({"ready": True}), flush=True)
        for _ in range(len(VECTORS["cases"]) + 2):
            connection, _ = listener.accept()
            with connection:
                deadline = time.monotonic() + 5
                pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != UID or gid != GID or pid <= 0:
                    denied += 1
                    continue
                try:
                    response = readback(read_frame(connection, 8192, deadline))
                except (ValueError, UnicodeError, TimeoutError):
                    rejected += 1
                    continue
                reads += 1
                remaining(connection, deadline)
                connection.sendall(frame(json.dumps(response, separators=(",", ":")), 32768))
                connection.shutdown(socket.SHUT_WR)
        print(json.dumps({"reads": reads, "rejected": rejected, "denied": denied}), flush=True)
    finally:
        listener.close()
        os.unlink(path)


def client(path, index):
    unprivileged()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    try:
        connection.connect(path)
        if index == "foreign":
            assert connection.recv(1) == b""
            return
        if index in ("capacity", "idle", "held-source"):
            if index == "held-source":
                connection.sendall(frame(VECTORS["cases"][0]["text"], 8192))
                connection.shutdown(socket.SHUT_WR)
            connection.settimeout(8)
            assert connection.recv(1) == b""
            return
        vector = VECTORS["cases"][int(index)] if index != "reconnect" else VECTORS["cases"][0]
        text = vector.get("text", "")
        if "padBytes" in vector:
            text += " " * (vector["padBytes"] - len(text.encode("utf8")))
        data = bytes.fromhex(vector["hex"]) if "hex" in vector else frame(text, 8192)
        for chunk in [data[:1], data[1:3], data[3:]]:
            connection.sendall(chunk)
        if vector["expected"] is not None:
            assert not select.select([connection], [], [], 0.02)[0], "Response arrived before request EOF"
        connection.shutdown(socket.SHUT_WR)
        if vector["expected"] is None:
            assert connection.recv(1) == b""
        else:
            assert json.loads(read_frame(connection, 32768, time.monotonic() + 5)) == vector["expected"]
    finally:
        connection.close()


def proof():
    assert sys.platform == "linux" and os.getuid() == 0
    os.setgroups([GID])
    with tempfile.TemporaryDirectory(prefix="broker-conformance-", dir="/proof") as directory:
        os.chmod(directory, 0o750)
        os.chown(directory, BROKER_UID, GID)
        path = os.path.join(directory, "readback.sock")
        process = subprocess.Popen([sys.executable, "-I", "-B", __file__, "server", path],
                                   user=BROKER_UID, group=GID, extra_groups=[],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            assert select.select([process.stdout], [], [], 10)[0]
            assert json.loads(process.stdout.readline()) == {"ready": True}
            for index in ["foreign", *map(str, range(len(VECTORS["cases"]))), "reconnect"]:
                result = subprocess.run([sys.executable, "-I", "-B", __file__, "client", path, index],
                                        user=1103 if index == "foreign" else UID, group=GID, extra_groups=[],
                                        capture_output=True, text=True, timeout=10)
                assert result.returncode == 0, f"{index}: {result.stderr}"
            output, error = process.communicate(timeout=10)
            assert process.returncode == 0, error
            rejected = sum(case["expected"] is None for case in VECTORS["cases"])
            assert json.loads(output) == {"reads": len(VECTORS["cases"]) - rejected + 1, "rejected": rejected, "denied": 1}
            assert not os.path.exists(path)
            print(f"PASS Python/Linux: {len(VECTORS['cases'])} shared framing/readback vectors, foreign peer denied before read, approved reconnect", flush=True)
            concurrent_proof(directory)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            os.chown(directory, 0, 0)

def concurrent_server(path):
    unprivileged()
    assert os.getuid() == BROKER_UID
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    slot = threading.Lock()
    release = threading.Event()
    stop = threading.Event()
    output_lock = threading.Lock()
    counts = {"reads": 0, "capacity": 0, "timeouts": 0}
    errors = []
    tasks = []

    def event(name):
        with output_lock:
            print(json.dumps({"event": name}), flush=True)

    def control():
        for line in sys.stdin:
            if line.strip() == "release":
                release.set()
            elif line.strip() == "stop":
                stop.set()
                return
            else:
                errors.append("Unknown fixture control")
                stop.set()
                return
        stop.set()

    def serve(connection):
        expired = threading.Event()

        def timeout():
            expired.set()
            counts["timeouts"] += 1
            connection.shutdown(socket.SHUT_RDWR)
            connection.close()
            event("timeout")

        timer = threading.Timer(5, timeout)
        try:
            timer.start()
            deadline = time.monotonic() + 5
            text = read_frame(connection, 8192, deadline)
            response = readback(text)
            counts["reads"] += 1
            if counts["reads"] == 1:
                event("source-entered")
                if not release.wait(15):
                    raise TimeoutError("Fixture source was not released")
            if not expired.is_set():
                remaining(connection, deadline)
                connection.sendall(frame(json.dumps(response), 32768))
                connection.shutdown(socket.SHUT_WR)
        except (OSError, ValueError, TimeoutError) as error:
            if not expired.is_set():
                errors.append(repr(error))
        finally:
            timer.cancel()
            timer.join()
            connection.close()
            slot.release()
            event("released")

    try:
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        listener.settimeout(0.1)
        threading.Thread(target=control, daemon=True).start()
        event("ready")
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            if not slot.acquire(blocking=False):
                counts["capacity"] += 1
                connection.close()
                event("capacity")
                continue
            pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != UID or gid != GID or pid <= 0:
                connection.close()
                slot.release()
                raise AssertionError("Concurrent fixture unexpected identity")
            task = threading.Thread(target=serve, args=(connection,))
            tasks.append(task)
            task.start()
            event("admitted")
        for task in tasks:
            task.join(16)
            assert not task.is_alive()
        assert not errors, errors
        assert counts == {"reads": 2, "capacity": 3, "timeouts": 2}, counts
        event("complete")
    finally:
        release.set()
        listener.close()
        os.unlink(path)


def concurrent_proof(directory):
    path = os.path.join(directory, "concurrent.sock")
    process = subprocess.Popen(
        [sys.executable, "-I", "-B", __file__, "concurrent-server", path],
        user=BROKER_UID, group=GID, extra_groups=[],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1,
    )
    clients = []

    def receive():
        data = bytearray()
        deadline = time.monotonic() + 10
        while not data.endswith(b"\n"):
            remaining_time = deadline - time.monotonic()
            assert remaining_time > 0 and select.select([process.stdout], [], [], remaining_time)[0], "Missing fixture event"
            byte = os.read(process.stdout.fileno(), 1)
            assert byte, "Fixture event stream closed"
            data.extend(byte)
            assert len(data) <= 1024
        return json.loads(data)

    def event(expected):
        value = receive()
        assert value == {"event": expected}, (expected, value)

    def start(mode):
        child = subprocess.Popen([sys.executable, "-I", "-B", __file__, "client", path, mode],
                                 user=UID, group=GID, extra_groups=[],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        clients.append(child)
        return child

    def done(child):
        _, error = child.communicate(timeout=10)
        assert child.returncode == 0, error

    try:
        event("ready")
        idle = start("idle")
        event("admitted")
        competitor = start("capacity")
        event("capacity")
        done(competitor)
        event("timeout")
        event("released")
        done(idle)
        held = start("held-source")
        # The source thread may print entry before the accept thread prints admission.
        observed = []
        for _ in range(2):
            observed.append(receive()["event"])
        assert sorted(observed) == ["admitted", "source-entered"]
        competitor = start("capacity")
        event("capacity")
        done(competitor)
        event("timeout")
        done(held)
        competitor = start("capacity")
        event("capacity")
        done(competitor)
        process.stdin.write("release\n")
        process.stdin.flush()
        event("released")
        recovered = start("reconnect")
        # Admission is emitted by accept, release by the source; order may differ.
        done(recovered)
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "released"]
        process.stdin.write("stop\n")
        process.stdin.flush()
        event("complete")
        _, error = process.communicate(timeout=10)
        assert process.returncode == 0, error
        assert not os.path.exists(path)
        print("PASS Python/Linux admission: idle deadline, competitors rejected, timed-out source retains slot until release, reconnect succeeds", flush=True)
    finally:
        for child in clients:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


signal.alarm(45)
if len(sys.argv) == 1:
    proof()
elif sys.argv[1] == "server":
    server(sys.argv[2])
elif sys.argv[1] == "client":
    client(sys.argv[2], sys.argv[3])
elif sys.argv[1] == "concurrent-server":
    concurrent_server(sys.argv[2])
else:
    raise ValueError("Unknown fixture mode")
