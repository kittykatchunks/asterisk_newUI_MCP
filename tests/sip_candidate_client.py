"""Single-peer synthetic SIP/RTP client for the explicitly approved image proof."""

import argparse
import json
import re
import secrets
import socket
import sys
import time
import uuid
from pathlib import Path

from sip_rtp_proof import Probe, authorization, require, verify_rtp_echo


PHASES = ("wrong-register", "registered", "wrong-invite", "echo-complete", "unregistered")
QUEUE_PHASES = ("wrong-register", "registered", "wrong-invite",
                "queue-started", "queue-complete", "unregistered")


def write_json(path, value):
    encoded = json.dumps(value, indent=2) + "\n"
    require(len(encoded.encode()) <= 8192, "Client report exceeds 8192 bytes")
    temporary = path.with_suffix(".tmp")
    temporary.write_text(encoded)
    temporary.replace(path)


def contact_expiry(headers):
    contacts = headers.get("contact", [])
    require(len(contacts) == 1, "Expected exactly one registered Contact")
    match = re.search(r";\s*expires=(\d+)(?:[;\s,]|$)", contacts[0], re.I)
    require(match is not None, "Missing registered Contact expiry")
    expiry = int(match[1])
    require(0 < expiry <= 60, "Unexpected registered Contact expiry")
    return expiry


def validate_media(sdp, peer):
    connections = re.findall(r"(?m)^c=IN IP4 ([^\r\n]+)", sdp)
    media = re.findall(r"(?m)^m=audio (\d+) RTP/AVP ([^\r\n]+)", sdp)
    require(connections == [peer] and len(media) == 1, "Unexpected media peer/session")
    port = int(media[0][0])
    require(10000 <= port <= 10100 and media[0][1].split() == ["0"],
            "Unexpected RTP port or codec")
    require(re.search(r"(?mi)^a=rtpmap:0 PCMU/8000\r?$", sdp) is not None,
            "Expected explicit PCMU/8000")
    return port


class RegistrationProbe(Probe):
    def register(self, host, password, expires):
        require(expires in (0, 60), "Unsupported fixture registration lifetime")
        uri = f"sip:{host}"
        to = f"<sip:proof-client@{host}>"

        def exchange(auth=None):
            self.cseq += 1
            self.branch = "z9hG4bK" + uuid.uuid4().hex
            return self.final_response(self.request(
                "REGISTER", uri=uri, to_value=to, auth=auth,
                extra_headers=(f"Expires: {expires}",)), "REGISTER")

        code, headers, _ = exchange()
        require(code == 401, "Unauthenticated REGISTER must receive 401")
        challenges = headers.get("www-authenticate", [])
        require(len(challenges) == 1, "Expected one REGISTER digest challenge")
        auth = authorization(challenges[0], password, uri, "REGISTER")
        return exchange(auth)


def execute(host, control, queue_timeout=False):
    secret_path = control / "secret"
    password = secret_path.read_text()
    require(re.fullmatch(r"[a-f0-9]{64}", password) is not None, "Invalid private credential format")
    report = dict(passed=False, phases=[], registrationPassed=False, mediaPassed=False,
                  queueTimeoutRequested=queue_timeout)
    phases = QUEUE_PHASES if queue_timeout else PHASES
    probe = RegistrationProbe(host)
    if queue_timeout:
        probe.uri = f"sip:queue-timeout@{host}"
        probe.to_value = f"<{probe.uri}>"
    deadline = time.monotonic() + 60
    report.update(clientAddress=probe.ip, clientPort=probe.port, pbxAddress=probe.server[0])

    def checkpoint(phase, **details):
        require(phase == phases[len(report["phases"])], "Unexpected client phase")
        report["phases"].append(dict(phase=phase, **details))
        write_json(control / f"{phase}.json", report)
        until = min(deadline, time.monotonic() + 10)
        while not (control / f"{phase}.ack").exists():
            require(time.monotonic() < until, "Host acknowledgement deadline expired")
            time.sleep(0.05)

    try:
        code, _, _ = probe.register(host, secrets.token_hex(32), 60)
        require(code in (401, 403), "Wrong-secret REGISTER was not explicitly rejected")
        checkpoint("wrong-register", code=code)
        code, headers, _ = probe.register(host, password, 60)
        require(code == 200, "Authenticated REGISTER failed")
        checkpoint("registered", code=code, contactExpirySeconds=contact_expiry(headers))
        wrong = Probe(host)
        if queue_timeout:
            wrong.uri = probe.uri
            wrong.to_value = probe.to_value
        try:
            code, _, _ = wrong.invite(secrets.token_hex(32))
            require(code in (401, 403), "Wrong-secret INVITE was not explicitly rejected")
        finally:
            wrong.close()
        checkpoint("wrong-invite", code=code)
        code, headers, sdp = probe.invite(password)
        require(code == 200, "Authenticated INVITE failed")
        port = validate_media(sdp, probe.server[0])

        def verify(sip, rtp, call_id, receive):
            if queue_timeout:
                checkpoint("queue-started", inviteCode=200, ackSent=True,
                           codec="PCMU/8000", pbxMediaPort=port)
                return None
            report["mediaAttempted"] = True
            write_json(control / "media-started.json", dict(mediaAttempted=True))
            count = verify_rtp_echo(sip, rtp, call_id, receive)
            report["mediaPassed"] = True
            report["rtp"] = dict(sentDistinctFrames=100, echoedDistinctFrames=count,
                                 codec="PCMU/8000", pbxMediaPort=port)
            return count

        probe.echo(headers, sdp, verify)
        checkpoint("queue-complete" if queue_timeout else "echo-complete",
                   inviteCode=200, byeCode=200)
        code, _, _ = probe.register(host, password, 0)
        require(code == 200, "Authenticated unregistration failed")
        checkpoint("unregistered", code=code)
        report["registrationPassed"] = True
        report["passed"] = True
    finally:
        probe.close()
        write_json(control / "client-report.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", required=True)
    parser.add_argument("--control", type=Path, required=True)
    parser.add_argument("--queue-timeout", action="store_true")
    args = parser.parse_args()
    socket.setdefaulttimeout(5)
    write_json(args.control / "python-ready.json", dict(pythonReady=True))
    ready_deadline = time.monotonic() + 60
    while not (args.control / "go").exists():
        if (args.control / "preflight-exit").exists():
            sys.exit(0)
        require(time.monotonic() < ready_deadline, "Network preflight deadline expired")
        time.sleep(0.05)
    execute(args.host, args.control, args.queue_timeout)
