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
                 lose_target_ack=0, lose_bye_response=False, channels_ended=None):
        require(isinstance(lose_target_ack, int) and 0 <= lose_target_ack <= 2,
                "Target ACK loss count must be zero, one, or two")
        require(not (busy and noanswer), "Target cannot be both busy and ringing")
        require(not lose_bye_response or (not busy and not noanswer),
                "BYE response loss needs an answered target")
        require(not lose_bye_response or channels_ended is not None,
                "BYE response loss needs correlated channel-end synchronization")
        self.lose_bye_response = lose_bye_response
        self.channels_ended = channels_ended
        require(not (noanswer and lose_first_final),
                "Final-response loss is limited to answered and busy targets")
        require(not (lose_cancel_responses or lose_cancel_ok or lose_invite_487) or noanswer,
                "CANCEL response loss needs a ringing target")
        require(sum((lose_cancel_responses, lose_cancel_ok, lose_invite_487)) <= 1,
                "Select only one CANCEL response-loss mode")
        require(not lose_target_ack or (not noanswer and not lose_first_final),
                "ACK loss needs an answered or busy target without final-response loss")
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
        self.lose_target_ack = lose_target_ack
        self.discarded_ack = None
        self.ack_response = None
        self.next_ack_response = None
        self.ack_retry_interval = 0.5
        self.ack_response_retried_at = None
        self.discarded_ack_at = None
        self.target_ack_receipts = []
        self.ack_response_retries = []

    def close(self):
        self.sip.close()
        self.rtp.close()

    def receive(self):
        start, headers, body = parse_message(self.sip.recv(65535))
        if start.startswith("SIP/2.0 "):
            return int(start.split()[1]), headers, (start, headers, body)
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
            if self.lose_target_ack:
                if not self.busy:
                    ack_branch = re.search(r";branch=([^;\s]+)", headers["via"][0])
                    invite_branch = re.search(r";branch=([^;\s]+)", self.dialog["via"][0])
                    require(ack_branch and invite_branch and ack_branch[1] != invite_branch[1],
                            "2xx target ACK reused INVITE transaction branch")
                    require(start.split()[1] == f"sip:proof-target@{self.ip}:{self.port}"
                            and headers["to"] == [f"{self.dialog['to'][0]};tag={self.tag}"],
                            "2xx target ACK did not match answered Contact/dialog")
                message = (start, headers, body)
                require(len(self.ack_response_retries) >= len(self.target_ack_receipts),
                        "Target ACK repeated before its final-response retry")
                self.target_ack_receipts.append(time.monotonic())
                if self.discarded_ack is None:
                    self.discarded_ack = message
                    self.discarded_ack_at = self.target_ack_receipts[0]
                require(message == self.discarded_ack,
                        "Repeated target ACK changed request line, headers, or body")
                if len(self.target_ack_receipts) <= self.lose_target_ack:
                    return None
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
        if self.lose_target_ack and headers["cseq"][0].endswith(" INVITE") \
                and int(status.split()[0]) >= 200:
            if self.ack_response is None:
                self.ack_response = packet
                self.next_ack_response = time.monotonic() + self.ack_retry_interval
            else:
                require(packet == self.ack_response, "Retransmitted target final response changed bytes")
                if self.ack_response_retried_at is None:
                    self.ack_response_retried_at = time.monotonic()
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
            if self.next_ack_response is not None \
                    and time.monotonic() >= self.next_ack_response:
                require(self.ack_response is not None, "Missing target final response for retry")
                self.sip.send(self.ack_response)
                self.ack_response_retries.append(time.monotonic())
                if self.ack_response_retried_at is None:
                    self.ack_response_retried_at = time.monotonic()
                self.ack_retry_interval = min(self.ack_retry_interval * 2, 4)
                self.next_ack_response = time.monotonic() + self.ack_retry_interval
            if self.next_487 is not None and time.monotonic() >= self.next_487:
                self.respond("487 Request Terminated", self.dialog)
                self.retry_487_interval = min(self.retry_487_interval * 2, 4)
                self.next_487 = time.monotonic() + self.retry_487_interval
            if select.select([self.sip], [], [], 0.05)[0]:
                self.receive()
        require(self.acked, "Target did not receive INVITE and ACK")
        if self.lose_target_ack:
            require(self.discarded_ack is not None and self.ack_response_retried_at is not None,
                    "Missing discarded ACK or retransmitted final response")
            delay = self.ack_received_at - self.discarded_ack_at
            limit = 2 if self.lose_target_ack == 1 else 3
            require(0 < delay < limit,
                    f"Target ACK recovery outside {limit} seconds: {delay}")
            require(len(self.target_ack_receipts) == self.lose_target_ack + 1,
                    "Unexpected number of target ACK receipts")
            if self.lose_target_ack == 2:
                require(len(self.ack_response_retries) == 2,
                        "Two lost ACKs did not require two final-response retries")
                first_retry, second_retry = self.ack_response_retries
                require(0.45 <= first_retry - self.discarded_ack_at < 1
                        and 0.95 <= second_retry - first_retry < 2,
                        "Target final-response retries missed half/one-second backoff")
                print(f"PASS two consecutive {('busy' if self.busy else 'answered')} ACK losses: "
                      f"three identical ACKs, two final-response retries, recovery {delay:.3f}s")
            require(len(self.invite_receipts) == 1, "Target ACK recovery created another INVITE")
            outcome = "busy" if self.busy else "answered"
            status = 486 if self.busy else 200
            print(f"PASS discarded {outcome} ACK: identical {status} retransmitted, "
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
        deadline = time.monotonic() + (10 if self.lose_bye_response else 5)
        next_send = 0
        bye_sends = []
        discarded_response = None
        discarded_at = None
        channels_ended_at = None
        while time.monotonic() < deadline:
            if discarded_response is not None and channels_ended_at is None \
                    and self.channels_ended.is_set():
                channels_ended_at = time.monotonic()
                next_send = channels_ended_at + 0.5
            if time.monotonic() >= next_send:
                self.sip.send(request)
                bye_sends.append(time.monotonic())
                next_send = time.monotonic() + 0.5
            if select.select([self.sip], [], [], 0.05)[0]:
                response = self.receive()
                if response is not None:
                    code, headers, message = response
                    require(headers.get("call-id") == self.dialog["call-id"],
                            "Unexpected target response dialog")
                    if headers.get("cseq") == ["1 BYE"] and code >= 200:
                        require(code == 200, f"Target BYE failed: {code}")
                        vias = headers.get("via", [])
                        response_branch = re.search(r";branch=([^;\s]+)", vias[0]) \
                            if len(vias) == 1 else None
                        require(response_branch and response_branch[1] == branch,
                                "Target BYE response did not match request transaction")
                        if self.lose_bye_response:
                            if discarded_response is None:
                                discarded_response = message
                                discarded_at = time.monotonic()
                                next_send = float("inf")
                                continue
                            require(len(bye_sends) >= 2 and bye_sends[1] > discarded_at,
                                    "Repeated BYE response before request retry")
                            require(channels_ended_at is not None
                                    and bye_sends[1] - channels_ended_at >= 0.5,
                                    "Target BYE retry preceded settled channel observation")
                            require(message == discarded_response,
                                    "Recovered BYE response changed status, headers, or body")
                            delay = time.monotonic() - discarded_at
                            after_end = time.monotonic() - channels_ended_at
                            require(0.5 <= after_end < 2,
                                    "Target BYE response recovery outside 0.5-2s after channel end")
                            print(f"PASS discarded target BYE response: identical BYE retried, "
                                  f"identical 200 recovered after {delay:.3f}s; "
                                  f"{after_end:.3f}s after all channel ends observed")
                        return received
        raise RuntimeError("Timed out awaiting target BYE response")
