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
for case in VECTORS["sourceCases"]:
    if "inventoryCount" in case:
        case["value"] = [
            {"generationId": f"22222222-2222-2222-2222-{index:012x}",
             "notAfter": index + 1, "draining": index % 2 == 0}
            for index in range(case["inventoryCount"])
        ]
        assert len({item["generationId"] for item in case["value"]}) == case["inventoryCount"]
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


def read_frame(connection, maximum, deadline, on_payload=None):
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
    if on_payload is not None:
        on_payload(payload)
    remaining(connection, deadline)
    if connection.recv(1):
        raise ValueError("Trailing frame bytes")
    return payload.decode("utf8", errors="strict")


def frame(text, maximum):
    payload = text.encode("utf8")
    if not 1 <= len(payload) <= maximum:
        raise ValueError("Invalid frame length")
    return struct.pack("!I", len(payload)) + payload


def safe_integer(value, minimum):
    return (type(value) is int or type(value) is float and value.is_integer()) and minimum <= value <= 9007199254740991


def inventory(value):
    if not isinstance(value, list) or len(value) > 100:
        raise ValueError("Invalid expiry inventory")
    ids = set()
    result = []
    for item in value:
        if (not isinstance(item, dict) or set(item) != {"generationId", "notAfter", "draining"}
                or not isinstance(item["generationId"], str)
                or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", item["generationId"])
                or not safe_integer(item["notAfter"], 1) or type(item["draining"]) is not bool
                or item["generationId"] in ids):
            raise ValueError("Invalid expiry generation")
        ids.add(item["generationId"])
        result.append(dict(item))
    return result


def observation(value):
    if (not isinstance(value, dict) or set(value) != {"newCallsBlocked", "dialogs", "removed"}
            or type(value["newCallsBlocked"]) is not bool or type(value["removed"]) is not bool
            or not (value["dialogs"] == "unknown" or safe_integer(value["dialogs"], 0))):
        raise ValueError("Invalid expiry observation")
    return dict(value)


class FixtureSourceFailure(RuntimeError):
    pass


def source_value(source, default, on_source):
    if on_source is not None:
        on_source()
    if callable(source):
        return source(default)
    return source["value"] if source is not None else default


def reject_json_constant(token):
    raise json.JSONDecodeError("Non-standard JSON constant", token, 0)


def readback(text, source=None, on_source=None):
    request = json.loads(text, parse_int=float, parse_constant=reject_json_constant)
    binding = VECTORS["binding"]
    if (not isinstance(request, dict) or type(request.get("version")) not in (int, float)
            or request["version"] != 1):
        raise ValueError("Invalid request")
    if request.get("customer") != binding["customer"] or request.get("epoch") != binding["epoch"]:
        raise ValueError("Foreign scope")
    base = {"version": 1, "customer": binding["customer"], "epoch": binding["epoch"]}
    if request.get("action") == "inventory" and set(request) == {"version", "customer", "epoch", "action"}:
        value = source_value(source, [VECTORS["generation"]], on_source)
        return {**base, "action": "inventory", "generations": inventory(value)}
    if request.get("action") == "generation" and set(request) == {"version", "customer", "epoch", "action", "generationId"}:
        generation = request["generationId"]
        if not isinstance(generation, str) or not re.fullmatch(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}", generation):
            raise ValueError("Invalid generation")
        result = {**base, "action": "generation", "generationId": generation}
        value = source_value(source, {
            "newCallsBlocked": True, "dialogs": "unknown", "removed": False,
        }, on_source)
        return {**result, "state": "observed", "observation": observation(value)} if generation == VECTORS["generation"]["generationId"] else {**result, "state": "missing"}
    raise ValueError("Unsupported fields/action")


