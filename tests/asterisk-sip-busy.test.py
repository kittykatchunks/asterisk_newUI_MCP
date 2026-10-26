import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
HERE = ROOT / "local/asterisk-build"
sys.path[:0] = [str(HERE), str(ROOT / "tests")]
import runtime_sip_busy as host
import sip_queue_answer_client as client

spec = importlib.util.spec_from_file_location("busy_orchestrator", HERE / "sip-proof.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

BASELINE = host.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
CALLER = "PJSIP/proof-client-00000001"
AGENT = "PJSIP/proof-agent-00000002"


def packet(method="INVITE", *, call="busy-call", branch="original", sequence=42, tag=""):
    sdp = ("c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\n"
           "a=rtpmap:0 PCMU/8000\r\n") if method == "INVITE" else ""
    return (f"{method} sip:proof-agent@172.23.0.3:4001 SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP 172.23.0.2:5060;branch={branch}\r\n"
            "From: <sip:caller@172.23.0.2>;tag=remote\r\n"
            f"To: <sip:proof-agent@172.23.0.3>{tag}\r\n"
            f"Call-ID: {call}\r\nCSeq: {sequence} {method}\r\n"
            "Contact: <sip:asterisk@172.23.0.2:5060>\r\n"
            f"Content-Length: {len(sdp)}\r\n\r\n{sdp}").encode()


def channel(name, state="Up", application="Queue", data="proof-queue,r,,,3"):
    return "!".join([name, "isolated-sip-proof", "queue-busy", "2", state,
                     application, data, "", "", "", "", ""]) + "\n"


class SipBusyTests(unittest.TestCase):
    def test_agent_returns_486_only_after_ringing_and_correlates_non2xx_ack(self):
        probe = Mock(server=("172.23.0.2", 5060), ip="172.23.0.3", port=4001)
        agent = client.Agent(probe, busy=True)
        with self.assertRaisesRegex(RuntimeError, "one ringing busy-mode"):
            agent.respond_busy()
        invite = packet()
        agent.receive(invite)
        self.assertIn(b"SIP/2.0 180 Ringing", probe.sip.send.call_args.args[0])
        self.assertIsNone(agent.final)
        agent.respond_busy()
        response = probe.sip.send.call_args.args[0]
        self.assertIn(b"SIP/2.0 486 Busy Here", response)
        self.assertIn(b"CSeq: 42 INVITE", response)
        agent.receive(invite)
        self.assertEqual(probe.sip.send.call_args.args[0], response)
        agent.receive(packet("ACK", tag=";tag=" + agent.tag))
        self.assertTrue(agent.acked)
        with self.assertRaisesRegex(RuntimeError, "must not answer"):
            agent.answer()
        with self.assertRaisesRegex(RuntimeError, "no established dialog"):
            agent.hangup()

    def host_lifecycle(self, failure=None):
        members, stage = 0, ""
        report, calls = {}, []

        def cli(text):
            nonlocal members
            calls.append(text)
            if text.startswith("queue policy snapshot"):
                response = json.loads(json.dumps(BASELINE))
                queue = next(row for row in response["objects"] if row["name"] == "proof-queue")
                queue["memberCount"] = members
                if stage in ("agent-ringing", "agent-busy"):
                    queue.update(callerCount=1, callerListEmpty=False)
                return json.dumps(response)
            if text.startswith("queue add"):
                members = 1
                return "Added interface 'PJSIP/proof-agent' to queue 'proof-queue'\n"
            if text.startswith("queue remove"):
                members = 0
                return "Removed interface PJSIP/proof-agent from queue 'proof-queue'\n"
            if text == "core show channels concise":
                if stage == "agent-ringing":
                    return channel(CALLER) + channel(
                        AGENT, "Up" if failure == "agent-answer-ringing" else "Ringing", "AppQueue", "")
                if stage == "agent-busy":
                    return channel(CALLER, application="Queue", data="proof-queue,r,,,3")
                if stage == "queue-timeout":
                    return channel(CALLER, application="Wait", data="10")
                return ""
            if text.startswith("core show channel "):
                return ("QUEUESTATUS=TIMEOUT\nQUEUEWAIT_MS=3000\n"
                        "ANSWEREDTIME_MS=0\nABANDONED=TRUE\n")
            if text == "queue show proof-queue":
                return (("C:1 A:0\n PJSIP/proof-agent (dynamic) has taken 1 calls\n" if failure == "completed" else
                         "C:0 A:1\n PJSIP/proof-agent (dynamic) has taken no calls\n")
                        + " No Callers\n")
            raise AssertionError(text)

        for stage in host.PHASES:
            progress = {"phases": [dict(phase=stage, inviteFinalCode=486,
                                        transactionAckSeen=True, agentAnswered=False)]}
            if failure == "missing-ack":
                progress["phases"][0]["transactionAckSeen"] = False
            if failure == "wrong-status":
                progress["phases"][0]["inviteFinalCode"] = 480
            host.phase(cli, stage, progress, report)
        return report, calls

    def test_host_requires_caller_to_remain_queued_after_486_then_timeout(self):
        report, calls = self.host_lifecycle()
        self.assertTrue(report["passed"])
        self.assertEqual(report["ringingObservation"]["policy"]["callerCount"], 1)
        self.assertEqual(len(report["ringingObservation"]["channels"]), 2)
        self.assertEqual(report["busyObservation"]["channels"][0]["name"], CALLER)
        self.assertEqual(report["busyObservation"]["policy"]["callerCount"], 1)
        self.assertEqual(report["resultVariables"]["QUEUESTATUS"], "TIMEOUT")
        self.assertEqual(report["resultVariables"]["QUEUEWAIT_MS"], "3000")
        self.assertEqual(report["resultVariables"]["ANSWEREDTIME_MS"], "0")
        self.assertEqual(report["resultVariables"]["ABANDONED"], "TRUE")
        self.assertEqual(report["finalPolicy"], report["initialPolicy"])
        self.assertTrue(report["memberRemoved"])
        self.assertEqual(calls.count("core show channel " + CALLER), 1)

    def test_host_rejects_invalid_busy_ack_answer_or_call_accounting(self):
        for failure in ("missing-ack", "wrong-status", "agent-answer-ringing", "completed"):
            with self.subTest(failure=failure), self.assertRaises((ValueError, TimeoutError)):
                self.host_lifecycle(failure)

    def test_host_timeout_deadline_retains_progress_and_requires_original_caller(self):
        progress = {"phases": [dict(phase="queue-timeout")]}
        report = {"ringingObservation": {"channels": [{"name": CALLER}]}}
        cli = lambda text: channel("PJSIP/proof-client-00000003", application="Wait", data="10")
        with patch.object(host.shared.answered, "policy", return_value={"callerCount": 0}), \
                patch.object(host.time, "monotonic", side_effect=[0, 6]):
            with self.assertRaises(TimeoutError):
                host.phase(cli, "queue-timeout", progress, report)
        self.assertEqual(len(report["timeoutProgress"]), 1)
        self.assertNotIn("resultVariables", report)

    def test_client_waits_for_host_ringing_before_busy_and_timeout_then_bye(self):
        with tempfile.TemporaryDirectory() as directory:
            control = pathlib.Path(directory)
            for name, value in (("secret", "a"), ("agent-secret", "b")):
                (control / name).write_text(value * 64)
            for phase in client.BUSY_PHASES:
                (control / f"{phase}.ack").touch()
            caller, agent_probe = [
                Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060))
                for port in (4000, 4001)
            ]
            for probe in (caller, agent_probe):
                probe.register.side_effect = [
                    (200, {"contact": ["<sip:fixture@host>;expires=59"]}, ""), (200, {}, "")]
            caller.invite.return_value = (200, {}, (
                "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"))
            def echo(headers, body, verify):
                return verify(None, None, "call", lambda: None)
            caller.echo.side_effect = echo
            agent = Mock(dialog={"id": "busy"}, acked=True, final=b"486")
            with patch.object(client, "RegistrationProbe", side_effect=[caller, agent_probe]), \
                    patch.object(client, "Agent", return_value=agent) as make_agent:
                report = client.execute_answer("pbx", control, member_busy=True)
            self.assertTrue(report["passed"])
            self.assertTrue(report["busyQueueRequested"])
            self.assertFalse(report["answeredQueueRequested"])
            self.assertEqual(caller.uri, "sip:queue-busy@pbx")
            self.assertEqual([phase["phase"] for phase in report["phases"]], list(client.BUSY_PHASES))
            self.assertEqual(report["phases"][2]["inviteFinalCode"], 486)
            self.assertEqual(report["phases"][3]["queueStatus"], "TIMEOUT")
            agent.respond_busy.assert_called_once()
            agent.answer.assert_not_called()
            agent.hangup.assert_not_called()
            caller.echo.assert_called_once()
            make_agent.assert_called_once_with(agent_probe, busy=True)
            for probe in (caller, agent_probe):
                self.assertEqual(probe.register.call_args_list[-1].args[-1], 0)
                probe.close.assert_called_once()

    def test_mode_is_mutually_exclusive_without_runtime_side_effects(self):
        for flags in (dict(queue_timeout=True, queue_busy=True),
                      dict(queue_answer=True, queue_busy=True),
                      dict(queue_unanswered=True, queue_busy=True),
                      dict(queue_abandon=True, queue_busy=True)):
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "uncreated"
                with patch.object(runner.desktop, "command") as command, \
                        self.assertRaisesRegex(ValueError, "one SIP queue"):
                    runner.proof(root, **flags)
                command.assert_not_called()
                self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
