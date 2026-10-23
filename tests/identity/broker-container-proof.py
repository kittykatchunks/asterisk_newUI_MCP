"""Separate-container read-only identity experiment, never a production broker."""

import importlib.util
import json
import os
import signal
import socket
import stat
import struct
import sys
import time


spec = importlib.util.spec_from_file_location("conformance", "/fixture.py")
protocol = importlib.util.module_from_spec(spec)
spec.loader.exec_module(protocol)
PATH = "/socket/broker/readback.sock"


def emit(value):
    print(json.dumps(value), flush=True)


def identity():
    protocol.unprivileged()
    result = {"uid": os.getuid(), "gid": os.getgid(), "groups": os.getgroups()}
    for name in ("uid_map", "gid_map"):
        with open(f"/proc/self/{name}", encoding="ascii") as file:
            result[name] = file.read().strip()
    for name in ("pid", "user", "mnt"):
        result[name + "Namespace"] = os.readlink(f"/proc/self/ns/{name}")
    emit({"identity": result})
    for name in ("uid_map", "gid_map"):
        assert result[name].split() == ["0", "0", "4294967295"], "Unsupported remapped user namespace"


def server():
    assert os.getuid() == 1101 and os.getgid() == 2100 and set(os.getgroups()) <= {2100}
    directory = os.stat("/socket/broker", follow_symlinks=False)
    assert stat.S_ISDIR(directory.st_mode) and stat.S_IMODE(directory.st_mode) == 0o750
    assert (directory.st_uid, directory.st_gid) == (1101, 2100)
    os.umask(0o117)
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    bound = False
    entries = 0
    denied = 0
    try:
        # Never remove an existing pathname to make bind succeed.
        listener.bind(PATH)
        bound = True
        published = os.stat(PATH, follow_symlinks=False)
        assert stat.S_ISSOCK(published.st_mode) and stat.S_IMODE(published.st_mode) == 0o660
        assert (published.st_uid, published.st_gid) == (1101, 2100)
        listener.listen(1)
        listener.settimeout(20)
        emit({"ready": True})

        def entered():
            nonlocal entries
            entries += 1

        for _ in range(5):
            connection, _ = listener.accept()
            with connection:
                peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                allowed = peer[1:] == (1102, 2100)
                emit({"peer": {"pid": peer[0], "uid": peer[1], "gid": peer[2]}, "allowed": allowed})
                if not allowed:
                    denied += 1
                    continue
                deadline = time.monotonic() + 5
                response = protocol.readback(protocol.read_frame(connection, 8192, deadline), on_source=entered)
                protocol.remaining(connection, deadline)
                connection.sendall(protocol.frame(json.dumps(response), 32768))
                connection.shutdown(socket.SHUT_WR)
        assert entries == 3 and denied == 2, (entries, denied)
        emit({"complete": True, "sourceEntries": entries, "deniedBeforeRead": denied})
    finally:
        listener.close()
        if bound:
            current = os.stat(PATH, follow_symlinks=False)
            assert (current.st_dev, current.st_ino) == (published.st_dev, published.st_ino)
            os.unlink(PATH)


def client(mode):
    expected = {
        "foreign": (1103, 2100), "wrong-gid": (1102, 2101),
        "filesystem-denied": (1104, 2101),
        "publish-ro": (1102, 2100), "publish-rw": (1102, 2100),
        "inventory": (1102, 2100), "generation": (1102, 2100), "reconnect": (1102, 2100),
    }
    assert mode in expected and (os.getuid(), os.getgid()) == expected[mode]
    assert set(os.getgroups()) == ({2100, 2101} if mode == "wrong-gid" else {os.getgid()})
    if mode in ("publish-ro", "publish-rw"):
        assert (os.getuid(), os.getgid()) == (1102, 2100)
        original = os.stat(PATH, follow_symlinks=False)
        replacement = os.stat("/socket/staging/replacement", follow_symlinks=False)
        assert stat.S_ISREG(replacement.st_mode) and replacement.st_uid == 1102
        for operation in ("create", "unlink", "rename", "replace"):
            try:
                if operation == "create":
                    with open("/socket/broker/worker-file", "x", encoding="ascii"):
                        pass
                elif operation == "unlink":
                    os.unlink(PATH)
                elif operation == "rename":
                    os.rename(PATH, "/socket/broker/moved.sock")
                else:
                    os.replace("/socket/staging/replacement", PATH)
            except OSError as error:
                assert error.errno in ((13,) if mode == "publish-rw" else (13, 30)), (operation, repr(error))
                emit({"operationDenied": operation, "mount": mode, "errno": error.errno})
            else:
                raise AssertionError(f"Worker unexpectedly performed {operation}")
        current = os.stat(PATH, follow_symlinks=False)
        assert (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
        emit({"publicationDenied": mode})
        return
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(8)
    try:
        if mode == "filesystem-denied":
            try:
                connection.connect(PATH)
            except PermissionError:
                emit({"filesystemDenied": True})
                return
            raise AssertionError("Unrelated filesystem identity connected")
        connection.connect(PATH)
        if mode in ("foreign", "wrong-gid"):
            assert connection.recv(1) == b""
            emit({"peerDenied": mode})
            return
        vector = protocol.VECTORS["cases"][1 if mode == "generation" else 0]
        connection.sendall(protocol.frame(vector["text"], 8192))
        assert not protocol.select.select([connection], [], [], 0.02)[0]
        connection.shutdown(socket.SHUT_WR)
        assert json.loads(protocol.read_frame(connection, 32768, time.monotonic() + 5)) == vector["expected"]
        emit({"readback": mode})
    finally:
        connection.close()


signal.alarm(60 if sys.argv[1] == "server" else 15)
identity()
if sys.argv[1] == "server":
    server()
else:
    client(sys.argv[1])
