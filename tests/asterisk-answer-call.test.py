import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parents[1] / "local/asterisk-build"
sys.path.insert(0, str(HERE))
import runtime_answer_call as call


class AnswerCallTests(unittest.TestCase):
    def response(self, members=0, callers=0):
        value = call.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        value["objects"][1].update(memberCount=members, callerCount=callers, callerListEmpty=callers == 0)
        return json.dumps(value)

    def row(self, extension, leg, app, data):
        return f"Local/{extension}@{call.CONTEXT}-00000000;{leg}!{call.CONTEXT}!{extension}!2!Up!{app}!{data}!cid!acct!flags!time!bridge!unique\n"

    def test_fixture_bounds_and_continuation_after_member_hangup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            (root / "etc").mkdir()
            call.prepare(root)
            text = (root / "etc/extensions.conf").read_text()
            for value in ["Queue(proof-queue,rc,,,12)", "Wait(2)", "Answer()", "Wait(4)", "Wait(5)"]:
                self.assertIn(value, text)
            for forbidden in ["PJSIP/", "System(", "AGI(", "Dial(", "include"]:
                self.assertNotIn(forbidden, text)

    def test_exact_answer_duration_thresholds_status_and_dialed_time(self):
        for milliseconds in [3500, 4000, 6999]:
            result = call.result_variables(
                f"QUEUESTATUS=CONTINUE\nANSWEREDTIME_MS={milliseconds}\nDIALEDTIME_MS=9000\n")
            self.assertEqual(int(result["ANSWEREDTIME_MS"]), milliseconds)
        valid = "QUEUESTATUS=CONTINUE\nANSWEREDTIME_MS=4000\nDIALEDTIME_MS=6000\n"
        for invalid in [
            valid.replace("4000", "3499"), valid.replace("4000", "7000"),
            valid.replace("CONTINUE", "TIMEOUT"), valid.replace("6000", "3000"),
            valid.replace("4000", "unknown"), valid + "QUEUESTATUS=CONTINUE\n",
        ]:
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                call.result_variables(invalid)

    def test_policy_exact_members_and_caller_list(self):
        self.assertEqual(call.policy(self.response(1, 1), 1)["callerCount"], 1)
        with self.assertRaises(ValueError):
            call.policy(self.response(0), 1)
        value = json.loads(self.response(1, 1))
        value["objects"][1]["callerListEmpty"] = True
        with self.assertRaises(ValueError):
            call.policy(json.dumps(value), 1)
        with self.assertRaises(ValueError):
            call.policy(self.response() + "\n{}", 0)

    def test_only_private_caller_and_member_channels(self):
        self.assertEqual(len(call.channels(self.row("start", 1, "Wait", "25")
                                           + self.row("member", 2, "Wait", "4"))), 2)
        for value in ["bad", "PJSIP/foreign!a!b!c!d!e!f!g!h!i!j!k\n"]:
            with self.assertRaises(ValueError):
                call.channels(value)

    def exercise(self, defect=None):
        initial = self.row("start", 1, "Wait", "25") + self.row("start", 2, "Queue", "proof-queue")
        ringing = initial + self.row("member", 1, "AppQueue", "") + self.row("member", 2, "Wait", "2")
        answered = initial + self.row("member", 1, "AppQueue", "") + self.row("member", 2, "Wait", "4")
        result = self.row("start", 1, "Wait", "25") + self.row("start", 2, "Wait", "5")
        snapshots = iter(["", ringing, answered, result, "", ""])
        policies = iter([self.response(), self.response(1), self.response(1, 1),
                         self.response(1), self.response(1), self.response(1), self.response()])
        commands = []

        def cli(text):
            commands.append(text)
            if text == "core show channels concise":
                return next(snapshots)
            if text.startswith("queue policy snapshot"):
                return next(policies)
            if text.startswith("queue add member"):
                return f"Added interface '{call.MEMBER}' to queue 'proof-queue'\n"
            if text.startswith("queue remove member"):
                return f"Removed interface {call.MEMBER} from queue 'proof-queue'\n"
            if text.startswith("channel originate"):
                return ""
            if text.startswith("core show channel "):
                return "QUEUESTATUS=CONTINUE\nANSWEREDTIME_MS=4000\nDIALEDTIME_MS=6000\n"
            if text == "queue show proof-queue":
                return ("C:0" if defect == "completion" else "C:1") + "\nNo Callers\n"
            raise AssertionError(text)

        with patch.object(call.time, "monotonic", side_effect=[0, 1, 3, 7, 12, 13]), \
                patch.object(call.time, "sleep"):
            return call.execute(cli), commands

    def test_success_proves_four_legs_answer_completed_call_and_member_removal(self):
        result, commands = self.exercise()
        self.assertTrue(result["passed"])
        self.assertEqual(len(result["channelNames"]), 4)
        self.assertEqual(result["resultVariables"]["QUEUESTATUS"], "CONTINUE")
        self.assertEqual(result["resultVariables"]["ANSWEREDTIME_MS"], "4000")
        self.assertTrue(result["memberRemoved"])
        self.assertEqual(result["finalPolicy"], result["initialPolicy"])
        self.assertEqual(result["finalActiveChannels"], 0)
        self.assertTrue(any(command.startswith("queue remove member") for command in commands))

    def test_missing_completed_call_fails(self):
        with self.assertRaisesRegex(ValueError, "completed"):
            self.exercise("completion")

    def test_initial_channels_prevent_queue_mutation(self):
        commands = []
        with patch.object(call, "channels", return_value=[{}]):
            with self.assertRaisesRegex(ValueError, "zero initial"):
                call.execute(lambda text: commands.append(text) or "")
        self.assertEqual(commands, ["core show channels concise"])

    def test_absolute_deadline_cannot_pass(self):
        def cli(text):
            if text == "core show channels concise":
                return ""
            if text.startswith("queue policy snapshot"):
                return self.response(1 if added else 0)
            if text.startswith("queue add member"):
                return f"Added interface '{call.MEMBER}' to queue 'proof-queue'\n"
            return ""
        added = False

        def wrapped(text):
            nonlocal added
            value = cli(text)
            if text.startswith("queue add member"):
                added = True
            return value
        with patch.object(call.time, "monotonic", side_effect=[0, 26]):
            with self.assertRaisesRegex(TimeoutError, "25 seconds"):
                call.execute(wrapped)

    def test_mutually_exclusive_call_modes_fail_before_docker(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("desktop_answer", HERE / "smoke-desktop.py")
        desktop = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(desktop)
        with patch.object(desktop, "command") as command:
            with self.assertRaisesRegex(ValueError, "exactly one"):
                desktop.smoke(pathlib.Path("not-created"), local_call=True, answer_call=True)
            command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
