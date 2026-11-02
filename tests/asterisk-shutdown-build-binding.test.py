import copy
import hashlib
import importlib.util
import json
import pathlib
import shutil
import sys
import tempfile
import unittest


root = pathlib.Path(__file__).resolve().parents[1]
binding_path = root / "local" / "asterisk-build" / "shutdown_compile_binding.py"
sys.path.insert(0, str(binding_path.parent))
spec = importlib.util.spec_from_file_location("shutdown_compile_binding", binding_path)
binding = importlib.util.module_from_spec(spec)
spec.loader.exec_module(binding)
supervisor_path = root / "local" / "asterisk-build" / "shutdown-supervisor.py"
supervisor_spec = importlib.util.spec_from_file_location(
    "shutdown_supervisor", supervisor_path
)
supervisor = importlib.util.module_from_spec(supervisor_spec)
supervisor_spec.loader.exec_module(supervisor)


class ShutdownCompileBindingTests(unittest.TestCase):
    def setUp(self):
        self.parent_manifest = json.loads(
            (root / "local" / "asterisk-patches" / "queue-policy-v1.json").read_text()
        )
        self.manifest_path = (
            root / "local" / "asterisk-patches" / "queue-policy-shutdown-v1.json"
        )

    def test_loads_exact_supplement_and_parent_binding(self):
        manifest, patch_path, patch_hash, manifest_hash = binding.load_shutdown_supplement(
            self.manifest_path, self.parent_manifest
        )
        self.assertEqual(patch_path.name, manifest["patch"])
        self.assertEqual(patch_hash, manifest["patchSha256"])
        self.assertEqual(len(manifest_hash), 64)
        self.assertEqual(manifest["changedUpstreamPaths"], binding.EXPECTED_PATHS)

    def test_rejects_modified_patch_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied_manifest = pathlib.Path(temporary) / self.manifest_path.name
            shutil.copyfile(self.manifest_path, copied_manifest)
            shutil.copyfile(
                self.manifest_path.parent / "queue-policy-shutdown-v1.patch",
                pathlib.Path(temporary) / "queue-policy-shutdown-v1.patch",
            )
            patch_path = pathlib.Path(temporary) / "queue-policy-shutdown-v1.patch"
            patch_path.write_bytes(patch_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "SHA256 mismatch"):
                binding.load_shutdown_supplement(copied_manifest, self.parent_manifest)

    def test_rejects_unrelated_parent_candidate(self):
        parent = dict(self.parent_manifest)
        parent["patchSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "pinned parent candidate"):
            binding.load_shutdown_supplement(self.manifest_path, parent)

    def test_supervisor_requires_complete_matching_profiles(self):
        manifest = json.loads(self.manifest_path.read_text())
        with tempfile.TemporaryDirectory() as temporary:
            root_path = pathlib.Path(temporary)
            build_root = root_path / "native-build-attempt-1"
            binary = build_root / "instrumented" / "main" / "asterisk"
            binary.parent.mkdir(parents=True)
            binary.write_bytes(b"instrumented binary")
            target = root_path / "case" / "modules" / "test_protected_cli_target.so"
            target.parent.mkdir(parents=True)
            target.write_bytes(b"test target")
            output_hashes = {
                "main/asterisk": hashlib.sha256(binary.read_bytes()).hexdigest(),
                "tests/test_protected_cli_target.so":
                    hashlib.sha256(target.read_bytes()).hexdigest(),
            }
            postimages = [
                {"path": path, "sha256": "a" * 64}
                for path in manifest["changedUpstreamPaths"]
            ]
            application = {
                "patchSha256": manifest["patchSha256"],
                "appliedWithZeroFuzz": True,
                "postimages": postimages,
            }
            report = {
                "upstreamCommit": manifest["upstreamCommit"],
                "patchSha256": manifest["parentPatchSha256"],
                "shutdownSupplementPatchSha256": manifest["patchSha256"],
                "shutdownSupplementParentPatchSha256": manifest["parentPatchSha256"],
                "shutdownSupplementManifestSha256":
                    hashlib.sha256(self.manifest_path.read_bytes()).hexdigest(),
                "profiles": [
                    {
                        "name": "instrumented",
                        "compiled": True,
                        "enabledOptions": ["TEST_FRAMEWORK"],
                        "shutdownSupplement": application,
                        "outputs": [
                            {"path": path, "sha256": digest}
                            for path, digest in output_hashes.items()
                        ],
                    },
                    {
                        "name": "release",
                        "compiled": True,
                        "enabledOptions": [],
                        "shutdownSupplement": copy.deepcopy(application),
                        "outputs": [],
                    },
                ],
            }
            (build_root / "compile-report.json").write_text(json.dumps(report))
            supervisor._validate_build_binding(binary, root_path / "case")

            report["profiles"][1]["shutdownSupplement"]["postimages"][0]["sha256"] = "b" * 64
            (build_root / "compile-report.json").write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "source postimages differ"):
                supervisor._validate_build_binding(binary, root_path / "case")


if __name__ == "__main__":
    unittest.main()
