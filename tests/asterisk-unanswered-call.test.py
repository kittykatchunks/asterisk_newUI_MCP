import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch


HERE = pathlib.Path(__file__).resolve().parents[1] / "local/asterisk-build"
sys.path.insert(0, str(HERE))
import runtime_unanswered_call as call


class UnansweredCallTests(unittest.TestCase):
    def response(self, members=0, callers=0):
        value = call.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"][0]["response"]
        value["objects"][1].update(memberCount=members, callerCount=callers, callerListEmpty=callers == 0)
        return json.dumps(value)

    def row(self, extension, leg, app, data):
        return f"Local/{extension}@{call.CONTEXT}-00000000;{leg}!{call.CONTEXT}!{extension}!2!Up!{app}!{data}!cid!acct!flags!time!bridge!unique\n"

    def test_member_never_answers_and_queue_timeout_is_explicit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            call.runtime.fixture(root)
            call.prepare(root)
            text = (root / "etc/extensions.conf").read_text()
            member = text.split("exten => member,")[1]
            self.assertIn("Ringing()", member)
            self.assertIn("Wait(20)", member)
            self.assertNotIn("Answer()", member)
            self.assertIn("Queue(proof-queue,r,,,3)", text)
            call.configure_queue(root)
            self.assertIn("[proof-queue]\ntimeoutpriority=app\n", (root / "etc/queues.conf").read_text())
            for forbidden in ["PJSIP/", "Dial(", "System(", "AGI("]:
                self.assertNotIn(forbidden, text)

    def exercise(self, defect=None):
        caller = self.row("start", 1, "Wait", "25") + self.row("start", 2, "Queue", "proof-queue")
        ringing = caller + self.row("member", 1, "AppQueue", "") + self.row("member", 2, "Wait", "20")
        if defect == "no-member":
            ringing = caller
        result = self.row("start", 1, "Wait", "25") + self.row("start", 2, "Wait", "5")
        repeated = defect == "repeat-result"
        snapshots = iter(["", ringing, result, *([result] if repeated else []), "", ""])
        policies = iter([self.response(), self.response(1),
                         self.response(1, 0 if defect == "no-queue" else 1),
                         self.response(1), *([self.response(1)] if repeated else []),
                         self.response(1), self.response()])
        commands = []

        def cli(text):
            commands.append(text)
            if text == "core show channels concise":
                return next(snapshots)
            if text.startswith("queue reload"):
                return ""
            if text.startswith("queue policy snapshot"):
                return next(policies)
            if text.startswith("queue add member"):
                return f"Added interface '{call.MEMBER}' to queue 'proof-queue'\n"
            if text.startswith("queue remove member"):
                return f"Removed interface {call.MEMBER} from queue 'proof-queue'\n"
            if text.startswith("channel originate"):
                return ""
            if text.startswith("core show channel "):
                return ("QUEUESTATUS=TIMEOUT\nQUEUEWAIT_MS=3000\nANSWEREDTIME_MS="
                        + ("1" if defect == "answered" else "0") + "\nABANDONED=TRUE\n")
            if text == "queue show proof-queue":
                return ("C:1" if defect == "completed" else "C:0") + ", A:1\nhas taken no calls\nNo Callers\n"
            raise AssertionError(text)

        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            call.runtime.fixture(root)
            progress = []
            clock = [0, 1, 4, 5, 9, 10] if repeated else [0, 1, 4, 9, 10]
            with patch.object(call.time, "monotonic", side_effect=clock), \
                    patch.object(call.time, "sleep"):
                outcome = call.execute(cli, root, progress)
                self.assertTrue(progress)
                self.assertTrue(any("resultChannelDetails" in item for item in progress))
                return outcome, commands

    def test_success_requires_attempt_timeout_no_completion_and_restoration(self):
        result, commands = self.exercise()
        self.assertTrue(result["passed"])
        self.assertEqual(result["resultVariables"]["ANSWEREDTIME_MS"], "0")
        self.assertEqual(result["resultVariables"]["QUEUESTATUS"], "TIMEOUT")
        self.assertEqual(result["resultVariables"]["QUEUEWAIT_MS"], "3000")
        self.assertEqual(len(result["channelNames"]), 4)
        self.assertEqual(result["unansweredMemberObservation"]["data"], "20")
        self.assertEqual(result["finalPolicy"], result["initialPolicy"])
        self.assertTrue(result["memberRemoved"])
        self.assertEqual(result["finalActiveChannels"], 0)
        self.assertIn("queue reload parameters proof-queue", commands)

    def test_missing_attempt_queue_entry_answer_or_completion_cannot_pass(self):
        for defect in ["no-member", "no-queue", "answered", "completed"]:
            with self.subTest(defect=defect), self.assertRaises(ValueError):
                self.exercise(defect)

    def test_validated_result_is_not_reread_while_channel_can_disappear(self):
        result, commands = self.exercise("repeat-result")
        self.assertTrue(result["passed"])
        self.assertEqual(sum(command.startswith("core show channel ") for command in commands), 1)

    def test_initial_channels_prevent_mutation(self):
        with patch.object(call.member_call, "channels", return_value=[{}]), \
                patch.object(call, "configure_queue") as configure:
            with self.assertRaisesRegex(ValueError, "zero initial"):
                call.execute(lambda text: "", pathlib.Path("unused"))
            configure.assert_not_called()

    def test_timeout_is_failure(self):
        def cli(text):
            if text.startswith("queue policy"):
                return self.response(1 if added else 0)
            if text.startswith("queue add"):
                return f"Added interface '{call.MEMBER}' to queue 'proof-queue'\n"
            return ""
        added = False

        def wrapped(text):
            nonlocal added
            result = cli(text)
            if text.startswith("queue add"):
                added = True
            return result
        with patch.object(call, "configure_queue"), \
                patch.object(call.time, "monotonic", side_effect=[0, 26]):
            with self.assertRaisesRegex(TimeoutError, "25 seconds"):
                call.execute(wrapped, pathlib.Path("unused"))

    def test_all_call_modes_are_mutually_exclusive(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("desktop_unanswered", HERE / "smoke-desktop.py")
        desktop = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(desktop)
        for other in ["local_call", "answer_call"]:
            with patch.object(desktop, "command") as command:
                with self.assertRaisesRegex(ValueError, "exactly one"):
                    desktop.smoke(pathlib.Path("unused"), unanswered_call=True, **{other: True})
                command.assert_not_called()


if __name__ == "__main__":
    unittest.main()