def server(path, require_visible_pid=True):
    unprivileged()
    assert os.getuid() == BROKER_UID
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    reads = 0
    rejected = 0
    denied = 0
    source_entries = 0

    def entered():
        nonlocal source_entries
        source_entries += 1

    try:
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        listener.settimeout(10)
        print(json.dumps({"ready": True}), flush=True)
        for index in range(len(VECTORS["cases"]) + len(VECTORS["sourceCases"]) + 2):
            connection, _ = listener.accept()
            with connection:
                deadline = time.monotonic() + 5
                pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if not require_visible_pid:
                    print(json.dumps({"peer": {"pid": pid, "uid": uid, "gid": gid}}), flush=True)
                if uid != UID or gid != GID or (require_visible_pid and pid <= 0):
                    denied += 1
                    continue
                before = source_entries
                source_index = index - len(VECTORS["cases"]) - 1
                expected_entries = (1 if index > len(VECTORS["cases"]) else
                                    int(VECTORS["cases"][index - 1]["expected"] is not None))
                failure = VECTORS["cases"][index - 1].get("failure") if index <= len(VECTORS["cases"]) else None
                try:
                    source = VECTORS["sourceCases"][source_index] if 0 <= source_index < len(VECTORS["sourceCases"]) else None
                    response = readback(read_frame(connection, 8192, deadline), source, entered)
                except (ValueError, UnicodeError, TimeoutError) as error:
                    if failure == "utf8":
                        assert isinstance(error, UnicodeDecodeError), (index, repr(error))
                    elif failure == "json":
                        assert isinstance(error, json.JSONDecodeError), (index, repr(error))
                    elif failure:
                        assert type(error) is ValueError and failure in str(error).lower(), (index, repr(error))
                    rejected += 1
                    continue
                finally:
                    assert source_entries - before == expected_entries, (index, source_entries - before, expected_entries)
                reads += 1
                assert failure is None, (index, "Expected framing failure")
                remaining(connection, deadline)
                connection.sendall(frame(json.dumps(response, separators=(",", ":")), 32768))
                connection.shutdown(socket.SHUT_WR)
        print(json.dumps({"reads": reads, "sourceEntries": source_entries, "rejected": rejected, "denied": denied}), flush=True)
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
        if index in ("capacity", "idle", "held-source", "failed-source", "failed-generation", "no-eof"):
            if index == "no-eof":
                connection.sendall(frame(VECTORS["cases"][0]["text"], 8192))
            elif index == "failed-generation":
                connection.sendall(frame(VECTORS["cases"][1]["text"], 8192))
                connection.shutdown(socket.SHUT_WR)
            elif index in ("held-source", "failed-source"):
                connection.sendall(frame(VECTORS["cases"][0]["text"], 8192))
                connection.shutdown(socket.SHUT_WR)
            connection.settimeout(8)
            assert connection.recv(1) == b""
            return
        if index.startswith("source:"):
            source = VECTORS["sourceCases"][int(index.split(":")[1])]
            action = "inventory" if source["kind"] == "inventory" else "generation"
            request = {"version": 1, "customer": VECTORS["binding"]["customer"],
                       "epoch": VECTORS["binding"]["epoch"], "action": action}
            expected = dict(request)
            if action == "generation":
                request["generationId"] = VECTORS["generation"]["generationId"]
                expected.update({"generationId": request["generationId"], "state": "observed", "observation": source["value"]})
            else:
                expected["generations"] = source["value"]
            vector = {"text": json.dumps(request), "expected": expected if source["valid"] else None}
        else:
            vector = VECTORS["cases"][1] if index == "generation-reconnect" else (
                VECTORS["cases"][int(index)] if index != "reconnect" else VECTORS["cases"][0])
        text = vector.get("text", "")
        if "padBytes" in vector:
            text += " " * (vector["padBytes"] - len(text.encode("utf8")))
        data = bytes.fromhex(vector["hex"]) if "hex" in vector else frame(text, 8192)
        for chunk in [data[:1], data[1:3], data[3:]]:
            connection.sendall(chunk)
        if vector["expected"] is not None or "delayEofMs" in vector:
            assert not select.select([connection], [], [], vector.get("delayEofMs", 20) / 1000)[0], "Response arrived before request EOF"
        if "trailingHex" in vector:
            connection.sendall(bytes.fromhex(vector["trailingHex"]))
        connection.shutdown(socket.SHUT_WR)
        if vector["expected"] is None:
            try:
                assert connection.recv(1) == b""
            except ConnectionResetError:
                assert vector.get("failure") == "trailing" and vector["name"] == "concatenated-valid-requests"
        else:
            assert json.loads(read_frame(connection, 32768, time.monotonic() + 5)) == vector["expected"]
    finally:
        connection.close()


