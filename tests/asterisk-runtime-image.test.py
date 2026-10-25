import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "local/asterisk-build/runtime_image.py"
spec = importlib.util.spec_from_file_location("runtime_image", SCRIPT)
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeImageTests(unittest.TestCase):
    def test_reviewed_manifest_binding_and_module_aliases(self):
        record = runtime.manifest()
        links = runtime.module_links(record)
        plan = runtime.read_json(runtime.HERE / "module-plan.json")
        self.assertEqual(len(links), 41)
        self.assertEqual(set(links), {name + ".so" for name in plan["requestedModules"]})
        self.assertTrue(all(target.startswith("/opt/asterisk/") for target in links.values()))
        self.assertFalse(any(name.startswith("test_") for name in links))
        preparation = runtime.read_json(ROOT / "local/asterisk-patches/build-preparation.json")["containerPreparation"]
        self.assertEqual(preparation["bundleManifestSha256"], runtime.MANIFEST_SHA256)
        for flag in ["realBuildContextPrepared", "imageBuildAuthorized", "imageBuilt",
                     "imageSmokeAuthorized", "imageSmokeExecuted", "hostExported",
                     "redistributionApproved", "licenseClosureComplete", "runtimeApplyAuthorized"]:
            self.assertIs(preparation[flag], False, flag)

    def test_recipe_is_scratch_no_network_install_or_shell(self):
        recipe = (runtime.HERE / "runtime.Dockerfile").read_text()
        lines = recipe.splitlines()
        self.assertEqual(lines[0], "FROM scratch")
        self.assertFalse(any(line.startswith(("RUN ", "ADD ", "EXPOSE ", "VOLUME ", "HEALTHCHECK "))
                             for line in lines))
        entrypoint = json.loads(next(line[11:] for line in lines if line.startswith("ENTRYPOINT ")))
        command = json.loads(next(line[4:] for line in lines if line.startswith("CMD ")))
        self.assertEqual(entrypoint, runtime.ENTRYPOINT)
        self.assertEqual(command, runtime.COMMAND)
        self.assertIn("USER 10001:10001", lines)
        self.assertIn(runtime.MANIFEST_SHA256, recipe)
        self.assertIn("ENV LOCPATH=/opt/asterisk/runtime-locale", lines)
        self.assertIn("ENV GCONV_PATH=/opt/asterisk/runtime-gconv", lines)
        self.assertEqual(sum(line.startswith("COPY ") for line in lines), 2)

    def synthetic_bundle(self, root):
        payload = root / "main"
        payload.mkdir()
        binary = payload / "asterisk"
        binary.write_bytes(b"synthetic fixture, not an executable")
        record = dict(entries=[dict(path="main/asterisk", bytes=binary.stat().st_size,
                                   mode=oct(binary.stat().st_mode & 0o777),
                                   sha256=runtime.digest(binary))])
        manifest = root / "bundle-manifest.json"
        manifest.write_text(json.dumps(record))
        return record, runtime.digest(manifest)

    def test_exact_bundle_inventory_hash_size_mode_and_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            record, expected = self.synthetic_bundle(root)
            with patch.object(runtime, "manifest", return_value=record), \
                    patch.object(runtime, "MANIFEST_SHA256", expected):
                self.assertEqual(runtime.verify_bundle(root), record)
                for change in ["sha256", "bytes", "mode"]:
                    original = record["entries"][0][change]
                    record["entries"][0][change] = {"sha256": "0" * 64, "bytes": 0, "mode": "0o000"}[change]
                    with self.subTest(change=change), self.assertRaisesRegex(ValueError, "mismatch"):
                        runtime.verify_bundle(root)
                    record["entries"][0][change] = original
                (root / "extra").write_text("unexpected")
                with self.assertRaisesRegex(ValueError, "inventory"):
                    runtime.verify_bundle(root)
                (root / "extra").unlink()
                (root / "bundle-manifest.json").write_text("{}")
                with self.assertRaisesRegex(ValueError, "manifest mismatch"):
                    runtime.verify_bundle(root)

    def test_manifest_rejects_traversal_and_duplicates(self):
        for entries in [[{"path": "../outside"}], [{"path": "/outside"}],
                        [{"path": "main/a"}, {"path": "main/a"}]]:
            with patch.object(runtime, "manifest", return_value={"entries": entries}):
                with self.subTest(entries=entries), self.assertRaisesRegex(ValueError, "Invalid or duplicate"):
                    runtime.verify_bundle(pathlib.Path("not-read"))

    def test_payload_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            path = root / "binary"
            path.write_text("fixture")
            with patch.object(pathlib.Path, "is_symlink", return_value=True):
                with self.assertRaisesRegex(ValueError, "symlink"):
                    runtime.inventory(root)

    def test_fixture_has_no_listeners_and_private_paths(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            runtime.fixture(root)
            etc = root / "etc"
            self.assertEqual((etc / "pjsip.conf").read_text(), "")
            for filename in ["manager.conf", "http.conf"]:
                self.assertIn("enabled=no", (etc / filename).read_text())
            self.assertIn("astmoddir => /opt/asterisk/modules", (etc / "asterisk.conf").read_text())
            self.assertIn("astrundir => /state/run", (etc / "asterisk.conf").read_text())
            modules = (etc / "modules.conf").read_text().splitlines()
            self.assertIn("autoload=no", modules)
            self.assertEqual(sum(line.startswith("require=") for line in modules), 41)
            self.assertTrue((root / "state/keys/keys").is_dir())
            runtime.write_queues(etc, 23, "linear")
            self.assertIn("strategy=linear\ntimeout=23", (etc / "queues.conf").read_text())
            self.assertIn("[unrelated-queue]", (etc / "queues.conf").read_text())

    def module_output(self):
        return "\n".join(f"{name} fixture 0 Running core" for name in runtime.module_links(runtime.manifest()))

    def test_exact_running_modules_no_missing_extra_duplicates_or_declines(self):
        output = self.module_output()
        self.assertEqual(len(runtime.check_modules(output)), 41)
        for invalid in [
            "\n".join(output.splitlines()[1:]),
            output + "\nunknown.so fixture 0 Running core",
            output + "\n" + output.splitlines()[0],
            output.replace("Running", "Not Running", 1),
        ]:
            with self.subTest(invalid=invalid[:60]), self.assertRaisesRegex(ValueError, "41 Running"):
                runtime.check_modules(invalid)

    def test_docker_launch_is_bounded_isolated_and_never_builds_or_pulls(self):
        with patch.object(os, "getuid", return_value=1234, create=True), \
                patch.object(os, "getgid", return_value=5678, create=True):
            args = runtime.run_arguments("sha256:" + "a" * 64, "owned", pathlib.Path("/short"), "token")
        for flag in ["--pull=never", "--network=none", "--read-only", "--cap-drop=ALL",
                     "--security-opt=no-new-privileges:true", "--pids-limit=256", "--cpus=4",
                     "--memory=4g", "--memory-swap=4g", "--ulimit=core=0", "--restart=no"]:
            self.assertIn(flag, args)
        self.assertNotIn("build", args)
        self.assertNotIn("--privileged", args)
        self.assertIn("1234:5678", args)
        self.assertIn("org.asterisk.local.smoke-owner=token", args)
        self.assertIn(f"type=bind,src={pathlib.Path('/short') / 'etc'},dst=/fixture,readonly", args)

    def test_opt_in_commands_refuse_missing_approval_before_any_work(self):
        for command in [
            ["prepare", "--bundle", "not-read", "--output", "not-created"],
            ["smoke", "--image", "not-run", "--work-dir", "not-created"],
        ]:
            result = subprocess.run([sys.executable, str(SCRIPT), *command], capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("--approve-", result.stderr)

    def test_smoke_refuses_tag_before_any_docker_call(self):
        with patch.object(runtime.sys, "platform", "linux"), \
                patch.object(os, "geteuid", return_value=10001, create=True), \
                patch.object(runtime, "docker") as docker:
            with self.assertRaisesRegex(ValueError, "immutable"):
                runtime.smoke("latest", pathlib.Path("/short"))
            docker.assert_not_called()

    def test_prepare_refuses_overlapping_paths_before_copy(self):
        with patch.object(runtime.sys, "platform", "linux"), \
                patch.object(runtime, "verify_bundle"), patch.object(runtime.shutil, "copytree") as copy:
            for bundle, output in [("/same", "/same"), ("/same", "/same/context"), ("/same/bundle", "/same")]:
                with self.assertRaisesRegex(ValueError, "overlap"):
                    runtime.prepare(pathlib.Path(bundle), pathlib.Path(output))
            copy.assert_not_called()

    def test_synthetic_context_round_trip_and_tamper_detection(self):
        with tempfile.TemporaryDirectory() as directory:
            source = pathlib.Path(directory) / "source"
            output = pathlib.Path(directory) / "context"
            source.mkdir()
            record, _ = self.synthetic_bundle(source)
            (source / "apps").mkdir()
            for index in range(41):
                path = source / f"apps/module_{index}.so"
                path.write_bytes(b"synthetic module")
                record["entries"].append(dict(
                    path=path.relative_to(source).as_posix(), bytes=path.stat().st_size,
                    mode=oct(path.stat().st_mode & 0o777), sha256=runtime.digest(path)))
            (source / "bundle-manifest.json").write_text(json.dumps(record))
            expected = runtime.digest(source / "bundle-manifest.json")
            original_is_symlink = pathlib.Path.is_symlink

            # Model Linux aliases on Windows without requiring symlink privileges.
            def is_alias(path):
                return path.parent == output / "modules" or original_is_symlink(path)

            def make_alias(path, target):
                path.write_text(target)

            with patch.object(runtime.sys, "platform", "linux"), \
                    patch.object(runtime, "manifest", return_value=record), \
                    patch.object(runtime, "MANIFEST_SHA256", expected), \
                    patch.object(pathlib.Path, "symlink_to", make_alias), \
                    patch.object(pathlib.Path, "is_symlink", is_alias), \
                    patch.object(os, "readlink", side_effect=lambda path: path.read_text()), \
                    patch.object(runtime, "docker") as docker:
                prepared = runtime.prepare(source, output)
                self.assertFalse(prepared["imageBuilt"])
                self.assertEqual(runtime.verify_context(output), record)
                with self.assertRaises(FileExistsError):
                    runtime.prepare(source, output)
                (output / "Dockerfile").write_text("FROM unexpected")
                with self.assertRaisesRegex(ValueError, "Dockerfile"):
                    runtime.verify_context(output)
                shutil_source = runtime.HERE / "runtime.Dockerfile"
                (output / "Dockerfile").write_bytes(shutil_source.read_bytes())
                (output / "modules/module_0.so").write_text("/outside")
                with self.assertRaisesRegex(ValueError, "alias"):
                    runtime.verify_context(output)
                (output / "modules/module_0.so").write_text("/opt/asterisk/apps/module_0.so")
                (output / ".dockerignore").write_text("")
                with self.assertRaisesRegex(ValueError, "allowlist"):
                    runtime.verify_context(output)
                (output / ".dockerignore").write_bytes(b"*\n!Dockerfile\n!bundle/\n!bundle/**\n!modules/\n!modules/**\n")
                prepared["imageBuilt"] = True
                (output / "preparation.json").write_text(json.dumps(prepared))
                with self.assertRaisesRegex(ValueError, "authority"):
                    runtime.verify_context(output)
                docker.assert_not_called()

    def test_cli_socket_protocol_pid_bounds_and_truncation(self):
        class Connection:
            def __init__(self, greeting, payload):
                self.greeting = bytearray(greeting)
                self.payload = bytearray(payload)
                self.sent = None

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def settimeout(self, timeout):
                pass

            def connect(self, path):
                pass

            def sendall(self, data):
                self.sent = data

            def recv(self, count):
                source = self.payload if self.sent else self.greeting
                chunk = bytes(source[:count])
                del source[:count]
                return chunk

        for greeting, payload, error in [
            (b"fixture/1/22.11.0\n", b"ok\n", None),
            (b"fixture/1/22.11.0\n", b"x" * 8192, None),
            (b"fixture/23/22.11.0\n", b"ok\n", "PID 1"),
            (b"fixture/1/", b"", "Truncated"),
            (b"fixture/1/22.11.0\n", b"x" * 8193, "8192"),
        ]:
            connection = Connection(greeting, payload)
            with self.subTest(error=error), \
                    patch.object(runtime.socket, "AF_UNIX", 1, create=True), \
                    patch.object(runtime.socket, "socket", return_value=connection):
                if error:
                    with self.assertRaisesRegex(ValueError, error):
                        runtime.cli(pathlib.Path("unused"), "core waitfullybooted")
                else:
                    self.assertEqual(runtime.cli(pathlib.Path("unused"), "core waitfullybooted"),
                                     payload.decode())
                    self.assertEqual(connection.sent, b"cli quit after core waitfullybooted\0")

    def test_mocked_smoke_success_failure_timeout_and_owned_cleanup(self):
        image = "sha256:" + "a" * 64
        for failure in [None, "modules", "launch-timeout", "ownership", "limits"]:
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory) / "run"
                calls = []
                identity = {"Id": "b" * 64, "Config": {"Labels": {}}}
                expected = runtime.read_json(runtime.HERE / "runtime-bundle-smoke-report.json")["observations"]
                observations = iter(expected)

                def fake_docker(args, **kwargs):
                    calls.append(args)
                    if args[0] == "info":
                        return json.dumps({"OSType": "linux", "Architecture": "x86_64"})
                    if args[:2] == ["image", "inspect"]:
                        return json.dumps([dict(
                            Id=image, Os="linux", Architecture="amd64",
                            Config=dict(Entrypoint=runtime.ENTRYPOINT, Cmd=runtime.COMMAND,
                                        User="10001:10001",
                                        Labels={"org.asterisk.local.bundle-manifest-sha256": runtime.MANIFEST_SHA256},
                                        Env=[
                                            "LD_LIBRARY_PATH=/opt/asterisk/main:/opt/asterisk/runtime-libs",
                                            "LOCPATH=/opt/asterisk/runtime-locale",
                                            "GCONV_PATH=/opt/asterisk/runtime-gconv",
                                        ]))])
                    if args[0] == "run":
                        identity["Name"] = "/" + args[args.index("--name") + 1]
                        identity["Config"]["Labels"] = {
                            "org.asterisk.local.smoke-owner": args[args.index("--label") + 1].split("=")[1]}
                        identity["HostConfig"] = dict(
                            NetworkMode="none", ReadonlyRootfs=True, Privileged=False,
                            Memory=4294967296, MemorySwap=4294967296,
                            NanoCpus=4000000000, PidsLimit=256,
                            PortBindings={}, CapDrop=["ALL"], SecurityOpt=["no-new-privileges:true"])
                        if failure == "limits":
                            identity["HostConfig"]["MemorySwap"] = -1
                        (root / "state/run/asterisk.ctl").write_text("mock socket")
                        if failure == "launch-timeout":
                            raise subprocess.TimeoutExpired("docker", 20)
                        return identity["Id"] + "\n"
                    if args[0] == "inspect":
                        if "--format" in args:
                            return json.dumps({"Running": False, "OOMKilled": False})
                        inspected = json.loads(json.dumps(identity))
                        if failure == "ownership":
                            inspected["Name"] = "/someone-else"
                        return json.dumps([inspected])
                    if args[0] == "ps":
                        return identity["Id"] + "\n"
                    if args[0] == "logs":
                        self.assertTrue(kwargs["include_stderr"])
                        return "fixture log"
                    if args[0] == "wait":
                        return "0\n"
                    if args[0] == "rm":
                        self.assertEqual(args, ["rm", "--force", identity["Id"]])
                        (root / "state/run/asterisk.ctl").unlink(missing_ok=True)
                        return identity["Id"]
                    raise AssertionError(f"Unexpected Docker call: {args}")

                def fake_cli(control, command):
                    if command == "core waitfullybooted":
                        return "Asterisk has fully booted.\n"
                    if command == "module show":
                        return "" if failure == "modules" else self.module_output()
                    if command in ["pjsip show endpoints", "pjsip show transports"]:
                        return "No objects found.\n"
                    if command == "core show help test execute":
                        return "No such command"
                    if command.startswith("queue policy snapshot"):
                        return json.dumps(next(observations)["response"]) + "\n"
                    if command.startswith("queue reload parameters") or command == "core stop now":
                        return ""
                    raise AssertionError(f"Unexpected CLI command: {command}")

                with patch.object(runtime.sys, "platform", "linux"), \
                        patch.object(os, "geteuid", return_value=10001, create=True), \
                        patch.object(os, "getuid", return_value=10001, create=True), \
                        patch.object(os, "getgid", return_value=10001, create=True), \
                        patch.dict(os.environ, {"DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONTEXT": ""}), \
                        patch.object(runtime, "docker", side_effect=fake_docker), \
                        patch.object(runtime, "cli", side_effect=fake_cli):
                    if failure:
                        with self.assertRaises((ValueError, RuntimeError, subprocess.TimeoutExpired)):
                            runtime.smoke(image, root)
                    else:
                        report = runtime.smoke(image, root)
                        self.assertTrue(report["passed"])
                        self.assertEqual(report["observations"], expected)
                        self.assertTrue(report["ownedContainerRemoved"])
                        self.assertFalse(report["imagePayloadIndependentlyVerified"])
                report = runtime.read_json(root / "image-smoke-report.json")
                self.assertEqual(report["passed"], failure is None)
                removals = [args for args in calls if args[0] == "rm"]
                self.assertEqual(len(removals), 0 if failure == "ownership" else 1)


if __name__ == "__main__":
    unittest.main()
