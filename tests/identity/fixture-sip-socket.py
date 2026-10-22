import base64
import json
import os
import selectors
import socket
import sys


udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(("127.0.0.1", 0))
selector = selectors.DefaultSelector()
selector.register(udp, selectors.EVENT_READ)
selector.register(sys.stdin, selectors.EVENT_READ)
print(json.dumps({"ready": udp.getsockname()[1]}), flush=True)
pending = b""
try:
    while True:
        events = selector.select(timeout=60)
        if not events:
            raise TimeoutError("Owned SIP fixture bridge was idle for sixty seconds")
        for key, _ in events:
            if key.fileobj is sys.stdin:
                chunk = os.read(sys.stdin.fileno(), 65536)
                if not chunk:
                    sys.exit(0)
                pending += chunk
                if len(pending) > 100000:
                    raise ValueError("Oversized fixture bridge command")
                while b"\n" in pending:
                    line, pending = pending.split(b"\n", 1)
                    command = json.loads(line)
                    if command["host"] != "127.0.0.1" or command["port"] != 5060:
                        raise ValueError("Fixture bridge only permits its local PBX")
                    udp.sendto(base64.b64decode(command["packet"], validate=True), ("127.0.0.1", 5060))
            else:
                packet, remote = udp.recvfrom(65536)
                if remote != ("127.0.0.1", 5060):
                    raise ValueError("Unexpected SIP sender in owned fixture")
                print(json.dumps({"packet": base64.b64encode(packet).decode("ascii"),
                                  "address": remote[0], "port": remote[1]}), flush=True)
finally:
    selector.close()
    udp.close()
