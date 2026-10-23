"""Linux-only, unprivileged socket identity experiment; not the broker service."""

import json
import os
import select
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile


BROKER_UID = 1101
WORKER_UID = 1102
SOCKET_GID = 2100
FOREIGN_GID = 2101
PRINCIPAL = "fixture-worker"


def server(path):
    assert os.getuid() == BROKER_UID and os.getgid() == SOCKET_GID
    assert os.getgroups() == []
    with open("/proc/self/status", encoding="utf8") as status:
        assert "CapEff:\t0000000000000000" in status.read()
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    listener.settimeout(10)
    reads = 0
    denied = 0
    try:
        listener.bind(path)
        os.chmod(path, 0o660)
        listener.listen(1)
        print(json.dumps({"ready": True}), flush=True)
        for _ in range(4):
            connection, _ = listener.accept()
            with connection:
                connection.settimeout(5)
                pid, uid, gid = struct.unpack(
                    "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
                )
                if uid != WORKER_UID or gid != SOCKET_GID or pid <= 0:
                    denied += 1
                    continue
                # This tiny probe is not a duplicate implementation of broker framing.
                data = bytearray()
                while True:
                    chunk = connection.recv(33 - len(data))
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > 32:
                        raise ValueError("Oversized peer probe")
                reads += 1
                assert bytes(data) == b"peer-proof"
                connection.sendall(json.dumps({
                    "principal": PRINCIPAL, "pid": pid, "uid": uid, "gid": gid,
                }).encode("utf8"))
                connection.shutdown(socket.SHUT_WR)
        assert reads == 2 and denied == 2
        print(json.dumps({"reads": reads, "deniedBeforeRead": denied}), flush=True)
    finally:
        listener.close()
        os.unlink(path)


def client(path, expected):
    with open("/proc/self/status", encoding="utf8") as status:
        assert "CapEff:\t0000000000000000" in status.read()
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(5)
    try:
        if expected == "filesystem-denied":
            try:
                connection.connect(path)
            except PermissionError:
                print(json.dumps({"filesystemDenied": True}), flush=True)
                return
            raise AssertionError("Foreign filesystem identity reached the broker socket")
        connection.connect(path)
        if expected == "peer-denied":
            # No request bytes are needed for the server to reject actual peer credentials.
            assert connection.recv(1024) == b""
            print(json.dumps({"peerDenied": True}), flush=True)
            return
        for target in [path, os.path.join(os.path.dirname(path), "replacement.sock")]:
            try:
                if target == path:
                    os.unlink(target)
                else:
                    with open(target, "xb"):
                        pass
            except PermissionError:
                continue
            raise AssertionError("A connecting worker must not replace broker-owned socket entries")
        connection.sendall(b"peer-proof")
        connection.shutdown(socket.SHUT_WR)
        response = bytearray()
        while True:
            chunk = connection.recv(1024)
            if not chunk:
                break
            response.extend(chunk)
            assert len(response) <= 1024
        identity = json.loads(response)
        assert identity == {
            "principal": PRINCIPAL, "pid": os.getpid(), "uid": os.getuid(), "gid": os.getgid(),
        }
        print(json.dumps({"verifiedKernelIdentity": True}), flush=True)
    finally:
        connection.close()


def run_client(path, uid, gid, groups, expected):
    completed = subprocess.run(
        [sys.executable, "-I", "-B", __file__, "client", path, expected],
        user=uid, group=gid, extra_groups=groups, capture_output=True, text=True,
        timeout=10, check=True,
    )
    return json.loads(completed.stdout)


def proof():
    assert sys.platform == "linux" and hasattr(socket, "SO_PEERCRED")
    # Root is used only to establish distinct fixture identities, never by the socket server.
    assert os.getuid() == 0
    os.setgroups([SOCKET_GID])
    with tempfile.TemporaryDirectory(prefix="broker-peer-", dir="/proof") as directory:
        os.chmod(directory, 0o750)
        os.chown(directory, BROKER_UID, SOCKET_GID)
        path = os.path.join(directory, "readback.sock")
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", __file__, "server", path],
            user=BROKER_UID, group=SOCKET_GID, extra_groups=[],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        try:
            assert select.select([process.stdout], [], [], 10)[0], "Peer fixture did not become ready"
            assert json.loads(process.stdout.readline()) == {"ready": True}
            directory_state = os.stat(directory)
            socket_state = os.lstat(path)
            assert stat.S_IMODE(directory_state.st_mode) == 0o750
            assert (directory_state.st_uid, directory_state.st_gid) == (BROKER_UID, SOCKET_GID)
            assert stat.S_ISSOCK(socket_state.st_mode)
            assert stat.S_IMODE(socket_state.st_mode) == 0o660
            assert (socket_state.st_uid, socket_state.st_gid) == (BROKER_UID, SOCKET_GID)
            assert run_client(path, WORKER_UID, SOCKET_GID, [], "allowed") == {"verifiedKernelIdentity": True}
            # Same socket group grants connect permission, not broker principal identity.
            assert run_client(path, 1103, SOCKET_GID, [], "peer-denied") == {"peerDenied": True}
            # Supplementary-group filesystem access must not masquerade as the primary peer GID.
            assert run_client(path, WORKER_UID, FOREIGN_GID, [SOCKET_GID], "peer-denied") == {"peerDenied": True}
            assert run_client(path, 1104, FOREIGN_GID, [], "filesystem-denied") == {"filesystemDenied": True}
            assert run_client(path, WORKER_UID, SOCKET_GID, [], "allowed") == {"verifiedKernelIdentity": True}
            output, error = process.communicate(timeout=10)
            assert process.returncode == 0, error
            assert json.loads(output) == {"reads": 2, "deniedBeforeRead": 2}
            assert not os.path.exists(path)
            print("PASS Linux SO_PEERCRED: exact UID/GID/PID, foreign UID and primary GID denied before read", flush=True)
            print("PASS Linux socket/directory owner and modes: foreign filesystem identity denied; approved peer reconnects", flush=True)
            print("PASS approved worker cannot unlink or replace broker-owned socket entries; server and clients have zero effective capabilities", flush=True)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate(timeout=5)
            os.chown(directory, 0, 0)


signal.alarm(45)
if len(sys.argv) == 1:
    proof()
elif sys.argv[1] == "server":
    server(sys.argv[2])
elif sys.argv[1] == "client":
    client(sys.argv[2], sys.argv[3])
else:
    raise ValueError("Unknown fixture mode")
