import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
HERE = ROOT / "local/asterisk-build"
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("desktop_smoke", HERE / "smoke-desktop.py")
desktop = importlib.util.module_from_spec(spec)
spec.loader.exec_module(desktop)


class DesktopSmokeTests(unittest.TestCase):
    def test_isolated_launch_flags_no_pull_ports_or_privileged(self):
        args = desktop.arguments("sha256:" + "a" * 64, "owned", "token", pathlib.Path("fixture"))
        for flag in ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
                     "--security-opt=no-new-privileges:true", "--pids-limit=256",
                     "--cpus=4", "--memory=4g", "--memory-swap=4g", "--ulimit=core=0",
                     "--user=10001:10001", "--restart=no"]:
            self.assertIn(flag, args)
        self.assertNotIn("--privileged", args)
        self.assertNotIn("-p", args)
        self.assertIn("org.asterisk.local.smoke-owner=token", args)
        self.assertIn("--log-opt=compress=false", args)
        self.assertIn("/state:rw,noexec,nosuid,size=67108864,uid=10001,gid=10001,mode=0700", args)

    def test_cli_does_not_filter_diagnostics_or_allow_excess_output(self):
        with patch.object(desktop, "command", return_value=('{"status":"observed"}\n', "")) as command:
            self.assertEqual(desktop.cli("owned", "query", []), '{"status":"observed"}\n')
            self.assertEqual(command.call_args.args[0][-3:], ["/fixture/asterisk.conf", "-rx", "query"])
        diagnostics = []
        with patch.object(desktop, "command", return_value=("", "unexpected warning")):
            with self.assertRaisesRegex(ValueError, "stderr"):
                desktop.cli("owned", "query", diagnostics)
        self.assertEqual(len(diagnostics), 1)
        with patch.object(desktop, "command", return_value=("x" * 8193, "")):
            with self.assertRaisesRegex(ValueError, "8192"):
                desktop.cli("owned", "query", [])
        with patch.object(desktop, "command", return_value=("x" * 8192, "")):
            self.assertEqual(len(desktop.cli("owned", "query", [])), 8192)

    def test_requires_explicit_approval(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "smoke-desktop.py"),
                                 "--work-dir", "not-created"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--approve-desktop-image-smoke", result.stderr)

    def test_evidence_mismatch_fails_before_any_container_or_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory) / "not-created"
            with patch.object(desktop.runtime, "digest", return_value="wrong"), \
                    patch.object(desktop, "command") as command:
                with self.assertRaisesRegex(ValueError, "hash mismatch"):
                    desktop.smoke(root)
                command.assert_not_called()
                self.assertFalse(root.exists())

    def test_exact_known_eid_notice_is_preserved_not_general_warning_filtering(self):
        notice = ("No ethernet interface found for seeding global EID. "
                  "You will have to set it manually.\n")
        diagnostics = []
        with patch.object(desktop, "command", return_value=(notice + '{"ok":true}\n', "")):
            self.assertEqual(desktop.cli("owned", "query", diagnostics), '{"ok":true}\n')
        self.assertEqual(diagnostics, [dict(command="query", stream="stdout", text=notice)])
        with patch.object(desktop, "command", return_value=("unknown warning\n{}\n", "")):
            self.assertEqual(desktop.cli("owned", "query", []), "unknown warning\n{}\n")

    def test_docker_errors_retain_actual_stderr(self):
        result = subprocess.CompletedProcess([], 125, b"container-id", b"real daemon failure")
        with patch.object(desktop.subprocess, "run", return_value=result):
            with self.assertRaisesRegex(RuntimeError, "real daemon failure"):
                desktop.command(["run"])

    def test_mocked_full_smoke_failure_and_ownership_safe_cleanup(self):
        for failure in [None, "local-call", "answer-call", "unanswered-call",
                        "limits", "startup", "modules", "stop", "ownership"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "run"
                calls = []
                identity = {"Id": "b" * 64, "Config": {"Labels": {}}}
                build = desktop.runtime.read_json(HERE / "image-build-validation-nss.json")
                image = build["imageId"]
                observations = iter(desktop.runtime.read_json(HERE / "runtime-bundle-smoke-report.json")["observations"])
                stopped = False

                def fake_command(args, **kwargs):
                    nonlocal stopped
                    calls.append(args)
                    if args[:2] == ["image", "inspect"]:
                        return json.dumps([dict(Id=image, Config=dict(
                            Entrypoint=desktop.runtime.ENTRYPOINT, Cmd=desktop.runtime.COMMAND))]), ""
                    if args[0] == "run":
                        identity["Name"] = "/" + args[args.index("--name") + 1]
                        identity["Config"]["Labels"] = {
                            "org.asterisk.local.smoke-owner": args[args.index("--label") + 1].split("=")[1]}
                        identity["HostConfig"] = dict(
                            NetworkMode="none", ReadonlyRootfs=True, Privileged=False,
                            Memory=4294967296, MemorySwap=4294967296,
                            NanoCpus=4000000000, PidsLimit=256,
                            PortBindings={}, CapDrop=["ALL"], SecurityOpt=["no-new-privileges:true"])
                        identity["State"] = {"Status": "running"}
                        if failure == "limits":
                            identity["HostConfig"]["MemorySwap"] = -1
                        return identity["Id"], ""
                    if args[0] == "inspect":
                        if "--format" in args:
                            return json.dumps(dict(Running=not stopped and failure != "startup",
                                                   OOMKilled=False)), ""
                        inspected = json.loads(json.dumps(identity))
                        if failure == "ownership":
                            inspected["Name"] = "/someone-else"
                        return json.dumps([inspected]), ""
                    if args[0] == "ps":
                        return identity["Id"], ""
                    if args[0] == "logs":
                        return "fixture logs", ""
                    if args[0] == "stop":
                        stopped = True
                        return identity["Id"], ""
                    if args[0] == "wait":
                        return ("137" if failure == "stop" else "0"), ""
                    if args[0] == "rm":
                        self.assertEqual(args, ["rm", "--force", identity["Id"]])
                        return identity["Id"], ""
                    raise AssertionError(f"Unexpected command {args}")

                def fake_cli(container, command, diagnostics):
                    if command == "core waitfullybooted":
                        return "Asterisk has fully booted.\n"
                    if command == "module show":
                        return "" if failure == "modules" else "\n".join(
                            f"{name} fixture 0 Running core"
                            for name in desktop.runtime.module_links(desktop.runtime.manifest()))
                    if command.startswith("pjsip show"):
                        return "No objects found.\n"
                    if command == "core show help test execute":
                        return "No such command"
                    if command.startswith("queue policy snapshot"):
                        return json.dumps(next(observations)["response"]) + "\n"
                    if command.startswith("queue reload"):
                        return ""
                    raise AssertionError(f"Unexpected CLI {command}")

                with patch.object(desktop, "command", side_effect=fake_command), \
                        patch.object(desktop, "cli", side_effect=fake_cli), \
                        patch.object(desktop.runtime_local_call, "execute", return_value={"passed": True}) as local_call, \
                        patch.object(desktop.runtime_answer_call, "execute", return_value={"passed": True}) as answer_call, \
                        patch.object(desktop.runtime_unanswered_call, "execute", return_value={"passed": True}) as unanswered_call, \
                        patch.object(desktop.threading, "Timer") as timer:
                    if failure not in (None, "local-call", "answer-call", "unanswered-call"):
                        with self.assertRaises((ValueError, RuntimeError)):
                            desktop.smoke(root)
                    else:
                        report = desktop.smoke(root, local_call=failure == "local-call",
                                               answer_call=failure == "answer-call",
                                               unanswered_call=failure == "unanswered-call")
                        self.assertTrue(report["passed"])
                        self.assertEqual(len(report["observations"]), 5)
                        self.assertTrue(report["ownedContainerRemoved"])
                        self.assertEqual(report["processExitCode"], 0)
                        self.assertEqual(report["callsOrMediaTested"],
                                         failure in ("local-call", "answer-call", "unanswered-call"))
                        if failure == "local-call":
                            self.assertEqual(report["syntheticLocalCall"], {"passed": True})
                            local_call.assert_called_once()
                            self.assertIn("Queue(proof-queue,r,,,3)",
                                          (root / "etc/extensions.conf").read_text())
                        else:
                            local_call.assert_not_called()
                        if failure == "answer-call":
                            self.assertEqual(report["syntheticAnsweredCall"], {"passed": True})
                            answer_call.assert_called_once()
                            self.assertIn("Queue(proof-queue,rc,,,12)",
                                          (root / "etc/extensions.conf").read_text())
                        else:
                            answer_call.assert_not_called()
                        if failure == "unanswered-call":
                            self.assertEqual(report["syntheticUnansweredCall"], {"passed": True})
                            unanswered_call.assert_called_once()
                            self.assertIn("Ringing()", (root / "etc/extensions.conf").read_text())
                            self.assertEqual(report["syntheticUnansweredProgress"], [])
                        else:
                            unanswered_call.assert_not_called()
                    self.assertEqual(timer.call_args.args[0], 300)
                    timer.return_value.start.assert_called_once()
                    timer.return_value.cancel.assert_called_once()
                    timer.return_value.join.assert_called_once()
                report = desktop.runtime.read_json(root / "desktop-smoke-report.json")
                self.assertEqual(report["passed"], failure in (None, "local-call", "answer-call", "unanswered-call"))
                removals = [args for args in calls if args[0] == "rm"]
                self.assertEqual(len(removals), 0 if failure == "ownership" else 1)
                config = (root / "etc/asterisk.conf").read_text()
                self.assertIn("astrundir => /state\n", config)
                self.assertIn("astkeydir => /fixture/keys\n", config)
                self.assertTrue((root / "etc/keys/keys").is_dir())


if __name__ == "__main__":
    unittest.main()
