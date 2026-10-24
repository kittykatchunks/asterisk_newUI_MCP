"""Synthetic outbound PJSIP target for the isolated REFER media proof."""

import re
import select
import socket
import time
import uuid

from sip_rtp_proof import parse_message, require, verify_rtp_echo


class TransferPeer:
    def __init__(self, host, *, busy=False, noanswer=False):
        require(not (busy and noanswer), "Target cannot be both busy and ringing")
        self.server = (socket.gethostbyname(host), 5060)
        self.sip = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sip.connect(self.server)
        self.ip, self.port = self.sip.getsockname()
        self.rtp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.rtp.bind((self.ip, 0))
        self.tag = uuid.uuid4().hex
        self.dialog = None
        self.acked = False
        self.remote_ended = False
        self.busy = busy
        self.noanswer = noanswer
        self.cancelled = False
        self.invite_received_at = None
        self.cancel_received_at = None

    def close(self):
        self.sip.close()
        self.rtp.close()

    def receive(self):
        start, headers, body = parse_message(self.sip.recv(65535))
        if start.startswith("SIP/2.0 "):
            return int(start.split()[1]), headers
        method = start.split()[0]
        require(method in ("INVITE", "ACK", "BYE", "CANCEL"),
                f"Unexpected target request: {start}")
        for name in ("via", "from", "to", "call-id", "cseq"):
            require(len(headers.get(name, [])) == 1, f"Missing/ambiguous target {name}")
        if self.dialog is not None:
            require(headers["call-id"] == self.dialog["call-id"], "Unexpected target dialog")
        if method == "ACK":
            require(self.dialog is not None, "Target ACK before INVITE")
            require(headers["cseq"] == [self.dialog["cseq"][0].replace("INVITE", "ACK")],
                    "Unexpected target ACK CSeq")
            if self.busy or self.noanswer:
                require(headers["via"] == self.dialog["via"],
                        "Non-2xx target ACK did not match INVITE transaction")
            require(not self.noanswer or self.cancelled, "Ringing target ACK before CANCEL")
            self.acked = True
            return None
        if method == "CANCEL":
            require(self.noanswer and self.dialog is not None, "Unexpected target CANCEL")
            require(headers["via"] == self.dialog["via"]
                    and headers["cseq"] == [self.dialog["cseq"][0].replace("INVITE", "CANCEL")],
                    "Target CANCEL does not match INVITE transaction")
            if not self.cancelled:
                self.cancel_received_at = time.monotonic()
            self.cancelled = True
            self.respond("200 OK", headers)
            self.respond("487 Request Terminated", self.dialog)
            return None
        answer = ""
        if method == "INVITE":
            require(self.dialog is None or headers["cseq"] == self.dialog["cseq"],
                    "Unexpected target re-INVITE")
            connection = re.search(r"(?m)^c=IN IP4 ([^\r\n]+)", body)
            media = re.search(r"(?m)^m=audio (\d+) RTP/AVP ([^\r\n]+)", body)
            require(connection and media and "0" in media[2].split(), "Expected target PCMU SDP")
            require(connection[1] == self.server[0], "Unexpected target media host")
            self.rtp.connect((connection[1], int(media[1])))
            if self.dialog is None:
                self.invite_received_at = time.monotonic()
            self.dialog = headers
            answer = (
                f"v=0\r\no=peer 1 1 IN IP4 {self.ip}\r\ns=synthetic\r\n"
                f"c=IN IP4 {self.ip}\r\nt=0 0\r\n"
                f"m=audio {self.rtp.getsockname()[1]} RTP/AVP 0\r\n"
                "a=rtpmap:0 PCMU/8000\r\na=ptime:20\r\na=sendrecv\r\n"
            )
        else:
            self.remote_ended = True
        if method == "INVITE" and (self.busy or self.noanswer):
            answer = ""
        status = "200 OK"
        if method == "INVITE":
            if self.busy:
                status = "486 Busy Here"
            elif self.noanswer:
                status = "487 Request Terminated" if self.cancelled else "180 Ringing"
        self.respond(status, headers, answer)
        return None

    def respond(self, status, headers, answer=""):
        response = [f"SIP/2.0 {status}"]
        for name in ("via", "from", "to", "call-id", "cseq"):
            value = headers[name][0]
            if name == "to" and ";tag=" not in value:
                value += f";tag={self.tag}"
            response.append(f"{name}: {value}")
        if answer:
            response += [f"Contact: <sip:proof-target@{self.ip}:{self.port}>",
                         "Content-Type: application/sdp"]
        response += [f"Content-Length: {len(answer.encode())}", "", answer]
        self.sip.send("\r\n".join(response).encode())

    def run(self):
        deadline = time.monotonic() + (12 if self.noanswer else 8)
        while not self.acked and time.monotonic() < deadline:
            if select.select([self.sip], [], [], 0.05)[0]:
                self.receive()
        require(self.acked, "Target did not receive INVITE and ACK")
        if self.noanswer:
            require(self.cancelled, "No-answer target was not cancelled")
            duration = self.cancel_received_at - self.invite_received_at
            require(4.5 <= duration < 7, f"Target CANCEL outside 4.5-7s window: {duration}")
            print(f"PASS ringing PJSIP target: CANCEL after {duration:.3f}s, "
                  "CANCEL 200, INVITE 487 and matching ACK")
        if self.busy or self.noanswer:
            return 0

        def receive_sip():
            self.receive()
            require(not self.remote_ended, "Target ended before media proof")

        received = verify_rtp_echo(self.sip, self.rtp, self.dialog["call-id"][0], receive_sip)
        contact = re.fullmatch(r"<([^>]+)>", self.dialog.get("contact", [""])[0])
        require(contact is not None, "Missing target remote Contact")
        branch = "z9hG4bK" + uuid.uuid4().hex
        request = "\r\n".join([
            f"BYE {contact[1]} SIP/2.0",
            f"Via: SIP/2.0/UDP {self.ip}:{self.port};branch={branch};rport",
            "Max-Forwards: 10",
            f"From: {self.dialog['to'][0]};tag={self.tag}",
            f"To: {self.dialog['from'][0]}",
            f"Call-ID: {self.dialog['call-id'][0]}",
            "CSeq: 1 BYE", "Content-Length: 0", "", "",
        ]).encode()
        deadline = time.monotonic() + 5
        next_send = 0
        while time.monotonic() < deadline:
            if time.monotonic() >= next_send:
                self.sip.send(request)
                next_send = time.monotonic() + 0.5
            if select.select([self.sip], [], [], 0.05)[0]:
                response = self.receive()
                if response is not None:
                    code, headers = response
                    require(headers.get("call-id") == self.dialog["call-id"],
                            "Unexpected target response dialog")
                    if headers.get("cseq") == ["1 BYE"] and code >= 200:
                        require(code == 200, f"Target BYE failed: {code}")
                        return received
        raise RuntimeError("Timed out awaiting target BYE response")
