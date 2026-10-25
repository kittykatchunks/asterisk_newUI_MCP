import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
HERE = ROOT / "local/asterisk-build"
sys.path[:0] = [str(HERE), str(ROOT / "tests")]
import runtime_sip_queue as queue
import sip_candidate_client as client


NAME = "PJSIP/proof-client-00000001"


def channel(application="Queue", data="proof-queue,r,,,3"):
    return "!".join([NAME, queue.CONTEXT, queue.EXTENSION, "2", "Up",
                     application, data, "", "", "", "", ""]) + "\n"


class SipQueueTests(unittest.TestCase):
    def test_private_fixture_has_only_queue_route_and_bounded_result_hold(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            queue.prepare(root)
            content = (root / "etc/extensions.conf").read_text()
            self.assertIn("exten => queue-timeout,1,Answer()", content)
            self.assertIn("Queue(proof-queue,r,,,3)", content)
            self.assertIn("Wait(10)", content)
            self.assertNotIn("Echo", content)
            self.assertNotIn("Dial(", content)
            self.assertEqual(content.count("exten =>"), 1)

    def test_single_sip_caller_and_context_arguments_are_strict(self):
        self.assertEqual(queue.channel(channel())["name"], NAME)
        self.assertEqual(queue.channel(channel("Wait", "10"))["application"], "Wait")
        for value in ("", channel() * 2, channel().replace("PJSIP/", "Local/"),
                      channel().replace("queue-timeout", "echo"),
                      channel().replace("proof-queue,r,,,3", "other,r,,,3"),
                      channel("Wait", "11"), channel("Hangup", "")):
            with self.assertRaises(ValueError):
                queue.channel(value)

    def run_observer(self, failure=None):
        baseline = queue.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        initial = next(row for row in baseline["objects"] if row["name"] == "proof-queue")
        step = 0
        result_queries = 0

        def cli(text):
            nonlocal step, result_queries
            if text == "core show channels concise":
                step += 1
                if failure == "missing-queued" or step > 1:
                    return channel("Wait", "10")
                return channel()
            if text.startswith("queue policy snapshot"):
                response = json.loads(json.dumps(baseline))
                proof = next(row for row in response["objects"] if row["name"] == "proof-queue")
                if step == 1 and failure != "missing-queued":
                    proof.update(callerCount=1, callerListEmpty=False)
                if failure == "retained-caller" and step > 1:
                    proof.update(callerCount=1, callerListEmpty=False)
                if failure == "changed-policy":
                    proof["memberCount"] = 1
                return json.dumps(response) + "\n"
            if text == "core show channel " + NAME:
                result_queries += 1
                return ("QUEUESTATUS=" + ("CONTINUE" if failure == "wrong-result" else "TIMEOUT") +
                        "\nQUEUEWAIT_MS=3000\nANSWEREDTIME_MS=0\nABANDONED=TRUE\n")
            raise AssertionError(text)

        with patch.object(queue.time, "sleep"):
            result = queue.observe(cli)
        self.assertEqual(result_queries, 1)
        self.assertEqual(result["resultPolicy"], initial)
        return result

    def test_observes_queued_caller_then_exact_timeout_variables_once(self):
        result = self.run_observer()
        self.assertTrue(result["passed"])
        self.assertFalse(result["mediaVerified"])
        self.assertEqual(result["queuedPolicy"]["callerCount"], 1)
        self.assertEqual(result["resultVariables"]["QUEUEWAIT_MS"], "3000")
        self.assertEqual(len(result["progress"]), 2)

    def test_missing_queue_observation_retained_caller_policy_or_wrong_result_fails(self):
        for failure in ("missing-queued", "retained-caller", "changed-policy", "wrong-result"):
            with self.subTest(failure=failure), self.assertRaises(ValueError):
                self.run_observer(failure)

    def test_observer_deadline_does_not_return_success(self):
        with patch.object(queue.time, "monotonic", side_effect=[0, 9]):
            with self.assertRaisesRegex(TimeoutError, "eight seconds"):
                queue.observe(Mock())

    def test_progress_is_retained_when_sample_budget_expires(self):
        baseline = queue.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        proof = next(row for row in baseline["objects"] if row["name"] == "proof-queue")
        proof.update(callerCount=1, callerListEmpty=False)
        progress = []

        def cli(text):
            return channel() if text == "core show channels concise" else json.dumps(baseline)

        with patch.object(queue.time, "monotonic", return_value=0), patch.object(queue.time, "sleep"):
            with self.assertRaisesRegex(ValueError, "64 samples"):
                queue.observe(cli, progress)
        self.assertEqual(len(progress), 64)
        self.assertEqual(progress[-1]["policy"]["callerCount"], 1)

    def test_client_queue_path_reuses_registration_ack_bye_without_claiming_echo(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "secret").write_text("a" * 64)
            for phase in client.QUEUE_PHASES:
                (root / f"{phase}.ack").touch()
            probe = Mock(ip="172.23.0.3", port=4000, server=("172.23.0.2", 5060))
            probe.register.side_effect = [
                (401, {}, ""), (200, {"contact": ["<sip:p@host>;expires=59"]}, ""), (200, {}, "")]
            sdp = "c=IN IP4 172.23.0.2\r\nm=audio 10000 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\n"
            probe.invite.return_value = (200, {}, sdp)
            wrong = Mock()
            wrong.invite.return_value = (401, {}, "")
            probe.echo.side_effect = lambda headers, body, verify: verify(None, None, "id", None)
            with patch.object(client, "RegistrationProbe", return_value=probe), \
                    patch.object(client, "Probe", return_value=wrong), \
                    patch.object(client, "verify_rtp_echo") as rtp:
                report = client.execute("pbx", root, queue_timeout=True)
            self.assertTrue(report["passed"])
            self.assertTrue(report["registrationPassed"])
            self.assertFalse(report["mediaPassed"])
            self.assertNotIn("rtp", report)
            self.assertFalse((root / "media-started.json").exists())
            self.assertEqual([item["phase"] for item in report["phases"]], list(client.QUEUE_PHASES))
            self.assertEqual(probe.uri, "sip:queue-timeout@pbx")
            self.assertEqual(wrong.uri, probe.uri)
            rtp.assert_not_called()
            self.assertEqual(probe.register.call_args_list[-1].args[-1], 0)
            probe.close.assert_called_once()

    def test_result_wait_threshold_edges_reuse_original_validator(self):
        for wait in (2999, 3000, 3999, 4000):
            detail = f"QUEUESTATUS=TIMEOUT\nQUEUEWAIT_MS={wait}\nANSWEREDTIME_MS=0\nABANDONED=TRUE\n"
            if 3000 <= wait < 4000:
                self.assertEqual(queue.local_call.result_variables(detail)["QUEUEWAIT_MS"], str(wait))
            else:
                with self.assertRaises(ValueError):
                    queue.local_call.result_variables(detail)


if __name__ == "__main__":
    unittest.main()
