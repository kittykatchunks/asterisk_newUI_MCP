"""Bounded rejected-target REFER proof; does not prove an accepted transfer."""

import argparse
import re
import select
import time
import uuid
from pathlib import Path

from sip_rtp_proof import Probe, parse_message, read_password, require


REFER_SUB_CASES = (
    ("absent", (), True),
    ("false", ("false",), False),
    ("uppercase false", ("FALSE",), False),
    ("parameterized false", ("false;foo=bar",), False),
    ("true", ("true",), True),
    ("mixed-case true", ("TrUe",), True),
    ("parameterized true", ("true;foo=bar",), True),
    ("invalid true prefix", ("trueX",), True),
    ("short invalid value", ("tru",), False),
    ("empty value", ("",), False),
    ("duplicate false then true", ("false", "true"), False),
    ("duplicate true then false", ("true", "false"), True),
)

INVALID_TARGET_CASES = (
    ("missing Refer-To", ()),
    ("empty Refer-To", ("",)),
    ("malformed Refer-To", ("<sip:>",)),
    ("telephone scheme", ("<tel:+441234567890>",)),
    ("HTTPS scheme", ("<https://example.invalid/transfer>",)),
)


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

    def verify_sequencing(self, target, extra_headers):
        original_cseq = self.cseq
        original_branch = self.branch
        attempts = (
            ("same branch with higher CSeq", original_cseq + 1, original_branch, 400),
            ("new branch with unchanged CSeq", original_cseq, "z9hG4bK" + uuid.uuid4().hex, 500),
            ("new branch with higher CSeq", original_cseq + 1, "z9hG4bK" + uuid.uuid4().hex, 404),
        )
        for label, cseq, branch, expected in attempts:
            self.cseq = cseq
            self.branch = branch
            request = self.request("REFER", uri=target, extra_headers=extra_headers)
            code, headers, _ = self.exchange(request, "REFER")
            require(code == expected, f"{label}: expected {expected}, received {code}")
            expected_header = ["false"] if code == 404 else None
            require(headers.get("refer-sub") == expected_header,
                    f"{label}: unexpected Refer-Sub response")
            self.observe_notifications(False)
            print(f"PASS REFER sequencing: {label} returned {code}, no NOTIFY")


def run_case(host, password, *, label, values, subscribed, require_option, advertised,
             refer_to=None, check_sequencing=False, transfers_disabled=False,
             valid_target=False, refer_to_name="Refer-To"):
    probe = ReferProbe(host)
    target = None
    try:
        code, headers, _ = probe.invite(password)
        require(code == 200, f"Authenticated INVITE failed: {code}")
        supported = {option.strip().lower()
                     for value in headers.get("supported", [])
                     for option in value.split(",")}
        require(("norefersub" in supported) == advertised,
                f"Unexpected Supported: norefersub advertisement: {supported}")
        probe.to_value = headers["to"][0]
        contact = re.fullmatch(r"<([^>]+)>", headers["contact"][0])
        require(contact is not None, "Unexpected dialog Contact")
        target = contact[1]
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        probe.sip.send(probe.request("ACK", uri=target))
        probe.cseq += 1
        probe.branch = "z9hG4bK" + uuid.uuid4().hex
        targets = (f"<sip:missing-{uuid.uuid4().hex}@{host}>",) if refer_to is None else refer_to
        extra_headers = [f"{refer_to_name}: {value}" for value in targets]
        extra_headers.extend(f"Refer-Sub: {value}" for value in values)
        if require_option:
            extra_headers.append("Require: norefersub")
        request = probe.request("REFER", uri=target, extra_headers=extra_headers)
        code, headers, _ = probe.exchange(request, "REFER")
        if transfers_disabled:
            expected = 603
            expected_header = None
        elif refer_to is None or valid_target:
            expected = 202 if subscribed else 404
            expected_header = (["true"] if values else None) if subscribed else ["false"]
        else:
            expected = 400
            expected_header = None
        require(code == expected, f"{label}: expected REFER {expected}, received {code}")
        require(headers.get("refer-sub") == expected_header,
                f"{label}: unexpected Refer-Sub response header: {headers.get('refer-sub')}")
        repeated, repeated_headers, _ = probe.exchange(request, "REFER")
        require(repeated == code and repeated_headers.get("to") == headers.get("to")
                and repeated_headers.get("refer-sub") == expected_header,
                "Same-key REFER retransmission changed final response")
        probe.observe_notifications(subscribed)
        option = " with Require: norefersub" if require_option else ""
        result = " and terminal NOTIFY 404" if subscribed else " and no NOTIFY"
        setting = "yes" if advertised else "no"
        print(f"PASS norefersub={setting}, {label}{option}: "
              f"REFER {code}, same-key retransmission{result}")
        if check_sequencing:
            probe.verify_sequencing(target, extra_headers)
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
    parser.add_argument("--norefersub", required=True, choices=("yes", "no"))
    parser.add_argument("--transfers-disabled", action="store_true")
    args = parser.parse_args()
    password = read_password(Path("/run/proof/pjsip.conf"))
    if args.transfers_disabled:
        for label, targets in (("unknown target", None), *INVALID_TARGET_CASES):
            for values in ((), ("false",)):
                mode = "absent" if not values else "false"
                run_case(args.host, password, label=f"disabled transfer, {label}, Refer-Sub {mode}",
                         values=values, subscribed=False, require_option=False,
                         advertised=args.norefersub == "yes", refer_to=targets,
                         transfers_disabled=True)
        return
    for require_option in (False, True):
        for label, values, subscribed in REFER_SUB_CASES:
            run_case(args.host, password, label=f"Refer-Sub {label}", values=values, subscribed=subscribed,
                     require_option=require_option, advertised=args.norefersub == "yes")
    for label, targets in INVALID_TARGET_CASES:
        for values in ((), ("false",)):
            mode = "absent" if not values else "false"
            run_case(args.host, password, label=f"{label}, Refer-Sub {mode}",
                     values=values, subscribed=False, require_option=False,
                     advertised=args.norefersub == "yes", refer_to=targets)
    missing = f"missing-{uuid.uuid4().hex}"
    target_forms = (
        ("bare SIP URI", "Refer-To", f"sip:{missing}@{args.host}"),
        ("SIPS URI", "Refer-To", f"<sips:{missing}@{args.host}>"),
        ("compact r header", "r", f"<sip:{missing}@{args.host}>"),
    )
    for label, header_name, uri in target_forms:
        for values in ((), ("false",)):
            mode = "absent" if not values else "false"
            run_case(args.host, password, label=f"{label}, Refer-Sub {mode}",
                     values=values, subscribed=not values, require_option=False,
                     advertised=args.norefersub == "yes", refer_to=(uri,),
                     valid_target=True, refer_to_name=header_name)
    run_case(args.host, password, label="transaction sequencing baseline",
             values=("false",), subscribed=False, require_option=False,
             advertised=args.norefersub == "yes", check_sequencing=True)


if __name__ == "__main__":
    main()
