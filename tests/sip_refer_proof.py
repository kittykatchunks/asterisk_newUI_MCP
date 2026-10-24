"""Bounded rejected-target REFER proof; does not prove an accepted transfer."""

import argparse
import re
import select
import time
import uuid
from pathlib import Path

from sip_rtp_proof import Probe, parse_message, read_password, require


class ReferProbe(Probe):
    def __init__(self, host):
        super().__init__(host)
        self.notifications = {}

    def receive(self):
        start, headers, body = parse_message(self.sip.recv(65535))
        require(headers.get("call-id") == [self.call_id], "Unexpected SIP dialog")
        if start.startswith("SIP/2.0 "):
            return int(start.split()[1]), headers, body
        require(start.startswith("NOTIFY "), f"Unexpected SIP request: {start}")
        require(headers.get("event") == ["refer"], "Unexpected NOTIFY event")
        require(headers.get("content-type") == ["message/sipfrag;version=2.0"],
                "Expected REFER sipfrag content type")
        require(len(headers.get("subscription-state", [])) == 1,
                "Missing or ambiguous subscription state")
        require(re.match(r"^SIP/2.0 \d{3}(?: |\r?$)", body) is not None,
                "Malformed NOTIFY sipfrag")
        response = ["SIP/2.0 200 OK"]
        for name in ("via", "from", "to", "call-id", "cseq"):
            require(name in headers, f"Missing NOTIFY {name}")
            response.extend(f"{name}: {value}" for value in headers[name])
        response += ["Content-Length: 0", "", ""]
        self.sip.send("\r\n".join(response).encode())
        key = tuple(headers["cseq"])
        value = (headers["subscription-state"][0], int(body.split()[1]))
        require(key not in self.notifications or self.notifications[key] == value,
                "Retransmitted NOTIFY changed its result")
        self.notifications[key] = value
        return None

    def exchange(self, request, method):
        deadline = time.monotonic() + 5
        next_send = 0
        while time.monotonic() < deadline:
            now = time.monotonic()
            if now >= next_send:
                self.sip.send(request)
                next_send = now + 0.5
            if not select.select([self.sip], [], [], 0.1)[0]:
                continue
            response = self.receive()
            if response is None:
                continue
            code, headers, body = response
            if headers.get("cseq") == [f"{self.cseq} {method}"] and code >= 200:
                return code, headers, body
        raise RuntimeError(f"Timed out awaiting {method} final response")

    def observe_notifications(self, subscribed):
        deadline = time.monotonic() + (5 if subscribed else 1)
        while time.monotonic() < deadline:
            terminal = [value for value in self.notifications.values()
                        if value[0].split(";", 1)[0] == "terminated"]
            if subscribed and terminal:
                require(terminal == [("terminated;reason=noresource", 404)],
                        f"Unexpected terminal subscription result: {terminal}")
                return
            if select.select([self.sip], [], [], 0.1)[0]:
                self.receive()
            require(subscribed or not self.notifications,
                    "Suppressed subscription emitted NOTIFY")
        require(not subscribed, "Missing terminal failure NOTIFY")


def run_case(host, password, *, subscribed, require_option):
    probe = ReferProbe(host)
    target = None
    try:
        code, headers, _ = probe.invite(password)
        require(code == 200, f"Authenticated INVITE failed: {code}")
        probe.to_value = headers["to"][0]
        contact = re.fullmatch(r"<([^>]+)>", headers["contact"][0])
        require(contact is not None, "Unexpected dialog Contact")
        target = contact[1]
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        probe.sip.send(probe.request("ACK", uri=target))
        probe.cseq += 1
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        extra_headers = [f"Refer-To: <sip:missing-{uuid.uuid4().hex}@{host}>"]
        if not subscribed:
            extra_headers.append("Refer-Sub: false")
        if require_option:
            extra_headers.append("Require: norefersub")
        request = probe.request("REFER", uri=target, extra_headers=extra_headers)
        code, headers, _ = probe.exchange(request, "REFER")
        expected = 202 if subscribed else 404
        require(code == expected, f"Expected REFER {expected}, received {code}")
        require(headers.get("refer-sub") == (None if subscribed else ["false"]),
                "Unexpected Refer-Sub response header")
        repeated, repeated_headers, _ = probe.exchange(request, "REFER")
        require(repeated == code and repeated_headers.get("to") == headers.get("to"),
                "Same-key REFER retransmission changed final response")
        probe.observe_notifications(subscribed)
        mode = "implicit subscription" if subscribed else "Refer-Sub: false"
        option = " with Require: norefersub" if require_option else ""
        result = " and terminal NOTIFY 404" if subscribed else " and no NOTIFY"
        print(f"PASS {mode}{option}: REFER {code}, same-key retransmission{result}")
    finally:
        try:
            if target is not None:
                probe.cseq += 1
                probe.branch = "z9hG4bK" + uuid.uuid4().hex
                code, _, _ = probe.exchange(probe.request("BYE", uri=target), "BYE")
                require(code == 200, f"BYE failed: {code}")
        finally:
            probe.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    args = parser.parse_args()
    password = read_password(Path("/run/proof/pjsip.conf"))
    for require_option in (False, True):
        for subscribed in (False, True):
            run_case(args.host, password, subscribed=subscribed,
                     require_option=require_option)


if __name__ == "__main__":
    main()
