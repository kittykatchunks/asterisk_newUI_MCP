import hashlib
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
import runtime_sip_answer as host
import sip_queue_answer_client as client
import sip_rtp_proof as sip

spec = importlib.util.spec_from_file_location("answer_orchestrator", HERE / "sip-proof.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

CALLER = "PJSIP/proof-client-00000001"
AGENT = "PJSIP/proof-agent-00000002"
BRIDGE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"


def row(name, state="Up", app="Queue", data="proof-queue,rc,,,20"):
    return "!".join([name, "isolated-sip-proof", "queue-answer", "2", state, app, data, "", "", "", "", ""]) + "\n"


def invite(cseq="42 INVITE", call_id="agent-call"):
    body = "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
    return (f"INVITE sip:proof-agent@172.23.0.3:4001 SIP/2.0\r\n"
            f"Via: SIP/2.0/UDP 172.23.0.2:5060;branch=z9hG4bK1\r\n"
            f"From: <sip:caller@172.23.0.2>;tag=remote\r\nTo: <sip:proof-agent@172.23.0.3>\r\n"
            f"Call-ID: {call_id}\r\nCSeq: {cseq}\r\nContact: <sip:asterisk@172.23.0.2:5060>\r\n"
            f"Content-Type: application/sdp\r\nContent-Length: {len(body)}\r\n\r\n{body}").encode()


class SipAnswerTests(unittest.TestCase):
    def test_configuration_has_separate_endpoint_auth_and_single_private_route(self):
        config = host.configuration(runner.CONFIG)
        self.assertEqual(config.count("type=endpoint"), 2)
        self.assertEqual(config.count("type=auth"), 2)
        self.assertEqual(config.count("@SECRET@"), 1)
        self.assertEqual(config.count("@AGENT_SECRET@"), 1)
        self.assertIn("auth=proof-agent-auth", config)
        self.assertIn("username=proof-agent", config)
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            host.prepare(root)
            dialplan = (root / "etc/extensions.conf").read_text()
        self.assertIn("Queue(proof-queue,rc,,,20)", dialplan)
        self.assertIn("Wait(10)", dialplan)
        self.assertEqual(dialplan.count("exten =>"), 1)
        self.assertNotIn("Dial(", dialplan)

    def test_agent_digest_identity_has_distinct_ha1_and_default_is_unchanged(self):
        challenge = 'Digest realm="r", nonce="n"'
        md5 = lambda text: hashlib.md5(text.encode()).hexdigest()
        value = sip.authorization(challenge, "secret", "sip:pbx", "REGISTER", "proof-agent")
        expected = md5(f'{md5("proof-agent:r:secret")}:n:{md5("REGISTER:sip:pbx")}')
        self.assertIn(f'response="{expected}"', value)
        self.assertIn('username="proof-agent"', value)
        self.assertNotEqual(value, sip.authorization(challenge, "secret", "sip:pbx", "REGISTER"))
        with self.assertRaisesRegex(RuntimeError, "identity"):
            sip.authorization(challenge, "secret", "sip:pbx", "REGISTER", "other")

    def test_contact_pair_is_exact_and_rejects_extra_wrong_identity_or_port(self):
        output = (" Contact:  <Aor/ContactUri> <Hash>\n"
                  " Contact: proof-client/sip:proof-client@172.23.0.3:4000 x NonQual nan\n"
                  " Contact: proof-agent/sip:proof-agent@172.23.0.3:4001 y NonQual nan\nObjects found: 2\n")
        self.assertEqual(len(host.contacts(output, "172.23.0.3", 4000, 4001)), 2)
        for bad in (output.replace("4001", "4002"), output.replace("proof-agent/", "other/"),
                    output.replace("found: 2", "found: 3")):
            with self.assertRaises(ValueError):
                host.contacts(bad, "172.23.0.3", 4000, 4001)
        with self.assertRaises(ValueError):
            host.contacts(output, "172.23.0.3", 4000, 4000)

    def test_agent_ringing_answer_ack_bye_and_retransmitted_invite(self):
        probe = Mock(ip="172.23.0.3", port=4001, server=("172.23.0.2", 5060))
        probe.rtp.getsockname.return_value = ("172.23.0.3", 5001)
        agent = client.Agent(probe)
        packet = invite()
        agent.receive(packet)
        self.assertIn(b"SIP/2.0 180 Ringing", probe.sip.send.call_args.args[0])
        agent.answer()
        self.assertIn(b"SIP/2.0 200 OK", agent.final)
        self.assertIn(b"PCMU/8000", agent.final)
        agent.receive(packet)
        self.assertEqual(probe.sip.send.call_args.args[0], agent.final)
        ack = (f"ACK sip:proof-agent@172.23.0.3:4001 SIP/2.0\r\nVia: v\r\n"
               f"From: <sip:caller@172.23.0.2>;tag=remote\r\n"
               f"To: <sip:proof-agent@172.23.0.3>;tag={agent.tag}\r\n"
               "Call-ID: agent-call\r\nCSeq: 42 ACK\r\nContent-Length: 0\r\n\r\n").encode()
        agent.receive(ack)
        self.assertTrue(agent.acked)
        agent.hangup()
        self.assertIn(b"BYE sip:asterisk@172.23.0.2:5060 SIP/2.0", agent.bye)
        agent.receive((f"SIP/2.0 200 OK\r\nVia: v\r\n"
                       f"From: <sip:proof-agent@172.23.0.3>;tag={agent.tag}\r\n"
                       "To: <sip:caller@172.23.0.2>;tag=remote\r\nCall-ID: agent-call\r\n"
                       "CSeq: 1 BYE\r\nContent-Length: 0\r\n\r\n").encode())
        self.assertTrue(agent.bye_ok)

    def test_agent_rejects_foreign_dialog_malformed_packets_and_early_hangup(self):
        probe = Mock(ip="172.23.0.3", port=4001, server=("172.23.0.2", 5060))
        agent = client.Agent(probe)
        with self.assertRaisesRegex(RuntimeError, "acknowledged"):
            agent.hangup()
        with self.assertRaisesRegex(RuntimeError, "ringing"):
            agent.answer()
        agent.receive(invite())
        with self.assertRaisesRegex(RuntimeError, "re-INVITE"):
            agent.receive(invite(call_id="foreign"))
        for packet in (b"x" * 8193, invite().replace(b"INVITE sip:", b"CANCEL sip:", 1),
                       invite().replace(b"c=IN IP4 172.23.0.2", b"c=IN IP4 8.8.8.8")):
            with self.assertRaises(RuntimeError):
                client.Agent(probe).receive(packet)

    def host_lifecycle(self, failure=None):
        baseline = host.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        member_count, stage, calls = 0, "", []
        report = {}

        def cli(text):
            nonlocal member_count
            calls.append(text)
            if text.startswith("queue policy snapshot"):
                value = json.loads(json.dumps(baseline))
                proof = next(item for item in value["objects"] if item["name"] == "proof-queue")
                proof["memberCount"] = member_count
                if stage == "agent-ringing":
                    proof.update(callerCount=1, callerListEmpty=False)
                return json.dumps(value)
            if text.startswith("queue add"):
                member_count = 1
                return "Added interface 'PJSIP/proof-agent' to queue 'proof-queue'\n"
            if text.startswith("queue remove"):
                member_count = 0
                return "Removed interface PJSIP/proof-agent from queue 'proof-queue'\n"
            if text == "core show channels concise":
                if stage in ("agent-ringing", "agent-answered"):
                    return row(CALLER) + row(AGENT, "Ringing" if stage == "agent-ringing" else "Up", "AppQueue", "")
                return row(CALLER, app="Wait", data="10") if stage == "agent-ended" else ""
            if text.startswith("core show channel "):
                if stage == "agent-answered":
                    value = BRIDGE if failure != "different-bridge" or text.endswith(CALLER) else "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee"
                    return f" Bridge ID: {value}\n"
                return ("QUEUESTATUS=CONTINUE\nANSWEREDTIME_MS=" +
                        ("0" if failure == "zero-answer" else "4500") + "\nDIALEDTIME_MS=6500\n")
            if text == "queue show proof-queue":
                return ("C:0 No Callers\n" if failure == "not-completed" else
                        "C:1 A:0\n PJSIP/proof-agent (dynamic) has taken 1 calls\n No Callers\n")
            raise AssertionError(text)

        for stage in host.PHASES:
            host.phase(cli, stage, {}, report)
        return report, calls

    def test_host_observes_two_bridged_legs_result_completed_call_and_member_removal(self):
        report, calls = self.host_lifecycle()
        self.assertTrue(report["passed"])
        self.assertTrue(report["memberRemoved"])
        self.assertFalse(report["mediaVerified"])
        self.assertEqual(report["bridgeId"], BRIDGE)
        self.assertEqual(report["resultVariables"]["ANSWEREDTIME_MS"], "4500")
        self.assertEqual(report["initialPolicy"], report["finalPolicy"])
        self.assertEqual(calls.count("core show channel " + CALLER), 2)

    def test_host_rejects_wrong_bridge_unanswered_result_or_missing_completion(self):
        for failure in ("different-bridge", "zero-answer", "not-completed"):
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.host_lifecycle(failure)

    def test_secret_pair_validation_precedes_sockets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            for filename in ("secret", "agent-secret"):
                (root / filename).write_text("a" * 64)
            with patch.object(client, "RegistrationProbe") as probe:
                with self.assertRaisesRegex(RuntimeError, "distinct"):
                    client.execute_answer("not-resolved.invalid", root)
            probe.assert_not_called()

    def test_mutually_exclusive_modes_fail_before_docker_or_directories(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "uncreated"
            with patch.object(runner.desktop, "command") as command:
                with self.assertRaisesRegex(ValueError, "one SIP queue"):
                    runner.proof(root, queue_timeout=True, queue_answer=True)
                command.assert_not_called()
            self.assertFalse(root.exists())

    def test_mocked_client_answers_agent_then_hangs_up_caller_and_unregisters_both(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "secret").write_text("a" * 64)
            (root / "agent-secret").write_text("b" * 64)
            for stage in client.PHASES:
                (root / f"{stage}.ack").touch()
            probes = [Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060)) for port in (4000, 4001)]
            for probe in probes:
                probe.register.side_effect = [
                    (200, {"contact": ["<sip:fixture@host>;expires=59"]}, ""), (200, {}, "")]
            probes[0].invite.return_value = (200, {}, (
                "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"))
            probes[0].echo.side_effect = lambda headers, body, verify: verify(None, None, "call", lambda: None)
            agent = Mock(dialog={"call-id": ["id"]}, acked=True, bye_ok=True)
            clock = iter(index * 0.05 for index in range(10000))
            with patch.object(client, "RegistrationProbe", side_effect=probes), \
                    patch.object(client, "Agent", return_value=agent), \
                    patch.object(client.time, "monotonic", side_effect=lambda: next(clock)), \
                    patch.object(client.select, "select", return_value=([], [], [])):
                result = client.execute_answer("pbx", root)
            self.assertTrue(result["passed"])
            self.assertTrue(result["registrationPassed"])
            self.assertFalse(result["mediaPassed"])
            self.assertEqual([phase["phase"] for phase in result["phases"]], list(client.PHASES))
            agent.answer.assert_called_once()
            agent.hangup.assert_called_once()
            for probe in probes:
                self.assertEqual(probe.register.call_args_list[-1].args[-1], 0)
                probe.close.assert_called_once()
            self.assertEqual(probes[0].uri, "sip:queue-answer@pbx")
            self.assertEqual(result["agentPort"], 4001)

    def test_client_missing_host_ack_times_out_and_writes_failure_report(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "secret").write_text("a" * 64)
            (root / "agent-secret").write_text("b" * 64)
            probes = [Mock(ip="172.23.0.3", port=port, server=("172.23.0.2", 5060)) for port in (4000, 4001)]
            for probe in probes:
                probe.register.return_value = (200, {"contact": ["<sip:fixture@host>;expires=59"]}, "")
            clock = iter(range(1000))
            with patch.object(client, "RegistrationProbe", side_effect=probes), \
                    patch.object(client.time, "monotonic", side_effect=lambda: next(clock)), \
                    patch.object(client.select, "select", return_value=([], [], [])):
                with self.assertRaisesRegex(RuntimeError, "deadline"):
                    client.execute_answer("pbx", root)
            self.assertFalse(json.loads((root / "client-report.json").read_text())["passed"])
            for probe in probes:
                probe.close.assert_called_once()
                probe.invite.assert_not_called()


if __name__ == "__main__":
    unittest.main()
