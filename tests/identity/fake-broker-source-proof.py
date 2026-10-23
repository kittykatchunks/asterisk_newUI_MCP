"""Cross-runtime driver: exercise the actual readback with the fake DB reader."""

import importlib.util
import json
from pathlib import Path
import sqlite3
import struct
import sys
import threading

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
import readback as broker

spec = importlib.util.spec_from_file_location("fake_source", Path(__file__).with_name("fake-broker-source.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

path, customer, epoch, generation_id, mode = sys.argv[1:]
binding = broker.Binding(customer, epoch, "journal-worker", 1102, 2100)
source = module.FakeRuntimeSource(path, binding)
cancellation = threading.Event()
if mode == "listener":
    listener_spec = importlib.util.spec_from_file_location(
        "listener_proof", Path(__file__).with_name("fake-broker-listener-proof.py"))
    listener = importlib.util.module_from_spec(listener_spec)
    listener_spec.loader.exec_module(listener)
    print(json.dumps(listener.prove(broker, module.FakeRuntimeSource, path, binding, generation_id)))
elif mode == "readonly":
    with source._snapshot(cancellation) as connection:
        try:
            connection.execute("DELETE FROM fake_binding")
        except sqlite3.OperationalError as error:
            assert error.sqlite_errorcode == sqlite3.SQLITE_READONLY
        else:
            raise AssertionError("Read-only connection allowed a write")
    print(json.dumps({"readonly": True}))
elif mode == "cancel":
    cancellation.set()
    try:
        source.inventory(cancellation)
    except InterruptedError:
        print(json.dumps({"cancelled": True}))
    else:
        raise AssertionError("Cancelled source read succeeded")
else:
    request = {"version": 1, "customer": customer, "epoch": epoch, "action": mode}
    if mode == "generation":
        request["generationId"] = generation_id
    frame = broker.readback(json.dumps(request), binding, source, cancellation)
    assert struct.unpack("!I", frame[:4])[0] == len(frame) - 4
    print(frame[4:].decode("utf8"))
