"""Disposable Asterisk lifecycle/connection association, never live provisioning."""

import os
from pathlib import Path
import re
import secrets
import select
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid

sys.path.insert(0, "/broker")
from authority import ObservationAuthority
from evidence import EvidenceBinding
from ledger import LedgerBinding
from readback import Rejected


def live(handle):
    return not select.select([handle], [], [], 0)[0]


def encoded_address(address):
    host, port = address
    return socket.inet_aton(host)[::-1].hex().upper() + f":{port:04X}"


def associated(child, handle, connection):
    if not live(handle):
        return False
    local = encoded_address(connection.getsockname())
    remote = encoded_address(connection.getpeername())
    inodes = []
    with open("/proc/net/tcp", encoding="ascii") as table:
        for row in list(table)[1:]:
            fields = row.split()
            if fields[1:4] == [remote, local, "01"]:
                inodes.append(fields[9])
    if len(inodes) != 1 or inodes[0] == "0":
        return False
    descriptors = []
    for path in Path(f"/proc/{child.pid}/fd").iterdir():
        try:
            descriptors.append(os.readlink(path))
        except FileNotFoundError:
            # A closing descriptor cannot provide ownership evidence.
            continue
    return f"socket:[{inodes[0]}]" in descriptors and live(handle)


class Ami:
    def __init__(self, port):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=2)
        self.buffer = b""

    def action(self, name, **fields):
        if name not in ("Login", "CoreStatus", "Logoff"):
            raise ValueError("Action is outside disposable proof scope")
        deadline = time.monotonic() + 3
        received = 0
        identifier = str(uuid.uuid4())
        message = {"Action": name, "ActionID": identifier, **fields}
        self.socket.sendall(("".join(f"{key}: {value}\r\n" for key, value in message.items())
                             + "\r\n").encode("ascii"))
        while True:
            while b"\r\n\r\n" not in self.buffer:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Synthetic AMI action deadline")
                self.socket.settimeout(remaining)
                data = self.socket.recv(4096)
                if not data:
                    raise RuntimeError("Synthetic AMI closed before response")
                self.buffer += data
                received += len(data)
                if received > 65536:
                    raise RuntimeError("Synthetic AMI response exceeded bound")
            frame, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
            values = {}
            for line in frame.decode("ascii").split("\r\n"):
                if ": " in line:
                    key, value = line.split(": ", 1)
                    if key in values:
                        raise RuntimeError("Duplicate synthetic AMI field")
                    values[key] = value
            if values.get("ActionID") == identifier:
                if values.get("Response") != ("Goodbye" if name == "Logoff" else "Success"):
                    raise RuntimeError("Synthetic AMI action failed")
                return values

    def close(self):
        self.socket.close()


