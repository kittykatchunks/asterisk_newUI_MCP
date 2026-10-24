"""Synthetic outbound PJSIP target for the isolated REFER media proof."""

import re
import select
import socket
import time
import uuid

from sip_rtp_proof import parse_message, require, verify_rtp_echo


class TransferPeer:
    def __init__(self, host, *, busy=False, noanswer=False, lose_first_final=False,
                 lose_cancel_responses=False, lose_cancel_ok=False, lose_invite_487=False,
                 lose_busy_ack=False):
        require(not (busy and noanswer), "Target cannot be both busy and ringing")
        require(not (noanswer and lose_first_final),
                "Final-response loss is limited to answered and busy targets")
        require(not (lose_cancel_responses or lose_cancel_ok or lose_invite_487) or noanswer,
                "CANCEL response loss needs a ringing target")
        require(sum((lose_cancel_responses, lose_cancel_ok, lose_invite_487)) <= 1,
                "Select only one CANCEL response-loss mode")
        require(not lose_busy_ack or (busy and not lose_first_final),
                "Busy ACK loss needs a busy target without final-response loss")
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
        self.lose_first_final = lose_first_final
        self.discarded_final = None
        self.original_invite = None
        self.invite_receipts = []
        self.lose_cancel_responses = lose_cancel_responses
        self.original_cancel = None
        self.cancel_receipts = []
        self.lose_cancel_ok = lose_cancel_ok
        self.ack_received_at = None
        self.lose_invite_487 = lose_invite_487
        self.discarded_487 = None
        self.next_487 = None
        self.retry_487_interval = 0.5
        self.sent_487_at = None
        self.lose_busy_ack = lose_busy_ack
        self.discarded_ack = None
        self.busy_response = None
        self.next_busy_response = None
        self.busy_retry_interval = 0.5
        self.busy_response_retried_at = None
        self.discarded_ack_at = None

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
            require(not self.lose_cancel_responses or len(self.cancel_receipts) >= 2,
                    "Target ACK before recovery from withheld CANCEL responses")
            require(not self.lose_invite_487 or self.sent_487_at is not None,
                    "Target ACK before withheld INVITE 487 was retransmitted")
            if self.lose_busy_ack:
                message = (start, headers, body)
                if self.discarded_ack is None:
                    self.discarded_ack = message
                    self.discarded_ack_at = time.monotonic()
                    return None
                require(self.busy_response_retried_at is not None,
                        "Repeated busy ACK before 486 retransmission")
                require(message == self.discarded_ack,
                        "Repeated busy ACK changed request line, headers, or body")
            self.acked = True
            if self.ack_received_at is None:
                self.ack_received_at = time.monotonic()
            return None
        if method == "CANCEL":
            require(self.noanswer and self.dialog is not None, "Unexpected target CANCEL")
            require(headers["via"] == self.dialog["via"]
                    and headers["cseq"] == [self.dialog["cseq"][0].replace("INVITE", "CANCEL")],
                    "Target CANCEL does not match INVITE transaction")
            if not self.cancelled:
                self.cancel_received_at = time.monotonic()
            self.cancelled = True
            self.cancel_receipts.append(time.monotonic())
            if self.lose_cancel_responses or self.lose_cancel_ok:
                message = (start, headers, body)
                if self.original_cancel is None:
                    self.original_cancel = message
                    if self.lose_cancel_ok:
                        self.respond("487 Request Terminated", self.dialog)
                    return None
                require(message == self.original_cancel,
                        "Retried target CANCEL changed request line, headers, or body")
            self.respond("200 OK", headers)
            if not self.lose_cancel_ok:
                self.respond("487 Request Terminated", self.dialog)
            return None
        answer = ""
        if method == "INVITE":
            require(self.dialog is None or headers["cseq"] == self.dialog["cseq"],
                    "Unexpected target re-INVITE")
            message = (start, headers, body)
            if self.original_invite is None:
                self.original_invite = message
            elif self.lose_first_final:
                require(message == self.original_invite,
                        "Retried target INVITE changed request line, headers, or body")
            self.invite_receipts.append(time.monotonic())
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
        packet = "\r\n".join(response).encode()
        if self.lose_busy_ack and status == "486 Busy Here":
            if self.busy_response is None:
                self.busy_response = packet
                self.next_busy_response = time.monotonic() + self.busy_retry_interval
            else:
                require(packet == self.busy_response, "Retransmitted 486 changed bytes")
                if self.busy_response_retried_at is None:
                    self.busy_response_retried_at = time.monotonic()
        if self.lose_invite_487 and status == "487 Request Terminated":
            if self.discarded_487 is None:
                self.discarded_487 = packet
                self.next_487 = time.monotonic() + self.retry_487_interval
                return
            require(packet == self.discarded_487, "Retransmitted INVITE 487 changed bytes")
            if self.sent_487_at is None:
                self.sent_487_at = time.monotonic()
        if self.lose_first_final and headers["cseq"][0].endswith(" INVITE") \
                and int(status.split()[0]) >= 200:
            if self.discarded_final is None:
                self.discarded_final = packet
                return
            require(packet == self.discarded_final,
                    "Retried target INVITE produced a different final response")
        self.sip.send(packet)

    def run(self):
        deadline = time.monotonic() + (12 if self.noanswer else 8)
        while (not self.acked or (self.lose_cancel_ok and len(self.cancel_receipts) < 2)) \
                and time.monotonic() < deadline:
            if self.next_busy_response is not None \
                    and time.monotonic() >= self.next_busy_response:
                self.respond("486 Busy Here", self.dialog)
                self.busy_retry_interval = min(self.busy_retry_interval * 2, 4)
                self.next_busy_response = time.monotonic() + self.busy_retry_interval
            if self.next_487 is not None and time.monotonic() >= self.next_487:
                self.respond("487 Request Terminated", self.dialog)
                self.retry_487_interval = min(self.retry_487_interval * 2, 4)
                self.next_487 = time.monotonic() + self.retry_487_interval
            if select.select([self.sip], [], [], 0.05)[0]:
                self.receive()
        require(self.acked, "Target did not receive INVITE and ACK")
        if self.lose_busy_ack:
            require(self.discarded_ack is not None and self.busy_response_retried_at is not None,
                    "Missing discarded ACK or retransmitted 486")
            delay = self.ack_received_at - self.discarded_ack_at
            require(0 < delay < 2, f"Busy ACK recovery outside two seconds: {delay}")
            require(len(self.invite_receipts) == 1, "Busy ACK recovery created another INVITE")
            print(f"PASS discarded busy ACK: identical 486 retransmitted, "
                  f"identical ACK recovered after {delay:.3f}s, one INVITE")
        if self.lose_first_final:
            require(self.discarded_final is not None and len(self.invite_receipts) >= 2,
                    "Missing discarded target final response or retried INVITE")
            delay = self.invite_receipts[1] - self.invite_receipts[0]
            require(0 < delay < 2, f"Target INVITE retry outside two seconds: {delay}")
            print(f"PASS discarded target INVITE final response: "
                  f"{len(self.invite_receipts)} identical INVITEs, first retry at {delay:.3f}s, "
                  "identical final response sent and ACK received")
        if self.noanswer:
            require(self.cancelled, "No-answer target was not cancelled")
            duration = self.cancel_received_at - self.invite_received_at
            require(4.5 <= duration < 7, f"Target CANCEL outside 4.5-7s window: {duration}")
            print(f"PASS ringing PJSIP target: CANCEL after {duration:.3f}s, "
                  "CANCEL 200, INVITE 487 and matching ACK")
            if self.lose_cancel_responses or self.lose_cancel_ok:
                require(len(self.cancel_receipts) >= 2, "Missing retried CANCEL")
                delay = self.cancel_receipts[1] - self.cancel_receipts[0]
                require(0 < delay < 2, f"Target CANCEL retry outside two seconds: {delay}")
                print(f"PASS withheld first CANCEL responses: "
                      f"{len(self.cancel_receipts)} identical CANCELs, first retry at {delay:.3f}s, "
                      "CANCEL 200 and INVITE 487 sent, matching ACK received")
                if self.lose_cancel_ok:
                    require(self.ack_received_at < self.cancel_receipts[1],
                            "INVITE ACK did not precede CANCEL retry")
                    print("PASS isolated CANCEL 200 loss: INVITE 487 ACK received before "
                          "identical CANCEL retry; retried CANCEL answered 200")
            if self.lose_invite_487:
                require(self.discarded_487 is not None and self.sent_487_at is not None,
                        "Missing suppressed or retransmitted INVITE 487")
                delay = self.sent_487_at - self.cancel_received_at
                require(0.45 <= delay < 2, f"INVITE 487 retry outside 0.45-2s window: {delay}")
                quiet_deadline = time.monotonic() + 1
                while time.monotonic() < quiet_deadline:
                    if select.select([self.sip], [], [], 0.05)[0]:
                        self.receive()
                require(len(self.cancel_receipts) == 1, "CANCEL retried despite receiving its 200")
                print(f"PASS isolated INVITE 487 loss: CANCEL answered 200 once, "
                      f"identical 487 retransmitted at {delay:.3f}s and ACKed; "
                      "no CANCEL retry through 1s after ACK")
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