def proof(cross_runtime=False):
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
            for index in ["foreign", *map(str, range(len(VECTORS["cases"]))),
                          *(f"source:{i}" for i in range(len(VECTORS["sourceCases"]))), "reconnect"]:
                command = (["node", "/tests/identity/broker-cross-client.ts", path, index] if cross_runtime
                           else [sys.executable, "-I", "-B", __file__, "client", path, index])
                result = subprocess.run(command,
                                        user=1103 if index == "foreign" else UID, group=GID, extra_groups=[],
                                        capture_output=True, text=True, timeout=10)
                assert result.returncode == 0, f"{index}: {result.stderr}"
            output, error = process.communicate(timeout=10)
            assert process.returncode == 0, error
            rejected = sum(case["expected"] is None for case in VECTORS["cases"]) + sum(not case["valid"] for case in VECTORS["sourceCases"])
            request_entries = sum(case["expected"] is not None for case in VECTORS["cases"])
            assert json.loads(output) == {
                "reads": len(VECTORS["cases"]) + len(VECTORS["sourceCases"]) - rejected + 1,
                "sourceEntries": request_entries + len(VECTORS["sourceCases"]) + 1,
                "rejected": rejected, "denied": 1,
            }
            assert not os.path.exists(path)
            print(f"PASS Python/Linux: {len(VECTORS['cases'])} shared framing/readback vectors, foreign peer denied before read, approved reconnect", flush=True)
            print(f"PASS Python/Linux: {len(VECTORS['sourceCases'])} shared source-output vectors, invalid outputs close without a response frame", flush=True)
            if cross_runtime:
                print("PASS Node/TypeScript client to Python broker: real Unix socket, production frame reader/writer, all shared cases and approved reconnect", flush=True)
            concurrent_proof(directory, cross_runtime=cross_runtime)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            os.chown(directory, 0, 0)

