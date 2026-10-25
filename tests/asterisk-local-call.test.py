import copy
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parents[1] / "local/asterisk-build"
sys.path.insert(0, str(HERE))
import runtime_local_call as call


class LocalCallTests(unittest.TestCase):
    def response(self, count=0):
        value = copy.deepcopy(call.runtime.read_json(
            HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"])
        value["objects"][1].update(callerCount=count, callerListEmpty=count == 0)
        return json.dumps(value) + "\n"

    def test_private_bounded_dialplan_no_sip_shell_or_external_destination(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            call.prepare(root)
            text = (root / "etc/extensions.conf").read_text()
            self.assertIn(f"[{call.CONTEXT}]", text)
            self.assertIn("Queue(proof-queue,r,,,3)", text)
            self.assertIn("Wait(5)", text)
            self.assertIn("Hangup()", text)
            for forbidden in ["PJSIP/", "System(", "AGI(", "Dial(", "include"]:
                self.assertNotIn(forbidden, text)

    def test_policy_preserves_static_fields_and_exact_dynamic_state(self):
        self.assertEqual(call.policy(self.response())["callerCount"], 0)
        self.assertEqual(call.policy(self.response(1))["callerCount"], 1)
        for change in ["count", "list", "strategy", "envelope", "extra", "boolean"]:
            value = json.loads(self.response(1))
            if change == "count":
                value["objects"][1]["callerCount"] = 2
            elif change == "list":
                value["objects"][1]["callerListEmpty"] = True
            elif change == "strategy":
                value["objects"][1]["strategy"] = "linear"
            elif change == "envelope":
                value["status"] = "unknown"
            elif change == "extra":
                value["objects"].append(value["objects"][1])
            else:
                value["objects"][1]["callerCount"] = True
            with self.subTest(change=change), self.assertRaises(ValueError):
                call.policy(json.dumps(value))
        with self.assertRaisesRegex(ValueError, "bounded"):
            call.policy(self.response() + "\n{}\n")

    def row(self, leg, application):
        return f"Local/start@{call.CONTEXT}-00000000;{leg}!{call.CONTEXT}!start!2!Up!{application}!data!cid!acct!flags!time!bridge!unique\n"

    def test_channel_parser_rejects_foreign_or_malformed_channels(self):
        self.assertEqual(call.channels(""), [])
        self.assertEqual(call.channels(self.row(2, "Queue"))[0]["application"], "Queue")
        for output in ["bad row", "PJSIP/foreign!c!e!1!Up!Wait!data!!!!!\n"]:
            with self.assertRaises(ValueError):
                call.channels(output)

    def execute_fixture(self, defect=None):
        snapshots = iter([
            "", self.row(1, "Wait") + self.row(2, "Queue"),
            self.row(1, "Wait") + self.row(2, "Wait"), "",
        ])
        policies = iter([self.response(), self.response(0 if defect == "unobserved" else 1),
                         self.response(), self.response()])
        commands = []

        def cli(text):
            commands.append(text)
            if text == "core show channels concise":
                return next(snapshots)
            if text.startswith("queue policy snapshot"):
                return next(policies)
            if text.startswith("channel originate"):
                return ""
            if text.startswith("core show channel "):
                return ("Variables:\n  QUEUESTATUS=" + ("FULL" if defect == "status" else "TIMEOUT")
                        + "\nQUEUEWAIT_MS=3000\nANSWEREDTIME_MS=0\nABANDONED=TRUE\n")
            raise AssertionError(text)

        with patch.object(call.time, "monotonic", side_effect=[0, 0, 1, 1, 4, 9, 9]), \
                patch.object(call.time, "sleep"):
            result = call.execute(cli)
        return result, commands

    def test_observes_queue_entry_timeout_both_legs_and_cleanup(self):
        result, commands = self.execute_fixture()
        self.assertTrue(result["passed"])
        self.assertEqual(result["queueStatus"], "TIMEOUT")
        self.assertEqual(result["queuedObservation"]["policy"]["callerCount"], 1)
        self.assertEqual(result["finalActiveChannels"], 0)
        self.assertEqual(result["finalPolicy"]["callerCount"], 0)
        self.assertEqual(len(result["channelNames"]), 2)
        self.assertIn(f"channel originate Local/start@{call.CONTEXT}/n application Wait 20", commands)
        self.assertFalse(result["mediaTested"])
        self.assertFalse(result["sipTested"])

    def test_unobserved_queue_entry_or_wrong_status_cannot_pass(self):
        for defect in ["unobserved", "status"]:
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.execute_fixture(defect)

    def test_existing_channel_prevents_origination(self):
        with patch.object(call, "channels", return_value=[{"name": "existing"}]):
            commands = []
            with self.assertRaisesRegex(ValueError, "zero initial"):
                call.execute(lambda text: commands.append(text) or "")
            self.assertEqual(commands, ["core show channels concise"])

    def test_absolute_deadline_is_failure_not_success(self):
        def cli(text):
            if text.startswith("queue policy snapshot"):
                return self.response()
            return ""
        with patch.object(call.time, "monotonic", side_effect=[0, 26]):
            with self.assertRaisesRegex(TimeoutError, "25 seconds"):
                call.execute(cli)

    def test_exact_queue_timeout_threshold_and_no_answer(self):
        valid = "QUEUESTATUS=TIMEOUT\nQUEUEWAIT_MS=3000\nANSWEREDTIME_MS=0\nABANDONED=TRUE\n"
        self.assertEqual(call.result_variables(valid)["QUEUEWAIT_MS"], "3000")
        self.assertEqual(call.result_variables(valid.replace("3000", "3999"))["QUEUEWAIT_MS"], "3999")
        for invalid in [
            valid.replace("3000", "2999"), valid.replace("3000", "4000"),
            valid.replace("3000", "unknown"), valid.replace("ANSWEREDTIME_MS=0", "ANSWEREDTIME_MS=1"),
            valid.replace("ABANDONED=TRUE", "ABANDONED=FALSE"), valid + "QUEUESTATUS=TIMEOUT\n",
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                call.result_variables(invalid)


if __name__ == "__main__":
    unittest.main()
