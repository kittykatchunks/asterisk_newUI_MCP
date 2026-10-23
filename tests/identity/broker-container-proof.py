"""Separate-container read-only identity experiment, never a production broker."""

import errno
import importlib.util
import json
import os
import signal
import socket
import stat
import struct
import subprocess
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


def server(mode="server"):
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
        try:
            listener.bind(PATH)
        except OSError as error:
            emit({"startupRejected": True, "errno": error.errno})
            raise
        bound = True
        published = os.stat(PATH, follow_symlinks=False)
        assert stat.S_ISSOCK(published.st_mode) and stat.S_IMODE(published.st_mode) == 0o660
        assert (published.st_uid, published.st_gid) == (1101, 2100)
        listener.listen(1)
        listener.settimeout(20)
        emit({"published": {"device": published.st_dev, "inode": published.st_ino}})
        emit({"ready": True})

        def entered():
            nonlocal entries
            entries += 1

        for _ in range(5 if mode == "server" else 1):
            connection, _ = listener.accept()
            with connection:
                peer = struct.unpack("3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                allowed = peer[1:] == (1102, 2100)
                emit({"peer": {"pid": peer[0], "uid": peer[1], "gid": peer[2]}, "allowed": allowed})
                if not allowed:
                    denied += 1
                    continue
                deadline = time.monotonic() + 5
                text = protocol.read_frame(connection, 8192, deadline)
                if mode == "server-crash":
                    emit({"crashingBeforeSource": True, "sourceEntries": entries})
                    os._exit(23)
                response = protocol.readback(text, on_source=entered)
                protocol.remaining(connection, deadline)
                connection.sendall(protocol.frame(json.dumps(response), 32768))
                connection.shutdown(socket.SHUT_WR)
        assert (entries, denied) == ((3, 2) if mode == "server" else (1, 0)), (entries, denied)
        emit({"complete": True, "sourceEntries": entries, "deniedBeforeRead": denied})
    finally:
        listener.close()
        if bound:
            current = os.stat(PATH, follow_symlinks=False)
            assert (current.st_dev, current.st_ino) == (published.st_dev, published.st_ino)
            os.unlink(PATH)


def conflict(mode):
    assert (os.getuid(), os.getgid()) == (1101, 2100)
    target = "/socket/broker/conflict-target"
    content = b"fixture publication sentinel\n"
    if mode == "conflict-file":
        with open(PATH, "xb") as file:
            file.write(content)
    else:
        assert mode == "conflict-symlink"
        with open(target, "xb") as file:
            file.write(content)
        os.symlink(target, PATH)
    original = os.lstat(PATH)
    target_original = os.stat(target) if mode == "conflict-symlink" else original
    try:
        result = subprocess.run([sys.executable, "-I", "-B", __file__, "server"],
                                capture_output=True, text=True, timeout=5)
        events = [json.loads(line) for line in result.stdout.splitlines()]
        assert result.returncode != 0, result.stdout
        assert events[-1] == {"startupRejected": True, "errno": errno.EADDRINUSE}, (events, result.stderr)
        assert not any(event.get("ready") or "peer" in event for event in events)
        assert "Address already in use" in result.stderr, result.stderr
        current = os.lstat(PATH)
        assert (current.st_dev, current.st_ino, current.st_mode, current.st_uid, current.st_gid) == (
            original.st_dev, original.st_ino, original.st_mode, original.st_uid, original.st_gid)
        if mode == "conflict-symlink":
            assert os.readlink(PATH) == target
            target_current = os.stat(target)
            assert (target_current.st_dev, target_current.st_ino, target_current.st_mode,
                    target_current.st_uid, target_current.st_gid) == (
                target_original.st_dev, target_original.st_ino, target_original.st_mode,
                target_original.st_uid, target_original.st_gid)
        with open(target if mode == "conflict-symlink" else PATH, "rb") as file:
            assert file.read() == content
        emit({"conflictPreserved": mode, "startupErrno": errno.EADDRINUSE})
    finally:
        current = os.lstat(PATH)
        assert (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
        os.unlink(PATH)
        if mode == "conflict-symlink":
            current = os.lstat(target)
            assert (current.st_dev, current.st_ino) == (target_original.st_dev, target_original.st_ino)
            os.unlink(target)


def remove_stale():
    assert (os.getuid(), os.getgid()) == (1101, 2100)
    original = os.lstat(PATH)
    assert stat.S_ISSOCK(original.st_mode) and stat.S_IMODE(original.st_mode) == 0o660
    assert (original.st_uid, original.st_gid) == (1101, 2100)
    assert (original.st_dev, original.st_ino) == (int(sys.argv[2]), int(sys.argv[3])), "Stale socket identity mismatch"
    connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    connection.settimeout(2)
    try:
        try:
            connection.connect(PATH)
        except ConnectionRefusedError:
            pass
        else:
            raise AssertionError("Refusing to remove a reachable socket")
    finally:
        connection.close()
    current = os.lstat(PATH)
    assert (current.st_dev, current.st_ino) == (original.st_dev, original.st_ino)
    os.unlink(PATH)
    emit({"staleRemoved": True, "device": original.st_dev, "inode": original.st_ino})


def node_client(index):
    result = subprocess.run(["node", "/tests/identity/broker-cross-client.ts", PATH, index],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout == "" and result.stderr == "", (result.stdout, result.stderr)


def client(mode):
    if mode.startswith("admission-"):
        index = mode.removeprefix("admission-")
        assert index in ("idle", "capacity", "no-eof", "capacity-no-eof", "failed-source", "reconnect",
                         "failed-generation", "generation-reconnect")
        if index == "capacity-no-eof":
            index = "capacity"
        assert (os.getuid(), os.getgid()) == (1102, 2100) and set(os.getgroups()) == {2100}
        if len(sys.argv) == 3:
            assert sys.argv[2] == "node-client"
            node_client(index)
            runtime = "node"
        else:
            assert len(sys.argv) == 2
            protocol.client(PATH, index)
            runtime = "python"
        emit({"lifecycleCase": mode, "clientRuntime": runtime})
        return
    if mode.startswith("corpus-"):
        index = mode.removeprefix("corpus-")
        assert (os.getuid(), os.getgid()) == ((1103, 2100) if index == "foreign" else (1102, 2100))
        assert set(os.getgroups()) == {2100}
        if len(sys.argv) == 3:
            assert sys.argv[2] == "node-client"
            node_client(index)
            runtime = "node"
        else:
            assert len(sys.argv) == 2
            protocol.client(PATH, index)
            runtime = "python"
        emit({"corpusCase": index, "clientRuntime": runtime})
        return
    expected = {
        "foreign": (1103, 2100), "wrong-gid": (1102, 2101),
        "filesystem-denied": (1104, 2101),
        "publish-ro": (1102, 2100), "publish-rw": (1102, 2100),
        "inventory": (1102, 2100), "generation": (1102, 2100), "reconnect": (1102, 2100),
        "crash-wait": (1102, 2100), "stale-refused": (1102, 2100), "restart-read": (1102, 2100),
    }
    assert mode in expected and (os.getuid(), os.getgid()) == expected[mode]
    assert set(os.getgroups()) == ({2100, 2101} if mode == "wrong-gid" else {os.getgid()})
    if len(sys.argv) == 3:
        assert sys.argv[2] == "node-client" and mode in ("crash-wait", "stale-refused", "restart-read")
        node_client(mode)
        emit({"lifecycleCase": mode, "clientRuntime": "node"})
        return
    assert len(sys.argv) == 2
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
        if mode == "stale-refused":
            try:
                connection.connect(PATH)
            except ConnectionRefusedError:
                emit({"staleConnectRefused": True})
                return
            raise AssertionError("Stale socket unexpectedly accepted connection")
        connection.connect(PATH)
        if mode in ("foreign", "wrong-gid"):
            assert connection.recv(1) == b""
            emit({"peerDenied": mode})
            return
        vector = protocol.VECTORS["cases"][1 if mode == "generation" else 0]
        connection.sendall(protocol.frame(vector["text"], 8192))
        if mode != "crash-wait":
            assert not protocol.select.select([connection], [], [], 0.02)[0]
        connection.shutdown(socket.SHUT_WR)
        if mode == "crash-wait":
            assert connection.recv(1) == b""
            emit({"crashClosedWithoutResponse": True})
            return
        assert json.loads(protocol.read_frame(connection, 32768, time.monotonic() + 5)) == vector["expected"]
        emit({"readback": mode})
    finally:
        connection.close()


signal.alarm(180 if sys.argv[1] == "server-corpus" else 60 if sys.argv[1].startswith("server") else 15)
identity()
if sys.argv[1] in ("server-corpus", "server-admission"):
    assert (os.getuid(), os.getgid()) == (1101, 2100) and set(os.getgroups()) <= {2100}
    directory = os.lstat("/socket/broker")
    assert stat.S_ISDIR(directory.st_mode) and stat.S_IMODE(directory.st_mode) == 0o750
    assert (directory.st_uid, directory.st_gid) == (1101, 2100)
    os.umask(0o117)
    if sys.argv[1] == "server-admission":
        protocol.concurrent_server(PATH, require_visible_pid=False, admission_only=True)
    else:
        protocol.server(PATH, require_visible_pid=False)
elif sys.argv[1] in ("server", "server-crash", "server-restarted"):
    server(sys.argv[1])
elif sys.argv[1] == "remove-stale":
    remove_stale()
elif sys.argv[1] in ("conflict-file", "conflict-symlink"):
    conflict(sys.argv[1])
else:
    client(sys.argv[1])