def main():
    signal.alarm(60)
    assert os.getuid() == 1000 and os.getgid() == 999
    with open("/proc/self/status", encoding="ascii") as status:
        assert re.search(r"^CapEff:\s+0+$", status.read(), re.MULTILINE)
    assert hasattr(os, "pidfd_open"), "pidfd support is required; no privilege fallback"
    version = subprocess.run(["/usr/sbin/asterisk", "-V"], capture_output=True, text=True,
                             timeout=3, check=True)
    assert re.fullmatch(r"Asterisk 22\.11\.0\s*", version.stdout), "Expected Asterisk 22.11.0"
    scope = LedgerBinding("customer-proof", str(uuid.uuid4()), "agent")
    generation = str(uuid.uuid4())
    authority = ObservationAuthority()
    cancellation = threading.Event()
    children, connections, handles = [], [], []
    with tempfile.TemporaryDirectory(dir="/proof") as directory:
        root = Path(directory)
        for name in ("etc", "run", "log", "spool", "lib"):
            (root / name).mkdir()
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        secret = secrets.token_hex(32)
        (root / "etc" / "manager.conf").write_text(
            f"[general]\nenabled=yes\nbindaddr=127.0.0.1\nport={port}\ndisplayconnects=no\n"
            f"[enrollment-proof]\nsecret={secret}\nread=none\nwrite=reporting\n", encoding="ascii")
        os.chmod(root / "etc" / "manager.conf", 0o600)
        (root / "etc" / "modules.conf").write_text("[modules]\nautoload=no\n", encoding="ascii")
        (root / "etc" / "logger.conf").write_text("[logfiles]\nconsole=error\n", encoding="ascii")
        config = root / "etc" / "asterisk.conf"
        config.write_text(
            "[directories]\n" +
            "".join(f"{key} => {root / value}\n" for key, value in (
                ("astetcdir", "etc"), ("astvarlibdir", "lib"), ("astdbdir", "lib"),
                ("astkeydir", "lib"), ("astagidir", "lib"),
                ("astspooldir", "spool"), ("astrundir", "run"), ("astlogdir", "log"))) +
            "astdatadir => /var/lib/asterisk\nastmoddir => /usr/lib/asterisk/modules\n[options]\n",
            encoding="ascii")

        def launch():
            with (root / "startup.log").open("wb") as output:
                child = subprocess.Popen(
                    ["/usr/sbin/asterisk", "-f", "-q", "-C", str(config)],
                    stdin=subprocess.DEVNULL, stdout=output, stderr=output)
            children.append(child)
            handle = os.pidfd_open(child.pid)
            handles.append(handle)
            binding = EvidenceBinding(scope, generation, 1, str(uuid.uuid4()))
            authority.start(binding)
            authority.child_started()
            deadline = time.monotonic() + 8
            while True:
                if child.poll() is not None or not live(handle):
                    details = (root / "startup.log").read_text(errors="replace")[-3000:].replace(secret, "[redacted]")
                    raise RuntimeError("Asterisk exited during startup: " + details)
                try:
                    client = Ami(port)
                    break
                except ConnectionRefusedError:
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Asterisk readiness deadline exceeded")
                    time.sleep(0.05)
            connections.append(client)
            assert associated(child, handle, client.socket), "Exact connection is not owned by Asterisk"
            client.action("Login", Username="enrollment-proof", Secret=secret, Events="off")
            assert authority.state() == "association-pending"
            authority.association_verified(binding)
            return child, handle, client, binding

        try:
            child, handle, client, binding = launch()
            collection = authority.begin()
            assert associated(child, handle, client.socket)
            status = client.action("CoreStatus")
            assert associated(child, handle, client.socket)
            assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", status.get("CoreStartupDate", ""))
            assert status.get("CoreCurrentCalls") == "0"
            # CoreStatus is not generation evidence; do not fabricate an observation
            # envelope just to call authority.accept.
            print("PASS exact owned-child AMI association and bounded CoreStatus", flush=True)

            with socket.socket() as other_listener:
                other_listener.bind(("127.0.0.1", 0))
                other_listener.listen()
                with socket.create_connection(other_listener.getsockname()) as other_client:
                    other_server, _ = other_listener.accept()
                    with other_server:
                        assert not associated(child, handle, other_client)
            print("PASS wrong-process established connection rejected", flush=True)

            client.close()
            authority.invalidate()
            with AmiContext(port, connections) as reconnect:
                assert associated(child, handle, reconnect.socket)
                reconnect.action("Login", Username="enrollment-proof", Secret=secret, Events="off")
                authority.start(binding)
                authority.child_started()
                authority.association_verified(binding)
                with_reconnect = authority.begin()
                reconnect.action("CoreStatus")
                assert associated(child, handle, reconnect.socket)
                with_reconnect_value = {**with_reconnect.expected(), "outcome": "unavailable"}
                # Hold a local collection across actual child exit. No claim that
                # the AMI server itself has a blocked in-flight action.
                exited = threading.Event()

                def watch():
                    select.select([handle], [], [])
                    authority.invalidate()
                    exited.set()

                watcher = threading.Thread(target=watch)
                watcher.start()
                started = time.monotonic()
                child.terminate()
                try:
                    assert exited.wait(3), "Owned child exit was not observed"
                    assert time.monotonic() - started < 3
                    assert child.wait(timeout=2) == 0, "Asterisk did not stop cleanly"
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait(timeout=2)
                    watcher.join(3)
                    assert not watcher.is_alive()
                assert not live(handle)
                assert reconnect.socket.recv(1) == b"", "Exited child's AMI connection remained open"
                try:
                    authority.accept(with_reconnect, with_reconnect_value, cancellation)
                except Rejected as error:
                    assert str(error) == "Observation authority changed during collection"
                else:
                    raise AssertionError("Late evidence survived child exit")
            print("PASS reconnect requires reassociation; actual pidfd exit invalidates held collection", flush=True)

            replacement, replacement_handle, replacement_client, replacement_binding = launch()
            assert replacement_binding.runtime_instance != binding.runtime_instance
            assert associated(replacement, replacement_handle, replacement_client.socket)
            replacement_client.action("CoreStatus")
            try:
                authority.accept(collection, {**collection.expected(), "outcome": "unavailable"}, cancellation)
            except Rejected as error:
                assert str(error) == "Observation authority changed during collection"
            else:
                raise AssertionError("Old collection survived replacement")
            replacement_client.action("Logoff")
            replacement_client.close()
            authority.invalidate()
            replacement.terminate()
            assert replacement.wait(timeout=3) == 0
            print("PASS replacement gets fresh runtime identity and exact new connection association", flush=True)
        finally:
            for connection in connections:
                connection.close()
            for child in children:
                if child.poll() is None:
                    child.terminate()
                    try:
                        child.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=2)
                assert child.poll() is not None
            for handle in handles:
                os.close(handle)
    print("PASS owned children reaped and disposable synthetic state removed", flush=True)


class AmiContext:
    def __init__(self, port, connections):
        self.client = Ami(port)
        connections.append(self.client)

    def __enter__(self):
        return self.client

    def __exit__(self, *_):
        self.client.close()


if __name__ == "__main__":
    main()