def concurrent_server(path, require_visible_pid=True, admission_only=False):
    unprivileged()
    assert os.getuid() == BROKER_UID
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    slot = threading.Lock()
    release = threading.Event()
    stop = threading.Event()
    output_lock = threading.RLock()
    lifetime_lock = threading.RLock()
    active = {}
    late_cancel_observed = threading.Event()
    repeat_cancel_observed = threading.Event()
    counts = {"reads": 0, "generationReads": 0, "capacity": 0, "timeouts": 0,
              "requestTimeouts": 0, "sourceFailures": 0, "cancellations": 0}
    errors = []
    tasks = []

    def event(name):
        with output_lock:
            print(json.dumps({"event": name}), flush=True)

    def release_held_source(_signal, _frame):
        state = (counts["reads"], counts["timeouts"], counts["capacity"], counts["cancellations"])
        if (state not in ((5, 3, 4, 0), (7, 3, 6, 1)) or
                not slot.locked() or release.is_set() or
                (counts["reads"] == 5 and not late_cancel_observed.is_set()) or
                (counts["reads"] == 7 and not repeat_cancel_observed.is_set())):
            errors.append("Unexpected parent source-release signal")
        release.set()

    def cancel_held_source(_signal, _frame):
        with lifetime_lock:
            state = (counts["reads"], counts["timeouts"], counts["capacity"], counts["cancellations"])
            if (state not in ((5, 3, 3, 0), (7, 3, 4, 0), (7, 3, 5, 1)) or
                    (counts["reads"] == 5 and late_cancel_observed.is_set()) or
                    (counts["reads"] == 7 and repeat_cancel_observed.is_set()) or
                    not slot.locked() or release.is_set() or "cancel" not in active):
                errors.append("Unexpected parent cancellation signal")
                return
            active["cancel"]("cancelled")

    def control():
        for line in sys.stdin:
            if line.strip() == "release":
                release.set()
            elif line.strip() == "cancel":
                with lifetime_lock:
                    if "cancel" not in active:
                        errors.append("Cancellation without an active connection")
                        stop.set()
                        return
                    active["cancel"]("cancelled")
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
        request_complete = threading.Event()
        body_received = threading.Event()
        before = counts["reads"]

        def received(payload):
            vector = VECTORS["cases"][0]
            expected = vector["text"].encode("utf8")
            assert payload in (expected, expected.ljust(vector["padBytes"], b" "),
                               VECTORS["cases"][1]["text"].encode("utf8"))
            body_received.set()
            event("request-body-received")

        def source(default):
            with lifetime_lock:
                if expired.is_set():
                    raise TimeoutError("Fixture source after terminal connection")
                remaining(connection, deadline)
                counts["reads"] += 1
                if not isinstance(default, list):
                    counts["generationReads"] += 1
            if admission_only:
                if counts["reads"] == 1:
                    raise FixtureSourceFailure("Fixture source unavailable")
                if counts["reads"] == 3:
                    assert not isinstance(default, list)
                    raise FixtureSourceFailure("Fixture generation source unavailable")
                if counts["reads"] in (5, 7):
                    entry = counts["reads"]
                    release.clear()
                    event("source-entered")
                    if not release.wait(15):
                        errors.append("Held container source was not released by parent")
                        raise TimeoutError("Fixture source was not released")
                    assert expired.is_set() and slot.locked()
                    assert counts["capacity"] == (4 if entry == 5 else 6) and counts["reads"] == entry
                    event("source-settled")
                return default
            if counts["reads"] in (1, 5):
                release.clear()
                event("source-entered")
                if not release.wait(15):
                    raise TimeoutError("Fixture source was not released")
            elif counts["reads"] == 3:
                raise FixtureSourceFailure("Fixture source unavailable")
            elif counts["reads"] == 7:
                assert not isinstance(default, list)
                raise FixtureSourceFailure("Fixture generation source unavailable")
            return default

        def terminate(reason):
            with lifetime_lock:
                if active.get("cancel") is not terminate:
                    return
                if expired.is_set():
                    if admission_only and reason == "cancelled" and counts["reads"] == 7:
                        repeat_cancel_observed.set()
                        with output_lock:
                            print(json.dumps({"repeatedCancellation": {
                                "sourceEntries": counts["reads"], "timeouts": counts["timeouts"],
                                "cancellations": counts["cancellations"], "slotLocked": slot.locked(),
                            }}), flush=True)
                        event("repeated-cancellation-observed")
                    if admission_only and reason == "cancelled" and counts["reads"] == 5:
                        late_cancel_observed.set()
                        with output_lock:
                            print(json.dumps({"lateCancellation": {
                                "sourceEntries": counts["reads"], "timeouts": counts["timeouts"],
                                "cancellations": counts["cancellations"], "slotLocked": slot.locked(),
                            }}), flush=True)
                        event("late-cancellation-observed")
                    if admission_only and reason == "timeout" and counts["reads"] == 7:
                        with output_lock:
                            print(json.dumps({"cancelledDeadline": {
                                "elapsedSeconds": time.monotonic() - (deadline - 5),
                                "sourceEntries": counts["reads"], "timeouts": counts["timeouts"],
                                "cancellations": counts["cancellations"], "slotLocked": slot.locked(),
                            }}), flush=True)
                        event("cancelled-deadline-observed")
                    return
                expired.set()
                counts["timeouts" if reason == "timeout" else "cancellations"] += 1
                if reason == "timeout" and not request_complete.is_set():
                    counts["requestTimeouts"] += 1
                    if counts["reads"] != before:
                        errors.append("Source entered before complete request EOF")
                if admission_only and reason == "timeout":
                    elapsed = time.monotonic() - (deadline - 5)
                    assert 5 <= elapsed < 8, elapsed
                    with output_lock:
                        print(json.dumps({"admissionTimeout": {"elapsedSeconds": elapsed,
                                                              "sourceEntries": counts["reads"],
                                                              "bodyReceived": body_received.is_set()}}), flush=True)
                connection.shutdown(socket.SHUT_RDWR)
                connection.close()
                event(reason)

        deadline = time.monotonic() + 5
        timer = threading.Timer(max(0, deadline - time.monotonic()), terminate, args=("timeout",))
        try:
            with lifetime_lock:
                active["cancel"] = terminate
            timer.start()
            text = read_frame(connection, 8192, deadline, received if admission_only else None)
            with lifetime_lock:
                if expired.is_set():
                    return
                remaining(connection, deadline)
                request_complete.set()
            response = readback(text, source)
            if not expired.is_set():
                remaining(connection, deadline)
                connection.sendall(frame(json.dumps(response), 32768))
                connection.shutdown(socket.SHUT_WR)
                if admission_only and counts["reads"] == 8:
                    stop.set()
        except FixtureSourceFailure as error:
            counts["sourceFailures"] += 1
            with output_lock:
                print(str(error), file=sys.stderr, flush=True)
                if admission_only:
                    print(json.dumps({"admissionSourceFailure": {"sourceEntries": counts["reads"],
                                                                 "generationReads": counts["generationReads"],
                                                                 "timeouts": counts["timeouts"]}}), flush=True)
            event("source-failed")
        except TimeoutError as error:
            if expired.is_set():
                pass
            elif time.monotonic() >= deadline:
                terminate("timeout")
            else:
                errors.append(repr(error))
        except (OSError, ValueError) as error:
            if not expired.is_set():
                errors.append(repr(error))
        finally:
            with lifetime_lock:
                if active.get("cancel") is terminate:
                    active.clear()
            timer.cancel()
            timer.join()
            connection.close()
            slot.release()
            event("released")

    try:
        if admission_only:
            previous_release_handler = signal.signal(signal.SIGUSR1, release_held_source)
            previous_cancel_handler = signal.signal(signal.SIGUSR2, cancel_held_source)
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        listener.settimeout(0.1)
        if not admission_only:
            threading.Thread(target=control, daemon=True).start()
        event("ready")
        while not stop.is_set():
            try:
                connection, _ = listener.accept()
            except socket.timeout:
                continue
            pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if not require_visible_pid:
                with output_lock:
                    print(json.dumps({"peer": {"pid": pid, "uid": uid, "gid": gid}}), flush=True)
            if uid != UID or gid != GID or (require_visible_pid and pid <= 0):
                connection.close()
                raise AssertionError("Concurrent fixture unexpected identity")
            if not slot.acquire(blocking=False):
                counts["capacity"] += 1
                connection.close()
                if admission_only and counts["reads"] in (5, 7):
                    with output_lock:
                        print(json.dumps({"heldCapacity": {"sourceEntries": counts["reads"],
                                                           "timeouts": counts["timeouts"],
                                                           "cancellations": counts["cancellations"],
                                                           "slotLocked": slot.locked()}}), flush=True)
                event("capacity")
                continue
            task = threading.Thread(target=serve, args=(connection,))
            tasks.append(task)
            task.start()
            event("admitted")
        for task in tasks:
            task.join(16)
            assert not task.is_alive()
        assert not errors, errors
        expected = ({"reads": 8, "generationReads": 2, "capacity": 6, "timeouts": 3,
                     "requestTimeouts": 2, "sourceFailures": 2, "cancellations": 1} if admission_only else
                    {"reads": 9, "generationReads": 2, "capacity": 5, "timeouts": 3,
                     "requestTimeouts": 2, "sourceFailures": 2, "cancellations": 1})
        assert counts == expected, counts
        if admission_only:
            with output_lock:
                print(json.dumps({"admissionCounts": counts}), flush=True)
        event("complete")
    finally:
        if admission_only:
            signal.signal(signal.SIGUSR1, previous_release_handler)
            signal.signal(signal.SIGUSR2, previous_cancel_handler)
        release.set()
        listener.close()
        os.unlink(path)


