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
import runtime_sip_abandon as host
import sip_queue_answer_client as client

spec = importlib.util.spec_from_file_location("abandon_orchestrator", HERE / "sip-proof.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

CALLER = "PJSIP/proof-client-00000001"
AGENT = "PJSIP/proof-agent-00000002"
BASELINE = host.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]


def channel(name, state="Up", application="Queue", data="proof-queue,r,,,10"):
    return "!".join([name, "isolated-sip-proof", "queue-abandon", "2", state,
                     application, data, "", "", "", "", ""]) + "\n"


class SipAbandonTests(unittest.TestCase):
    def test_fixture_has_longer_private_queue_window_and_app_timeout_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            queues = root / "etc/queues.conf"
            queues.write_text("[unrelated]\ntimeout=11\n[proof-queue]\ntimeout=7\n")
            host.prepare(root)
            self.assertEqual(queues.read_text(),
                             "[unrelated]\ntimeout=11\n[proof-queue]\ntimeoutpriority=app\ntimeout=7\n")
            extensions = (root / "etc/extensions.conf").read_text()
            self.assertIn("exten => queue-abandon,1,Answer()", extensions)
            self.assertIn("Queue(proof-queue,r,,,10)", extensions)
            self.assertIn("Wait(20)", extensions)
            self.assertEqual(extensions.count("exten =>"), 1)

    def host_lifecycle(self, failure=None):
        members, stage = 0, ""
        report, calls = {}, []

        def cli(text):
            nonlocal members
            calls.append(text)
            if text.startswith("queue policy snapshot"):
                response = json.loads(json.dumps(BASELINE))
                queue = next(value for value in response["objects"] if value["name"] == "proof-queue")
                queue["memberCount"] = members
                if stage == "agent-ringing":
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
                    return (channel(CALLER) +
                            channel(AGENT, "Up" if failure == "agent-answered" else "Ringing", "AppQueue", "(Outgoing Line)"))
                return ""
            if text == "queue show proof-queue":
                if failure == "call-completed":
                    return "C:1 A:0\n PJSIP/proof-agent has taken 1 calls\n No Callers\n"
                return ("C:0 A:1\n PJSIP/proof-agent (dynamic) has taken no calls yet\n"
                        " No Callers\n")
            raise AssertionError(text)

        for stage in host.PHASES:
            outcome = dict(callerByeCode=200, cancelCode=200, inviteFinalCode=487,
                           transactionAckSeen=True, agentAnswered=False)
            if failure == "missing-bye":
                outcome["callerByeCode"] = 500
            if failure == "missing-cancel":
                outcome["cancelCode"] = 500
            if failure == "missing-ack":
                outcome["transactionAckSeen"] = False
            if failure == "agent-answered-outcome":
                outcome["agentAnswered"] = True
            host.phase(cli, stage, {"phases": [outcome]}, report)
        return report, calls

    def test_host_records_ringing_then_requires_abandonment_and_removes_member(self):
        report, calls = self.host_lifecycle()
        self.assertTrue(report["passed"])
        self.assertEqual(report["ringingObservation"]["policy"]["callerCount"], 1)
        self.assertEqual(len(report["ringingObservation"]["channels"]), 2)
        self.assertEqual(report["abandonment"]["callerByeCode"], 200)
        self.assertEqual(report["abandonment"]["cancelCode"], 200)
        self.assertEqual(report["completedQueueOutput"].splitlines()[0], "C:0 A:1")
        self.assertTrue(report["memberRemoved"])
        self.assertEqual(report["initialPolicy"], report["finalPolicy"])
        self.assertNotIn("resultVariables", report)
        self.assertEqual(calls.count("queue show proof-queue"), 2)

    def test_host_rejects_missing_teardown_evidence_and_completed_agent_call(self):
        for failure in ("missing-bye", "missing-cancel", "missing-ack", "agent-answered-outcome",
                        "agent-answered", "call-completed"):
            with self.subTest(failure=failure), self.assertRaises((ValueError, TimeoutError)):
                self.host_lifecycle(failure)

    def test_client_sends_ack_and_bye_after_host_observes_ringing(self):
        with tempfile.TemporaryDirectory() as directory:
            control = pathlib.Path(directory)
            for name, value in (("secret", "a"), ("agent-secret", "b")):
                (control / name).write_text(value * 64)
            for phase in client.ABANDON_PHASES:
                (control / f"{phase}.ack").touch()
            caller, agent_probe = [
                Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060))
                for port in (4000, 4001)
            ]
            for probe in (caller, agent_probe):
                probe.register.side_effect = [
                    (200, {"contact": ["<sip:fixture@host>;expires=59"]}, ""), (200, {}, "")]
            caller.cseq = 2
            caller.request.side_effect = lambda method, *, uri=None, **kwargs: (
                f"{method} {uri} SIP/2.0\r\nCSeq: {caller.cseq} {method}\r\n").encode()
            caller.final_response.return_value = (200, {}, "")
            caller.invite.return_value = (200, {
                "to": ["<sip:queue-abandon@pbx>;tag=remote"],
                "contact": ["<sip:proof-client@172.23.0.2:5060>"],
            }, "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n")
            agent = Mock(dialog={"id": "agent"}, cancel=b"CANCEL", acked=True, final=b"487")
            with patch.object(client, "RegistrationProbe", side_effect=[caller, agent_probe]), \
                    patch.object(client, "Agent", return_value=agent) as agent_class:
                report = client.execute_answer("pbx", control, caller_abandon=True)
            self.assertTrue(report["passed"])
            self.assertTrue(report["callerAbandonQueueRequested"])
            self.assertFalse(report["answeredQueueRequested"])
            self.assertFalse(report["unansweredQueueRequested"])
            self.assertEqual(caller.uri, "sip:queue-abandon@pbx")
            caller.sip.send.assert_called_once()
            bye_request = caller.final_response.call_args.args[0]
            self.assertTrue(bye_request.startswith(b"BYE sip:proof-client@172.23.0.2:5060 SIP/2.0"))
            caller.final_response.assert_called_once_with(bye_request, "BYE")
            self.assertEqual([phase["phase"] for phase in report["phases"]], list(client.ABANDON_PHASES))
            self.assertEqual(report["phases"][2]["callerByeCode"], 200)
            self.assertEqual(report["phases"][2]["transactionAckSeen"], True)
            agent_class.assert_called_once_with(agent_probe, noanswer=True)
            agent.answer.assert_not_called()
            agent.hangup.assert_not_called()
            for probe in (caller, agent_probe):
                self.assertEqual(probe.register.call_args_list[-1].args[-1], 0)
                probe.close.assert_called_once()

    def test_modes_reject_abandon_plus_any_other_queue_mode_without_runtime(self):
        for flags in (
            dict(queue_timeout=True, queue_abandon=True),
            dict(queue_answer=True, queue_abandon=True),
            dict(queue_unanswered=True, queue_abandon=True),
        ):
            with tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "uncreated"
                with patch.object(runner.desktop, "command") as command, \
                        self.assertRaisesRegex(ValueError, "one SIP queue"):
                    runner.proof(root, **flags)
                command.assert_not_called()
                self.assertFalse(root.exists())


if __name__ == "__main__":
    unittest.main()
