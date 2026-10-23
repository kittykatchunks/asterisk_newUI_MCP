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


def read_frame(connection, maximum, deadline, on_payload=None, on_bytes=None):
    def exact(count):
        data = bytearray()
        while len(data) < count:
            remaining(connection, deadline)
            chunk = connection.recv(count - len(data))
            if not chunk:
                raise ValueError("Truncated frame")
            if on_bytes is not None:
                on_bytes(len(chunk))
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
                VECTORS["cases"][0] if index in ("reconnect", "held-reconnect", "cancel-reconnect")
                else VECTORS["cases"][int(index)])
            if index in ("held-reconnect", "cancel-reconnect"):
                entry = 6 if index == "held-reconnect" else 8
                vector = {**vector, "expected": {**vector["expected"], "generations": [
                    {**VECTORS["generation"], "notAfter": VECTORS["generation"]["notAfter"] + entry}
                ]}}
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

def concurrent_server(path, require_visible_pid=True, admission_only=False, terminal_race=False,
                      cancellation_first=False, completion_race=None, peer_disconnect=False, slow_response=None):
    unprivileged()
    assert os.getuid() == BROKER_UID
    assert not (admission_only and terminal_race)
    assert not completion_race or (not admission_only and not terminal_race and completion_race in (
        "response-first", "cancel-first", "deadline-first", "completed-deadline"))
    assert not cancellation_first or terminal_race
    assert not peer_disconnect or not (admission_only or terminal_race or completion_race)
    assert not slow_response or (slow_response in ("slow", "nonreading") and
                                not (admission_only or terminal_race or completion_race or peer_disconnect))
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
    if peer_disconnect:
        counts["peerDisconnects"] = 0
    errors = []
    tasks = []
    race_barrier = threading.Barrier(2, timeout=8) if terminal_race else None
    race_attempts = []
    race_tasks = []
    cancellation_observed = threading.Event()
    completion_armed = threading.Event()

    def event(name):
        with output_lock:
            print(json.dumps({"event": name}), flush=True)

    def release_held_source(_signal, _frame):
        if peer_disconnect:
            with lifetime_lock:
                if (counts["reads"] != 1 or counts["capacity"] != 2 or counts["peerDisconnects"] != 1 or
                        counts["timeouts"] != 0 or counts["cancellations"] != 0 or
                        not slot.locked() or release.is_set()):
                    errors.append("Unexpected disconnected-source release signal")
                    return
                release.set()
            return
        if terminal_race:
            if (len(race_attempts) != 2 or counts["reads"] != 1 or counts["capacity"] != 2 or
                    counts["timeouts"] + counts["cancellations"] != 1 or
                    not slot.locked() or release.is_set()):
                errors.append("Unexpected race source-release signal")
            release.set()
            return
        state = (counts["reads"], counts["timeouts"], counts["capacity"], counts["cancellations"])
        if (state not in ((5, 3, 4, 0), (7, 3, 6, 1)) or
                not slot.locked() or release.is_set() or
                (counts["reads"] == 5 and not late_cancel_observed.is_set()) or
                (counts["reads"] == 7 and not repeat_cancel_observed.is_set())):
            errors.append("Unexpected parent source-release signal")
        release.set()

    def cancel_held_source(_signal, _frame):
        if peer_disconnect:
            errors.append("Unexpected cancellation signal in peer-disconnect proof")
            return
        if completion_race:
            with lifetime_lock:
                if (counts["reads"] != 1 or counts["capacity"] != 1 or
                        completion_armed.is_set() or "completion" not in active):
                    errors.append("Unexpected completion-race signal")
                    return
                completion_armed.set()
                if completion_race in ("response-first", "cancel-first"):
                    task = threading.Thread(target=active["completion"], args=("cancelled",))
                    race_tasks.append(task)
                    task.start()
            return
        if terminal_race:
            with lifetime_lock:
                if (counts["reads"] != 1 or counts["capacity"] != 1 or race_tasks or
                        not slot.locked() or release.is_set() or "race" not in active):
                    errors.append("Unexpected race cancellation signal")
                    return
                task = threading.Thread(target=active["race"], args=("cancelled",))
                race_tasks.append(task)
                task.start()
            return
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
        completed = threading.Event()
        request_complete = threading.Event()
        body_received = threading.Event()
        before = counts["reads"]
        response_attempts = 0
        result_discarded = False
        response = None
        completion_barrier = threading.Barrier(2, timeout=8) if completion_race else None
        response_decided = threading.Event()
        terminal_decided = threading.Event()
        completion_done = threading.Event()
        completion_attempts = []
        peer_watch_stop = threading.Event()
        peer_watch = None
        write_evidence = None

        def received(payload):
            vector = VECTORS["cases"][0]
            expected = vector["text"].encode("utf8")
            assert payload in (expected, expected.ljust(vector["padBytes"], b" "),
                               VECTORS["cases"][1]["text"].encode("utf8"))
            body_received.set()
            event("request-body-received")

        def source(default):
            nonlocal peer_watch
            with lifetime_lock:
                if expired.is_set():
                    raise TimeoutError("Fixture source after terminal connection")
                remaining(connection, deadline)
                counts["reads"] += 1
                if not isinstance(default, list):
                    counts["generationReads"] += 1
            if peer_disconnect:
                assert isinstance(default, list) and len(default) == 1
                if counts["reads"] == 1:
                    release.clear()
                    peer_watch = threading.Thread(target=watch_peer)
                    peer_watch.start()
                    event("source-entered")
                    if not release.wait(15):
                        errors.append("Disconnected source was not released by parent")
                        raise TimeoutError("Fixture disconnected source was not released")
                    assert expired.is_set() and slot.locked() and counts["peerDisconnects"] == 1
                    event("source-settled")
                return [{**default[0], "notAfter": default[0]["notAfter"] + counts["reads"]}]
            if terminal_race or completion_race or slow_response:
                assert isinstance(default, list) and len(default) == 1
                if terminal_race and counts["reads"] == 1:
                    release.clear()
                    event("source-entered")
                    if not release.wait(15):
                        errors.append("Race source was not released by parent")
                        raise TimeoutError("Fixture race source was not released")
                    assert expired.is_set() and slot.locked() and len(race_attempts) == 2
                    event("source-settled")
                return [{**default[0], "notAfter": default[0]["notAfter"] + counts["reads"]}]
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
                if counts["reads"] >= 5:
                    assert isinstance(default, list) and len(default) == 1
                    return [{**default[0], "notAfter": default[0]["notAfter"] + counts["reads"]}]
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
                    return False
                if completed.is_set():
                    return False
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
                    return False
                expired.set()
                count = {"timeout": "timeouts", "cancelled": "cancellations", "disconnected": "peerDisconnects"}[reason]
                counts[count] += 1
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
                return True

        def watch_peer():
            try:
                poller = select.poll()
                descriptor = connection.fileno()
                poller.register(descriptor, select.POLLRDHUP | select.POLLHUP | select.POLLERR)
                half_closed = False
                while not peer_watch_stop.is_set():
                    events = poller.poll(50)
                    with lifetime_lock:
                        if expired.is_set():
                            return
                        for fd, mask in events:
                            assert fd == descriptor
                            assert not mask & (select.POLLERR | select.POLLNVAL), mask
                            if mask & select.POLLHUP:
                                assert half_closed, "Peer disappeared before half-close observation"
                                assert terminate("disconnected")
                                with output_lock:
                                    print(json.dumps({"peerDisconnected": {
                                        "mask": mask, "sourceEntries": counts["reads"],
                                        "responseAttempts": response_attempts, "slotLocked": slot.locked(),
                                        "peerDisconnects": counts["peerDisconnects"],
                                        "timeouts": counts["timeouts"], "cancellations": counts["cancellations"],
                                        "elapsedSeconds": time.monotonic() - (deadline - 5),
                                    }}), flush=True)
                                event("peer-disconnect-observed")
                                return
                            if mask & select.POLLRDHUP:
                                assert request_complete.is_set() and not half_closed and slot.locked()
                                half_closed = True
                                with output_lock:
                                    print(json.dumps({"peerHalfClosed": {
                                        "mask": mask, "sourceEntries": counts["reads"],
                                        "responseAttempts": response_attempts, "slotLocked": slot.locked(),
                                        "terminal": expired.is_set(), "peerDisconnects": counts["peerDisconnects"],
                                        "timeouts": counts["timeouts"], "cancellations": counts["cancellations"],
                                    }}), flush=True)
                                event("peer-half-close-observed")
                                poller.modify(descriptor, select.POLLHUP | select.POLLERR)
            except (AssertionError, OSError) as error:
                errors.append(repr(error))

        def race_terminate(reason):
            try:
                race_barrier.wait()
                if cancellation_first and reason == "timeout":
                    assert cancellation_observed.wait(3), "Cancellation contender did not finish"
                won = terminate(reason)
                with lifetime_lock:
                    assert expired.is_set() and slot.locked() and counts["reads"] == 1
                    observation = {"reason": reason, "won": won, "sourceEntries": counts["reads"],
                                   "timeouts": counts["timeouts"], "cancellations": counts["cancellations"],
                                   "responseAttempts": response_attempts, "slotLocked": slot.locked(),
                                   "elapsedSeconds": time.monotonic() - (deadline - 5)}
                    race_attempts.append(observation)
                    with output_lock:
                        print(json.dumps({"terminalRace": observation}), flush=True)
                    if len(race_attempts) == 2:
                        event("race-settled")
                if reason == "cancelled":
                    cancellation_observed.set()
            except (threading.BrokenBarrierError, AssertionError, OSError) as error:
                errors.append(repr(error))

        def complete_response():
            nonlocal response_attempts, write_evidence
            with lifetime_lock:
                if expired.is_set():
                    return False
                remaining(connection, deadline)
                response_attempts += 1
                if slow_response and before == 0:
                    data = frame(json.dumps(response).ljust(32768, " "), 32768)
                    connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1024)
                    send_buffer = connection.getsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF)
                    assert send_buffer < len(data), send_buffer
                    connection.setblocking(False)
                    sent = 0
                    while sent < len(data):
                        try:
                            count = connection.send(data[sent:])
                            assert count > 0
                            sent += count
                        except BlockingIOError:
                            break
                    assert 0 < sent < len(data), "Writer never experienced actual backpressure"
                    write_evidence = {"frameBytes": len(data), "initialBytes": sent, "sendBuffer": send_buffer,
                                      "completed": False, "timedOut": False}
                    with output_lock:
                        print(json.dumps({"writeBackpressure": dict(write_evidence)}), flush=True)
                    event("write-backpressure")
                    remaining(connection, deadline)
                    try:
                        connection.sendall(data[sent:])
                    except TimeoutError:
                        write_evidence["timedOut"] = True
                        raise
                    write_evidence["completed"] = True
                else:
                    connection.sendall(frame(json.dumps(response), 32768))
                connection.shutdown(socket.SHUT_WR)
                completed.set()
                return True

        def completion_record(reason, won):
            with lifetime_lock:
                completion_attempts.append({"reason": reason, "won": won,
                                            "elapsedSeconds": time.monotonic() - (deadline - 5)})
                if len(completion_attempts) == 2:
                    with output_lock:
                        print(json.dumps({"completionRace": {
                            "schedule": completion_race, "attempts": completion_attempts,
                            "sourceEntries": counts["reads"], "responseAttempts": response_attempts,
                            "timeouts": counts["timeouts"], "cancellations": counts["cancellations"],
                            "completed": completed.is_set(), "terminal": expired.is_set(),
                            "slotLocked": slot.locked(), "elapsedSeconds": time.monotonic() - (deadline - 5),
                        }}), flush=True)
                    event("completion-race-settled")
                    completion_done.set()

        def completion_terminate(reason):
            try:
                if completion_race != "completed-deadline":
                    completion_barrier.wait()
                if completion_race in ("response-first", "completed-deadline"):
                    assert response_decided.wait(3), "Response contender did not finish"
                won = terminate(reason)
                completion_record(reason, won)
                terminal_decided.set()
            except (threading.BrokenBarrierError, AssertionError, OSError) as error:
                errors.append(repr(error))

        deadline = time.monotonic() + 5
        timer_callback = terminate
        if before == 0:
            if terminal_race:
                timer_callback = race_terminate
            elif completion_race in ("deadline-first", "completed-deadline"):
                timer_callback = completion_terminate
        timer = threading.Timer(max(0, deadline - time.monotonic()),
                                timer_callback, args=("timeout",))
        try:
            with lifetime_lock:
                active["cancel"] = terminate
                if terminal_race and before == 0:
                    active["race"] = race_terminate
                if completion_race and before == 0:
                    active["completion"] = completion_terminate
            timer.start()
            text = read_frame(connection, 8192, deadline, received if admission_only else None)
            with lifetime_lock:
                if expired.is_set():
                    return
                remaining(connection, deadline)
                request_complete.set()
            response = readback(text, source)
            if completion_race and before == 0:
                event("response-ready")
                assert completion_armed.wait(8), "Parent did not arm completion race"
                if completion_race != "completed-deadline":
                    completion_barrier.wait()
                if completion_race in ("cancel-first", "deadline-first"):
                    assert terminal_decided.wait(3), "Terminal contender did not finish"
                delivered = complete_response()
                completion_record("response", delivered)
                response_decided.set()
                assert completion_done.wait(8), "Completion contenders did not finish"
                expected_delivery = completion_race in ("response-first", "completed-deadline")
                assert delivered == expected_delivery
                assert len(completion_attempts) == 2 and sum(attempt["won"] for attempt in completion_attempts) == 1
                assert completed.is_set() == expected_delivery and expired.is_set() != expected_delivery
                result_discarded = not delivered
            else:
                delivered = complete_response()
                result_discarded = not delivered
            if delivered:
                if admission_only and counts["reads"] == 8:
                    stop.set()
                if (terminal_race or completion_race or peer_disconnect or slow_response) and counts["reads"] == 2:
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
            if slow_response:
                result_discarded = True
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
            peer_watch_stop.set()
            if peer_watch is not None:
                peer_watch.join(2)
                assert not peer_watch.is_alive()
            connection.close()
            if slow_response and before == 0:
                assert write_evidence is not None
                assert write_evidence["completed"] == (slow_response == "slow")
                assert write_evidence["timedOut"] == (slow_response == "nonreading")
                with output_lock:
                    print(json.dumps({"writeOutcome": {**write_evidence,
                        "elapsedSeconds": time.monotonic() - (deadline - 5),
                        "terminal": expired.is_set(), "slotLocked": slot.locked(),
                    }}), flush=True)
            if admission_only or terminal_race or completion_race or peer_disconnect or slow_response:
                with output_lock:
                    print(json.dumps({"delivery": {
                        "sourceEntries": counts["reads"], "responseAttempts": response_attempts,
                        "resultDiscarded": result_discarded, "terminal": expired.is_set(),
                        "slotLocked": slot.locked(),
                        "inventoryNotAfter": (response["generations"][0]["notAfter"]
                                              if response is not None and response["action"] == "inventory" else None),
                    }}), flush=True)
            slot.release()
            event("released")

    try:
        if admission_only or terminal_race or completion_race or peer_disconnect:
            previous_release_handler = signal.signal(signal.SIGUSR1, release_held_source)
            previous_cancel_handler = signal.signal(signal.SIGUSR2, cancel_held_source)
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        listener.settimeout(0.1)
        if not admission_only and not terminal_race and not completion_race and not peer_disconnect and not slow_response:
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
        for task in race_tasks:
            task.join(4)
            assert not task.is_alive()
        assert not errors, errors
        if slow_response:
            assert counts == {"reads": 2, "generationReads": 0, "capacity": 1,
                              "timeouts": int(slow_response == "nonreading"), "requestTimeouts": 0,
                              "sourceFailures": 0, "cancellations": 0}, counts
            event("complete")
            return
        if peer_disconnect:
            assert counts == {"reads": 2, "generationReads": 0, "capacity": 2, "timeouts": 0,
                              "requestTimeouts": 0, "sourceFailures": 0, "cancellations": 0,
                              "peerDisconnects": 1}, counts
            with output_lock:
                print(json.dumps({"peerDisconnectCounts": counts}), flush=True)
            event("complete")
            return
        if completion_race:
            expected_timeouts = int(completion_race == "deadline-first")
            expected_cancellations = int(completion_race == "cancel-first")
            assert counts == {"reads": 2, "generationReads": 0, "capacity": 1,
                              "timeouts": expected_timeouts, "requestTimeouts": 0,
                              "sourceFailures": 0, "cancellations": expected_cancellations}, counts
            event("complete")
            return
        if terminal_race:
            assert len(race_attempts) == 2
            assert {attempt["reason"] for attempt in race_attempts} == {"timeout", "cancelled"}
            assert sum(attempt["won"] for attempt in race_attempts) == 1
            assert race_attempts[0]["timeouts"] == race_attempts[1]["timeouts"] == counts["timeouts"]
            assert race_attempts[0]["cancellations"] == race_attempts[1]["cancellations"] == counts["cancellations"]
            winner = next(attempt for attempt in race_attempts if attempt["won"])
            assert counts["timeouts"] == int(winner["reason"] == "timeout")
            assert not cancellation_first or winner["reason"] == "cancelled"
            assert counts["timeouts"] + counts["cancellations"] == 1
            expected = {"reads": 2, "generationReads": 0, "capacity": 2,
                        "timeouts": counts["timeouts"], "requestTimeouts": 0,
                        "sourceFailures": 0, "cancellations": counts["cancellations"]}
            assert counts == expected, counts
            with output_lock:
                print(json.dumps({"raceCounts": counts}), flush=True)
            event("complete")
            return
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
        if admission_only or terminal_race or completion_race or peer_disconnect:
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