def concurrent_proof(directory, cross_runtime=False):
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
            if not byte:
                _, error = process.communicate(timeout=5)
                raise AssertionError(f"Fixture event stream closed: {error}")
            data.extend(byte)
            assert len(data) <= 1024
        return json.loads(data)

    def event(expected):
        value = receive()
        assert value == {"event": expected}, (expected, value)

    def start(mode):
        command = (["node", "/tests/identity/broker-cross-client.ts", path, mode] if cross_runtime
                   else [sys.executable, "-I", "-B", __file__, "client", path, mode])
        child = subprocess.Popen(command,
                                 user=UID, group=GID, extra_groups=[],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        clients.append(child)
        return child

    def done(child, timeout=10):
        _, error = child.communicate(timeout=timeout)
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
        failed = start("failed-source")
        done(failed)
        observed = [receive()["event"] for _ in range(3)]
        assert sorted(observed) == ["admitted", "released", "source-failed"]
        recovered = start("reconnect")
        done(recovered)
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "released"]
        held = start("held-source")
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "source-entered"]
        process.stdin.write("cancel\n")
        process.stdin.flush()
        done(held, timeout=3)
        event("cancelled")
        competitor = start("capacity")
        event("capacity")
        done(competitor)
        process.stdin.write("release\n")
        process.stdin.flush()
        event("released")
        recovered = start("reconnect")
        done(recovered)
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "released"]
        failed = start("failed-generation")
        done(failed)
        observed = [receive()["event"] for _ in range(3)]
        assert sorted(observed) == ["admitted", "released", "source-failed"]
        recovered = start("generation-reconnect")
        done(recovered)
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "released"]
        stalled = start("no-eof")
        event("admitted")
        competitor = start("capacity")
        event("capacity")
        done(competitor)
        event("timeout")
        event("released")
        done(stalled)
        recovered = start("reconnect")
        done(recovered)
        observed = [receive()["event"] for _ in range(2)]
        assert sorted(observed) == ["admitted", "released"]
        process.stdin.write("stop\n")
        process.stdin.flush()
        event("complete")
        _, error = process.communicate(timeout=10)
        assert process.returncode == 0, error
        assert error == "Fixture source unavailable\nFixture generation source unavailable\n", error
        assert not os.path.exists(path)
        print("PASS Python/Linux admission: idle deadline, competitors rejected, timed-out source retains slot until release, reconnect succeeds", flush=True)
        print("PASS Python/Linux source failure: explicit diagnostic, no response frame, slot released and approved reconnect succeeds", flush=True)
        print("PASS Python/Linux generation failure: no missing/success fallback, explicit diagnostic, fresh observed readback succeeds", flush=True)
        print("PASS Python/Linux missing EOF: complete request times out without source entry, excludes competitors, fresh readback succeeds", flush=True)
        print("PASS Python/Linux cancellation: held request closes within three seconds, slot retained until source settles, approved reconnect succeeds", flush=True)
        if cross_runtime:
            print("PASS Node/TypeScript lifecycle clients: idle and source deadlines, capacity retention, source exception and owner cancellation recovery", flush=True)
    finally:
        for child in clients:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
        if process.poll() is None:
            process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    signal.alarm(45)
    if len(sys.argv) == 1:
        proof()
    elif sys.argv[1] == "server":
        server(sys.argv[2])
    elif sys.argv[1] == "client":
        client(sys.argv[2], sys.argv[3])
    elif sys.argv[1] == "concurrent-server":
        concurrent_server(sys.argv[2])
    elif sys.argv[1] == "cross-runtime":
        proof(cross_runtime=True)
    else:
        raise ValueError("Unknown fixture mode")
