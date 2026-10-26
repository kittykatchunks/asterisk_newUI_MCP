"""Bounded synthetic registered queue agent; signalling only, not media quality."""

import re
import select
import time
import uuid

from sip_candidate_client import RegistrationProbe, contact_expiry, validate_media, write_json
from sip_rtp_proof import parse_message, require


PHASES = ("registered-both", "agent-ringing", "agent-answered",
          "agent-ended", "call-complete", "unregistered-both")
UNANSWERED_PHASES = ("registered-both", "agent-ringing", "agent-cancelled",
                     "call-complete", "unregistered-both")
ABANDON_PHASES = ("registered-both", "agent-ringing", "caller-abandoned",
                  "call-complete", "unregistered-both")
BUSY_PHASES = ("registered-both", "agent-ringing", "agent-busy",
               "queue-timeout", "call-complete", "unregistered-both")


class Agent:
    def __init__(self, probe, noanswer=False, busy=False):
        self.probe = probe
        self.dialog = None
        self.invite = None
        self.tag = uuid.uuid4().hex
        self.final = None
        self.acked = False
        self.bye_ok = False
        self.bye = None
        self.noanswer = noanswer
        self.busy_mode = busy
        self.cancel = None
        self.invite_start = None

    def response(self, status, headers, body=""):
        to = headers["to"][0]
        if ";tag=" not in to:
            to += ";tag=" + self.tag
        lines = [f"SIP/2.0 {status}", *("Via: " + value for value in headers["via"]),
                 "From: " + headers["from"][0], "To: " + to,
                 "Call-ID: " + headers["call-id"][0], "CSeq: " + headers["cseq"][0],
                 f"Contact: <sip:proof-agent@{self.probe.ip}:{self.probe.port}>"]
        if body:
            lines.append("Content-Type: application/sdp")
        return "\r\n".join([*lines, f"Content-Length: {len(body.encode())}", "", body]).encode()

    def receive(self, packet):
        start, headers, body = parse_message(packet)
        for name in ("via", "from", "to", "call-id", "cseq"):
            require(len(headers.get(name, [])) == 1, f"Agent missing/ambiguous {name}")
        if start.startswith("SIP/2.0 "):
            require(self.bye is not None and headers["call-id"] == self.dialog["call-id"]
                    and headers["cseq"] == ["1 BYE"] and start.startswith("SIP/2.0 200 ")
                    and headers["to"] == self.dialog["from"]
                    and headers["from"] == [self.dialog["to"][0] + ";tag=" + self.tag],
                    "Unexpected agent BYE response")
            self.bye_ok = True
            return
        method = start.split()[0]
        require(method in ("INVITE", "ACK") or (self.noanswer and method == "CANCEL"),
                "Unexpected agent request")
        if method == "INVITE":
            require(self.dialog is None or (headers == self.dialog and packet == self.invite),
                    "Unexpected agent re-INVITE/dialog")
            require(re.fullmatch(r"\d+ INVITE", headers["cseq"][0]) is not None,
                    "Invalid agent INVITE sequence")
            validate_media(body, self.probe.server[0])
            self.dialog, self.invite = headers, packet
            self.invite_start = start
            self.probe.sip.send(self.final or self.response("180 Ringing", headers))
        elif method == "CANCEL":
            require(self.dialog is not None and headers["call-id"] == self.dialog["call-id"]
                    and headers["via"] == self.dialog["via"]
                    and headers["from"] == self.dialog["from"]
                    and headers["to"] == self.dialog["to"]
                    and headers["cseq"] == [self.dialog["cseq"][0].replace("INVITE", "CANCEL")]
                    and start == self.invite_start.replace("INVITE ", "CANCEL ", 1),
                    "Agent CANCEL does not match INVITE transaction")
            require(self.cancel is None or self.cancel == packet, "Retried agent CANCEL changed bytes")
            self.cancel = packet
            self.probe.sip.send(self.response("200 OK", headers))
            self.final = self.response("487 Request Terminated", self.dialog)
            self.probe.sip.send(self.final)
        else:
            require(self.final is not None and headers["call-id"] == self.dialog["call-id"]
                    and headers["cseq"] == [self.dialog["cseq"][0].replace("INVITE", "ACK")]
                    and headers["from"] == self.dialog["from"]
                    and headers["to"] == [self.dialog["to"][0] + ";tag=" + self.tag],
                    "Unexpected agent ACK")
            if self.noanswer or self.busy_mode:
                require((self.cancel is not None if self.noanswer else self.final is not None)
                        and headers["via"] == self.dialog["via"]
                        and start == self.invite_start.replace("INVITE ", "ACK ", 1),
                        "Non-2xx ACK requires original INVITE transaction")
            self.acked = True

    def answer(self):
        require(not (self.noanswer or self.busy_mode), "Non-answering agent must not answer")
        require(self.dialog is not None and self.final is None, "Agent answer requires one ringing dialog")
        ip, port = self.probe.ip, self.probe.rtp.getsockname()[1]
        sdp = (f"v=0\r\no=agent 1 1 IN IP4 {ip}\r\ns=synthetic-agent\r\n"
               f"c=IN IP4 {ip}\r\nt=0 0\r\nm=audio {port} RTP/AVP 0\r\n"
               "a=rtpmap:0 PCMU/8000\r\na=sendrecv\r\n")
        self.final = self.response("200 OK", self.dialog, sdp)
        self.probe.sip.send(self.final)

    def respond_busy(self):
        require(self.busy_mode and self.dialog is not None and self.final is None,
                "Busy response requires one ringing busy-mode dialog")
        self.final = self.response("486 Busy Here", self.dialog)
        self.probe.sip.send(self.final)

    def hangup(self):
        require(not (self.noanswer or self.busy_mode),
                "Non-answering agent has no established dialog to hang up")
        require(self.acked and self.bye is None, "Agent hangup requires acknowledged dialog")
        contacts = self.dialog.get("contact", [])
        target = re.fullmatch(r"<([^>]+)>", contacts[0]) if len(contacts) == 1 else None
        require(target is not None, "Missing agent dialog remote target")
        require(re.fullmatch(r"sip:[^@;\s]+@" + re.escape(self.probe.server[0]) + r":5060", target[1])
                is not None, "Unexpected agent remote target")
        lines = [f"BYE {target[1]} SIP/2.0",
                 f"Via: SIP/2.0/UDP {self.probe.ip}:{self.probe.port};branch=z9hG4bK{uuid.uuid4().hex};rport",
                 "Max-Forwards: 10", "From: " + self.dialog["to"][0] + ";tag=" + self.tag,
                 "To: " + self.dialog["from"][0], "Call-ID: " + self.dialog["call-id"][0],
                 "CSeq: 1 BYE", "Content-Length: 0", "", ""]
        self.bye = "\r\n".join(lines).encode()
        self.probe.sip.send(self.bye)


