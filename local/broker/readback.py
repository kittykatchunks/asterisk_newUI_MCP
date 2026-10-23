"""Linux-only, unprivileged read-only broker. No PBX adapter is installed."""

import json
import logging
import os
import re
import select
import socket
import stat
import struct
import threading
import time
from dataclasses import dataclass
from typing import Protocol


LOG = logging.getLogger("agent.broker")
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
MISSING = object()


class Rejected(ValueError):
    """Invalid peer request or source output."""


class Source(Protocol):
    def inventory(self, cancellation: threading.Event) -> object:
        ...

    def generation(self, generation_id: str, cancellation: threading.Event) -> object:
        """Return MISSING only for an authoritatively missing generation."""
        ...


@dataclass(frozen=True)
class Binding:
    customer: str
    epoch: str
    principal: str
    uid: int
    gid: int

    def __post_init__(self):
        if (not isinstance(self.customer, str) or not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", self.customer)
                or not isinstance(self.epoch, str) or not UUID.fullmatch(self.epoch)
                or not isinstance(self.principal, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", self.principal)
                or type(self.uid) is not int or not 1 <= self.uid <= 4294967294
                or type(self.gid) is not int or not 1 <= self.gid <= 4294967294):
            raise Rejected("Invalid broker binding")


def safe_integer(value, minimum):
    return (type(value) is int or type(value) is float and value.is_integer()) and minimum <= value <= 9007199254740991


def inventory(value):
    if not isinstance(value, list) or len(value) > 100:
        raise Rejected("Invalid expiry inventory")
    result = []
    ids = set()
    for item in value:
        if (not isinstance(item, dict) or set(item) != {"generationId", "notAfter", "draining"}
                or not isinstance(item["generationId"], str) or not UUID.fullmatch(item["generationId"])
                or not safe_integer(item["notAfter"], 1) or type(item["draining"]) is not bool
                or item["generationId"] in ids):
            raise Rejected("Invalid expiry generation")
        ids.add(item["generationId"])
        result.append(dict(item))
    return result


def observation(value):
    if (not isinstance(value, dict) or set(value) != {"newCallsBlocked", "dialogs", "removed"}
            or type(value["newCallsBlocked"]) is not bool or type(value["removed"]) is not bool
            or not (value["dialogs"] == "unknown" or safe_integer(value["dialogs"], 0))):
        raise Rejected("Invalid expiry observation")
    return dict(value)


def reject_constant(_token):
    raise Rejected("Non-standard JSON constant")


def readback(text: str, binding: Binding, source: Source, cancellation: threading.Event):
    if len(text.encode("utf8")) > 8192:
        raise Rejected("Invalid request size")
    request = json.loads(text, parse_int=float, parse_constant=reject_constant)
    if (not isinstance(request, dict) or type(request.get("version")) not in (int, float)
            or request["version"] != 1 or request.get("customer") != binding.customer
            or request.get("epoch") != binding.epoch):
        raise Rejected("Invalid request scope or version")
    base = {"version": 1, "customer": binding.customer, "epoch": binding.epoch}
    action = request.get("action")
    fields = {"version", "customer", "epoch", "action"}
    if action == "inventory" and set(request) == fields:
        if cancellation.is_set():
            raise Rejected("Connection terminated before source entry")
        value = source.inventory(cancellation)
        if cancellation.is_set():
            raise Rejected("Connection terminated during source read")
        response = {**base, "action": action, "generations": inventory(value)}
    elif (action == "generation" and set(request) == fields | {"generationId"}
          and isinstance(request["generationId"], str) and UUID.fullmatch(request["generationId"])):
        if cancellation.is_set():
            raise Rejected("Connection terminated before source entry")
        value = source.generation(request["generationId"], cancellation)
        if cancellation.is_set():
            raise Rejected("Connection terminated during source read")
        response = {**base, "action": action, "generationId": request["generationId"],
                    **({"state": "missing"} if value is MISSING else
                       {"state": "observed", "observation": observation(value)})}
    else:
        raise Rejected("Invalid request fields or action")
    return encode_frame(json.dumps(response, separators=(",", ":"), allow_nan=False), 32768)


def remaining(connection, deadline):
    seconds = deadline - time.monotonic()
    if seconds <= 0:
        raise TimeoutError("Broker connection deadline")
    connection.settimeout(seconds)


def encode_frame(text, maximum):
    data = text.encode("utf8")
    if not 1 <= len(data) <= maximum:
        raise Rejected("Invalid frame size")
    return struct.pack("!I", len(data)) + data


def read_frame(connection, deadline):
    def exact(count):
        data = bytearray()
        while len(data) < count:
            remaining(connection, deadline)
            chunk = connection.recv(count - len(data))
            if not chunk:
                raise Rejected("Truncated frame")
            data.extend(chunk)
        return bytes(data)

    length = struct.unpack("!I", exact(4))[0]
    if not 1 <= length <= 8192:
        raise Rejected("Invalid frame size")
    payload = exact(length)
    remaining(connection, deadline)
    if connection.recv(1):
        raise Rejected("Trailing frame bytes")
    return payload.decode("utf8", errors="strict")


class Broker:
    """One admission owner; a blocked source retains its slot even after stop."""

    def __init__(self, binding: Binding, source: Source):
        if not isinstance(binding, Binding):
            raise Rejected("A validated broker binding is required")
        self.binding = binding
        self.source = source
        self._serving = threading.Lock()

    def serve(self, path: str, stop: threading.Event, ready: threading.Event):
        if os.getuid() == 0 or not hasattr(socket, "SO_PEERCRED") or not hasattr(select, "POLLRDHUP"):
            raise RuntimeError("Broker requires non-root Linux peer credentials and poll")
        if os.getgid() != self.binding.gid:
            raise Rejected("Broker primary GID must match the protected socket group")
        with open("/proc/self/status", encoding="ascii") as status:
            if not re.search(r"^CapEff:\s+0+$", status.read(), re.MULTILINE):
                raise RuntimeError("Broker requires zero effective capabilities")
        for name in ("uid_map", "gid_map"):
            with open(f"/proc/self/{name}", encoding="ascii") as mapping:
                if mapping.read().split() != ["0", "0", "4294967295"]:
                    raise RuntimeError("Broker does not support remapped user namespaces")
        if not os.path.isabs(path) or os.path.realpath(os.path.dirname(path)) != os.path.dirname(path):
            raise Rejected("Broker requires an absolute path in a non-symlink directory")
        directory = os.lstat(os.path.dirname(path))
        if (not stat.S_ISDIR(directory.st_mode) or directory.st_uid != os.getuid()
                or directory.st_gid != self.binding.gid or stat.S_IMODE(directory.st_mode) != 0o750):
            raise Rejected("Broker directory must be owned by broker UID/worker GID with mode 0750")
        if not self._serving.acquire(blocking=False):
            raise RuntimeError("Broker already serving")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        slot = threading.Lock()
        worker = None
        published = None
        try:
            # Refuse conflicting/stale paths; never remove one to make bind succeed.
            listener.bind(path)
            published = os.lstat(path)
            os.chmod(path, 0o660)
            current = os.lstat(path)
            if (current.st_uid, current.st_gid, stat.S_IMODE(current.st_mode)) != (
                    os.getuid(), self.binding.gid, 0o660):
                raise Rejected("Unexpected socket ownership or mode")
            listener.listen(1)
            listener.settimeout(0.1)
            ready.set()
            while not stop.is_set():
                try:
                    connection, _ = listener.accept()
                except socket.timeout:
                    continue
                deadline = time.monotonic() + 5
                if not slot.acquire(blocking=False):
                    connection.close()
                    LOG.warning("Broker connection denied: capacity")
                    continue
                if worker is not None:
                    worker.join()
                worker = threading.Thread(target=self._handle, args=(connection, deadline, stop, slot))
                worker.start()
        finally:
            try:
                listener.close()
                if worker is not None:
                    worker.join()
                if published is not None:
                    current = os.lstat(path)
                    if (current.st_dev, current.st_ino, stat.S_IFMT(current.st_mode)) != (
                            published.st_dev, published.st_ino, stat.S_IFSOCK):
                        raise RuntimeError("Broker socket changed; refusing cleanup")
                    os.unlink(path)
            finally:
                self._serving.release()

    def _handle(self, connection, deadline, stop, slot):
        cancelled = threading.Event()
        settled = threading.Event()
        state_lock = threading.Lock()
        terminal = False
        completed = False
        monitor = None

        def terminate(reason):
            nonlocal terminal
            with state_lock:
                if terminal or completed:
                    return
                terminal = True
                cancelled.set()
                LOG.warning("Broker connection terminated: %s", reason)
                connection.shutdown(socket.SHUT_RDWR)

        def watch():
            try:
                poller = select.poll()
                poller.register(connection.fileno(), select.POLLHUP | select.POLLERR)
                while not settled.is_set():
                    if stop.is_set():
                        terminate("shutdown")
                        return
                    if time.monotonic() >= deadline:
                        terminate("deadline")
                        return
                    for _, mask in poller.poll(25):
                        if mask & (select.POLLHUP | select.POLLERR | select.POLLNVAL):
                            terminate("peer loss")
                            return
            except OSError:
                LOG.error("Broker connection monitor failed")
                cancelled.set()
                connection.close()

        try:
            pid, uid, gid = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if (uid, gid) != (self.binding.uid, self.binding.gid):
                LOG.warning("Broker peer denied: pid=%d uid=%d gid=%d", pid, uid, gid)
                return
            monitor = threading.Thread(target=watch)
            monitor.start()
            text = read_frame(connection, deadline)
            remaining(connection, deadline)
            response = readback(text, self.binding, self.source, cancelled)
            with state_lock:
                if terminal or stop.is_set():
                    return
                remaining(connection, deadline)
            connection.sendall(response)
            with state_lock:
                if not terminal:
                    connection.shutdown(socket.SHUT_WR)
                    completed = True
        except (ValueError, UnicodeError, OSError, RecursionError):
            LOG.warning("Broker read-only connection rejected")
        except Exception:
            # Adapter errors are explicit failures, never authoritative 'missing'.
            LOG.error("Broker read-only source failed")
        finally:
            settled.set()
            if monitor is not None:
                monitor.join()
            connection.close()
            slot.release()
