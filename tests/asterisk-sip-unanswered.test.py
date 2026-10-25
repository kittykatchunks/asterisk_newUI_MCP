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
import runtime_sip_unanswered as host
import sip_queue_answer_client as client

spec = importlib.util.spec_from_file_location("unanswered_orchestrator", HERE / "sip-proof.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

CALLER = "PJSIP/proof-client-00000001"
AGENT = "PJSIP/proof-agent-00000002"


def packet(method="INVITE", *, call="agent-call", branch="original", sequence=42, tag=""):
    sdp = ("c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\n"
           "a=rtpmap:0 PCMU/8000\r\n") if method == "INVITE" else ""
    return (f"{method} sip:proof-agent@172.23.0.3:4001 SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP 172.23.0.2:5060;branch={branch}\r\n"
            "From: <sip:caller@172.23.0.2>;tag=remote\r\n"
            f"To: <sip:proof-agent@172.23.0.3>{tag}\r\n"
            f"Call-ID: {call}\r\nCSeq: {sequence} {method}\r\n"
            "Contact: <sip:asterisk@172.23.0.2:5060>\r\n"
            f"Content-Length: {len(sdp)}\r\n\r\n{sdp}").encode()


def row(name, state="Up", app="Queue", data="proof-queue,r,,,3"):
    return "!".join([name, "isolated-sip-proof", "queue-unanswered", "2", state,
                     app, data, "", "", "", "", ""]) + "\n"


class SipUnansweredTests(unittest.TestCase):
    def test_fixture_sets_app_priority_without_touching_unrelated_queue(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            queues = root / "etc/queues.conf"
            queues.write_text("[unrelated]\ntimeout=11\n[proof-queue]\ntimeout=7\n")
            host.prepare(root)
            self.assertEqual(queues.read_text(),
                             "[unrelated]\ntimeout=11\n[proof-queue]\ntimeoutpriority=app\ntimeout=7\n")
            dialplan = (root / "etc/extensions.conf").read_text()
            self.assertIn("queue-unanswered,1,Answer()", dialplan)
            self.assertIn("Queue(proof-queue,r,,,3)", dialplan)
            self.assertIn("Wait(10)", dialplan)
            self.assertEqual(dialplan.count("exten =>"), 1)
            self.assertNotIn("Dial(", dialplan)

    def test_agent_never_answers_and_matches_cancel_487_ack_transaction(self):
        probe = Mock(server=("172.23.0.2", 5060), ip="172.23.0.3", port=4001)
        agent = client.Agent(probe, noanswer=True)
        agent.receive(packet())
        self.assertIn(b"180 Ringing", probe.sip.send.call_args.args[0])
        with self.assertRaisesRegex(RuntimeError, "must not answer"):
            agent.answer()
        with self.assertRaisesRegex(RuntimeError, "no established dialog"):
            agent.hangup()
        cancel = packet("CANCEL")
        agent.receive(cancel)
        sent = [call.args[0] for call in probe.sip.send.call_args_list]
        self.assertIn(b"SIP/2.0 200 OK\r\n", sent[-2])
        self.assertIn(b"CSeq: 42 CANCEL\r\n", sent[-2])
        self.assertIn(b"SIP/2.0 487 Request Terminated\r\n", sent[-1])
        self.assertIn(b"CSeq: 42 INVITE\r\n", sent[-1])
        agent.receive(cancel)
        self.assertEqual(probe.sip.send.call_args_list[-2].args[0], sent[-2])
        self.assertEqual(probe.sip.send.call_args.args[0], sent[-1])
        agent.receive(packet())
        self.assertEqual(probe.sip.send.call_args.args[0], sent[-1])
        agent.receive(packet("ACK", tag=";tag=" + agent.tag))
        self.assertTrue(agent.acked)
        self.assertFalse(agent.bye_ok)
        self.assertIsNone(agent.bye)

    def test_agent_rejects_foreign_cancel_branch_sequence_tag_uri_and_early_ack(self):
        for invalid in (packet("CANCEL", call="other"), packet("CANCEL", branch="wrong"),
                        packet("CANCEL", sequence=43), packet("CANCEL", tag=";tag=wrong"),
                        packet("CANCEL").replace(b"sip:proof-agent@", b"sip:foreign@", 1)):
            with self.subTest(packet=invalid):
                probe = Mock(server=("172.23.0.2", 5060))
                agent = client.Agent(probe, noanswer=True)
                agent.receive(packet())
                with self.assertRaisesRegex(RuntimeError, "transaction"):
                    agent.receive(invalid)
                self.assertIsNone(agent.cancel)
        agent = client.Agent(Mock(server=("172.23.0.2", 5060)), noanswer=True)
        agent.receive(packet())
        with self.assertRaisesRegex(RuntimeError, "ACK"):
            agent.receive(packet("ACK", tag=";tag=" + agent.tag))
        agent.receive(packet("CANCEL"))
        for invalid in (packet("ACK", branch="wrong", tag=";tag=" + agent.tag),
                        packet("ACK", call="foreign", tag=";tag=" + agent.tag),
                        packet("ACK", sequence=43, tag=";tag=" + agent.tag),
                        packet("ACK", tag=";tag=foreign"),
                        packet("ACK", tag=";tag=" + agent.tag).replace(
                            b"sip:proof-agent@", b"sip:foreign@", 1)):
            with self.subTest(packet=invalid), self.assertRaisesRegex(RuntimeError, "ACK"):
                agent.receive(invalid)

    def host_lifecycle(self, failure=None):
        baseline = host.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        members, stage = 0, ""
        report, calls = {}, []

        def cli(text):
            nonlocal members
            calls.append(text)
            if text.startswith("queue policy snapshot"):
                response = json.loads(json.dumps(baseline))
                queue = next(value for value in response["objects"] if value["name"] == "proof-queue")
                queue["memberCount"] = members
                if stage == "agent-ringing":
                    queue.update(callerCount=1, callerListEmpty=False)
                if failure == "retained" and stage == "agent-cancelled":
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
                    return row(CALLER) + row(AGENT, "Up" if failure == "answered" else "Ringing", "AppQueue", "")
                return row(CALLER, app="Wait", data="10") if stage == "agent-cancelled" else ""
            if text.startswith("core show channel "):
                return ("QUEUESTATUS=TIMEOUT\nQUEUEWAIT_MS=3000\nANSWEREDTIME_MS=" +
                        ("1" if failure == "answered-result" else "0") + "\nABANDONED=TRUE\n")
            if text == "queue show proof-queue":
                return (("C:1 A:0" if failure == "completed" else "C:0 A:1") +
                        "\n PJSIP/proof-agent (dynamic) has taken no calls\n No Callers\n")
            raise AssertionError(text)

        for stage in host.PHASES:
            progress = {"phases": [dict(phase=stage, cancelCode=200, inviteFinalCode=487,
                                        transactionAckSeen=True, agentAnswered=False)]}
            if failure == "missing-ack":
                progress["phases"][0]["transactionAckSeen"] = False
            host.phase(cli, stage, progress, report)
        return report, calls

    def test_host_requires_ringing_timeout_no_completion_and_restores_baseline(self):
        result, calls = self.host_lifecycle()
        self.assertTrue(result["passed"])
        self.assertTrue(result["memberRemoved"])
        self.assertFalse(result["mediaVerified"])
        self.assertEqual(result["resultVariables"]["ANSWEREDTIME_MS"], "0")
        self.assertEqual(result["resultVariables"]["QUEUEWAIT_MS"], "3000")
        self.assertEqual(result["initialPolicy"], result["finalPolicy"])
        self.assertEqual(calls.count("core show channel " + CALLER), 1)

    def test_host_rejects_answer_missing_cancel_ack_retained_caller_and_completion(self):
        for failure in ("answered", "missing-ack", "retained", "answered-result", "completed"):
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.host_lifecycle(failure)

    def test_host_result_timeout_retains_bounded_observations(self):
        policy = {"callerCount": 1}
        progress = {"phases": [dict(cancelCode=200, inviteFinalCode=487,
                                   transactionAckSeen=True, agentAnswered=False)]}
        report = {"ringingObservation": {"channels": [dict(name=CALLER)]}}
        cli = lambda text: row(CALLER) if text == "core show channels concise" else "{}"
        with patch.object(host.shared.answered, "policy", return_value=policy), \
                patch.object(host.time, "monotonic", side_effect=[0, 6]):
            with self.assertRaisesRegex(TimeoutError, "five seconds"):
                host.phase(cli, "agent-cancelled", progress, report)
        self.assertEqual(len(report["resultProgress"]), 1)
        self.assertNotIn("resultVariables", report)

    def test_host_result_requires_original_caller_not_a_replacement(self):
        progress = {"phases": [dict(cancelCode=200, inviteFinalCode=487,
                                   transactionAckSeen=True, agentAnswered=False)]}
        report = {"ringingObservation": {"channels": [dict(name=CALLER)]}}
        cli = lambda text: row("PJSIP/proof-client-00000003", app="Wait", data="10")
        with patch.object(host.shared.answered, "policy", return_value={"callerCount": 0}), \
                patch.object(host.time, "monotonic", side_effect=[0, 6]):
            with self.assertRaises(TimeoutError):
                host.phase(cli, "agent-cancelled", progress, report)
        self.assertNotIn("resultVariables", report)

    def test_client_noanswer_never_calls_answer_or_hangup_and_unregisters_both(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "secret").write_text("a" * 64)
            (root / "agent-secret").write_text("b" * 64)
            for phase in client.UNANSWERED_PHASES:
                (root / f"{phase}.ack").touch()
            probes = [Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060)) for port in (4000, 4001)]
            for probe in probes:
                probe.register.side_effect = [
                    (200, {"contact": ["<sip:fixture@host>;expires=59"]}, ""), (200, {}, "")]
            probes[0].invite.return_value = (200, {}, (
                "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"))
            probes[0].echo.side_effect = lambda headers, body, verify: verify(None, None, "call", lambda: None)
            agent = Mock(dialog={"id": "agent"}, cancel=b"CANCEL", acked=True, final=b"487")
            with patch.object(client, "RegistrationProbe", side_effect=probes), \
                    patch.object(client, "Agent", return_value=agent) as agent_class, \
                    patch.object(client.select, "select", return_value=([], [], [])):
                result = client.execute_answer("pbx", root, noanswer=True)
            self.assertTrue(result["passed"])
            self.assertTrue(result["unansweredQueueRequested"])
            self.assertFalse(result["answeredQueueRequested"])
            self.assertFalse(result["mediaPassed"])
            self.assertEqual([phase["phase"] for phase in result["phases"]], list(client.UNANSWERED_PHASES))
            self.assertEqual(probes[0].uri, "sip:queue-unanswered@pbx")
            agent_class.assert_called_once_with(probes[1], noanswer=True)
            agent.answer.assert_not_called()
            agent.hangup.assert_not_called()
            for probe in probes:
                self.assertEqual(probe.register.call_args_list[-1].args[-1], 0)
                probe.close.assert_called_once()

    def test_client_missing_cancel_times_out_and_preserves_failed_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for name, value in (("secret", "a"), ("agent-secret", "b")):
                (root / name).write_text(value * 64)
            for phase in client.UNANSWERED_PHASES:
                (root / f"{phase}.ack").touch()
            probes = [Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060)) for port in (4000, 4001)]
            for probe in probes:
                probe.register.return_value = (200, {"contact": ["<sip:fixture@host>;expires=59"]}, "")
            probes[0].invite.return_value = (200, {}, (
                "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"))
            probes[0].echo.side_effect = lambda headers, body, verify: verify(None, None, "call", lambda: None)
            clock = iter(range(1000))
            with patch.object(client, "RegistrationProbe", side_effect=probes), \
                    patch.object(client, "Agent", return_value=Mock(dialog={}, cancel=None)), \
                    patch.object(client.select, "select", return_value=([], [], [])), \
                    patch.object(client.time, "monotonic", side_effect=lambda: next(clock)):
                with self.assertRaisesRegex(RuntimeError, "deadline"):
                    client.execute_answer("pbx", root, noanswer=True)
            self.assertFalse(json.loads((root / "client-report.json").read_text())["passed"])
            for probe in probes:
                probe.close.assert_called_once()

    def test_modes_reject_combination_before_any_docker_or_directory_creation(self):
        for timeout, answer in ((True, False), (False, True)):
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "uncreated"
                with patch.object(runner.desktop, "command") as command:
                    with self.assertRaisesRegex(ValueError, "one SIP queue"):
                        runner.proof(root, queue_timeout=timeout, queue_answer=answer, queue_unanswered=True)
                    command.assert_not_called()
                self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