def execute_answer(host, control, noanswer=False, caller_abandon=False, member_busy=False):
    secrets = [(control / name).read_text() for name in ("secret", "agent-secret")]
    require(all(re.fullmatch(r"[a-f0-9]{64}", value) for value in secrets)
            and secrets[0] != secrets[1], "Expected distinct private fixture credentials")
    caller = RegistrationProbe(host)
    agent_probe = RegistrationProbe(host, "proof-agent")
    agent = (Agent(agent_probe, noanswer=True) if noanswer or caller_abandon else
             Agent(agent_probe, busy=True) if member_busy else Agent(agent_probe))
    report = dict(passed=False, registrationPassed=False, mediaPassed=False,
                  answeredQueueRequested=not (noanswer or caller_abandon or member_busy),
                  unansweredQueueRequested=noanswer, busyQueueRequested=member_busy,
                  phases=[], clientAddress=caller.ip,
                  clientPort=caller.port, agentPort=agent_probe.port, pbxAddress=caller.server[0])
    if caller_abandon:
        report["callerAbandonQueueRequested"] = True
    deadline = time.monotonic() + 60
    caller_receive = None
    phases = (BUSY_PHASES if member_busy else ABANDON_PHASES if caller_abandon else
              UNANSWERED_PHASES if noanswer else PHASES)

    def pump():
        sockets = [agent_probe.sip] + ([caller.sip] if caller_receive else [])
        ready, _, _ = select.select(sockets, [], [], 0.05)
        for sock in ready:
            if sock is agent_probe.sip:
                agent.receive(sock.recv(8193))
            else:
                caller_receive()

    def until(predicate, seconds, retry=None):
        end = min(deadline, time.monotonic() + seconds)
        next_retry = time.monotonic() + 0.5
        while not predicate():
            require(time.monotonic() < end, "Answered SIP fixture deadline expired")
            if retry and time.monotonic() >= next_retry:
                agent_probe.sip.send(retry)
                next_retry = time.monotonic() + 0.5
            pump()

    def checkpoint(phase, **details):
        require(phase == phases[len(report["phases"])], "Unexpected caller/agent fixture phase")
        report["phases"].append(dict(phase=phase, **details))
        write_json(control / f"{phase}.json", report)
        until(lambda: (control / f"{phase}.ack").exists(), 10)

    try:
        expiries = []
        for probe, password in zip((caller, agent_probe), secrets):
            code, headers, _ = probe.register(host, password, 60)
            require(code == 200, "Answered fixture registration failed")
            expiries.append(contact_expiry(headers))
        checkpoint("registered-both", contactExpirySeconds=expiries)
        extension = ("queue-busy" if member_busy else "queue-abandon" if caller_abandon
                     else "queue-unanswered" if noanswer else "queue-answer")
        caller.uri = f"sip:{extension}@{host}"
        caller.to_value = f"<{caller.uri}>"
        code, headers, sdp = caller.invite(secrets[0])
        require(code == 200, "Queue caller INVITE failed")
        validate_media(sdp, caller.server[0])

        def hold(sip, rtp, call_id, receive):
            nonlocal caller_receive
            caller_receive = receive
            until(lambda: agent.dialog is not None, 5)
            checkpoint("agent-ringing", inviteSeen=True)
            if caller_abandon:
                caller.to_value = headers["to"][0]
                contact = re.fullmatch(r"<(sip:[^@;>\s]+@[^:;>\s]+:\d+)>", headers["contact"][0])
                require(contact is not None
                        and contact[1] == f"sip:proof-client@{caller.server[0]}:5060",
                        "Unexpected caller dialog remote target")
                caller.branch = "z9hG4bK" + uuid.uuid4().hex
                caller.sip.send(caller.request("ACK", uri=contact[1]))
                caller.cseq += 1
                caller.branch = "z9hG4bK" + uuid.uuid4().hex
                code, _, _ = caller.final_response(caller.request("BYE", uri=contact[1]), "BYE")
                require(code == 200, f"Caller abandonment BYE failed: {code}")
                until(lambda: agent.cancel is not None, 5)
                until(lambda: agent.acked, 5, agent.final)
                checkpoint("caller-abandoned", callerByeCode=200, cancelCode=200,
                           inviteFinalCode=487, transactionAckSeen=True, agentAnswered=False)
            elif noanswer:
                until(lambda: agent.cancel is not None, 5)
                until(lambda: agent.acked, 5, agent.final)
                checkpoint("agent-cancelled", cancelCode=200, inviteFinalCode=487,
                           transactionAckSeen=True, agentAnswered=False)
            elif member_busy:
                agent.respond_busy()
                until(lambda: agent.acked, 5, agent.final)
                checkpoint("agent-busy", inviteFinalCode=486,
                           transactionAckSeen=True, agentAnswered=False)
                checkpoint("queue-timeout", callerWaitObserved=True,
                           queueStatus="TIMEOUT", answeredMilliseconds=0)
            else:
                agent.answer()
                until(lambda: agent.acked, 5, agent.final)
                checkpoint("agent-answered", ackSeen=True)
                end = time.monotonic() + 4
                until(lambda: time.monotonic() >= end, 5)
                agent.hangup()
                until(lambda: agent.bye_ok, 5, agent.bye)
                checkpoint("agent-ended", byeCode=200, syntheticHoldSeconds=4)
            caller_receive = None

        if caller_abandon:
            hold(None, None, caller.call_id, None)
            checkpoint("call-complete", callerByeCode=200, agentAnswered=False)
        else:
            caller.echo(headers, sdp, hold)
            checkpoint("call-complete", callerByeCode=200)
        for probe, password in zip((caller, agent_probe), secrets):
            code, _, _ = probe.register(host, password, 0)
            require(code == 200, "Answered fixture unregistration failed")
        checkpoint("unregistered-both", code=200)
        report.update(passed=True, registrationPassed=True)
    finally:
        caller.close()
        agent_probe.close()
        write_json(control / "client-report.json", report)
    return report
