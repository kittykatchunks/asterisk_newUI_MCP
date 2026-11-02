import hashlib
import importlib.util
import json
import pathlib
import shutil
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
BINDING_PATH = ROOT / "local" / "asterisk-build" / "shutdown_compile_binding.py"
SPEC = importlib.util.spec_from_file_location("shutdown_compile_binding", BINDING_PATH)
binding = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(binding)


class OutputSupplementBindingTests(unittest.TestCase):
    def setUp(self):
        patches = ROOT / "local" / "asterisk-patches"
        self.parent = json.loads((patches / "queue-policy-v1.json").read_text())
        self.shutdown_path = patches / "queue-policy-shutdown-v1.json"
        (
            self.shutdown,
            _,
            _,
            self.shutdown_hash,
        ) = binding.load_shutdown_supplement(self.shutdown_path, self.parent)
        self.manifest_path = patches / "queue-policy-output-v1.json"

    def test_loads_exact_third_supplement_after_the_shutdown_parent(self):
        manifest, patch_path, patch_hash, manifest_hash = binding.load_cli_output_supplement(
            self.manifest_path, self.parent, self.shutdown, self.shutdown_hash
        )

        self.assertEqual(patch_path.name, manifest["patch"])
        self.assertEqual(patch_hash, manifest["patchSha256"])
        self.assertEqual(len(manifest_hash), 64)
        self.assertEqual(manifest["changedUpstreamPaths"], binding.EXPECTED_OUTPUT_PATHS)

    def test_rejects_modified_third_supplement_patch_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied_manifest = pathlib.Path(temporary) / self.manifest_path.name
            shutil.copyfile(self.manifest_path, copied_manifest)
            shutil.copyfile(
                self.manifest_path.parent / "queue-policy-output-v1.patch",
                pathlib.Path(temporary) / "queue-policy-output-v1.patch",
            )
            patch_path = pathlib.Path(temporary) / "queue-policy-output-v1.patch"
            patch_path.write_bytes(patch_path.read_bytes() + b"\n")
            with self.assertRaisesRegex(ValueError, "patch SHA256 mismatch"):
                binding.load_cli_output_supplement(
                    copied_manifest, self.parent, self.shutdown, self.shutdown_hash
                )

    def test_rejects_a_different_shutdown_parent(self):
        shutdown = dict(self.shutdown)
        shutdown["patchSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "pinned parent supplements"):
            binding.load_cli_output_supplement(
                self.manifest_path, self.parent, shutdown, self.shutdown_hash
            )

    def test_rejects_undeclared_or_missing_source_paths(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied_manifest = pathlib.Path(temporary) / self.manifest_path.name
            manifest = json.loads(self.manifest_path.read_text())
            manifest["changedUpstreamPaths"] = binding.EXPECTED_OUTPUT_PATHS[:-1]
            copied_manifest.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, "pinned parent supplements"):
                binding.load_cli_output_supplement(
                    copied_manifest, self.parent, self.shutdown, self.shutdown_hash
                )

    def test_rejects_malformed_hash_types_without_incidental_type_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied_manifest = pathlib.Path(temporary) / self.manifest_path.name
            manifest = json.loads(self.manifest_path.read_text())
            manifest["basisCompileReportSha256"] = 17
            copied_manifest.write_text(json.dumps(manifest))
            shutil.copyfile(
                self.manifest_path.parent / "queue-policy-output-v1.patch",
                pathlib.Path(temporary) / "queue-policy-output-v1.patch",
            )
            with self.assertRaisesRegex(ValueError, "invalid basisCompileReportSha256"):
                binding.load_cli_output_supplement(
                    copied_manifest, self.parent, self.shutdown, self.shutdown_hash
                )

    def test_checks_exact_preimages_and_postimages_for_each_profile(self):
        with tempfile.TemporaryDirectory() as temporary:
            contents = {
                relative: f"source:{relative}".encode()
                for relative in binding.EXPECTED_OUTPUT_PATHS
            }
            manifest = {
                "basisSourceSha256": {
                    relative: hashlib.sha256(data).hexdigest()
                    for relative, data in contents.items()
                },
                "applicationVerification": {
                    "postimageSha256": {
                        relative: hashlib.sha256(data).hexdigest()
                        for relative, data in contents.items()
                    }
                },
            }

            for profile in ("instrumented", "release"):
                with self.subTest(profile=profile):
                    tree = pathlib.Path(temporary) / profile
                    for relative, data in contents.items():
                        path = tree / relative
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(data)

                    binding.verify_cli_output_basis(tree, manifest)
                    self.assertEqual(
                        binding.verify_cli_output_postimages(tree, manifest),
                        [
                            dict(
                                path=relative,
                                sha256=hashlib.sha256(contents[relative]).hexdigest(),
                            )
                            for relative in binding.EXPECTED_OUTPUT_PATHS
                        ],
                    )

                    (tree / binding.EXPECTED_OUTPUT_PATHS[0]).write_bytes(
                        b"unexpected preimage"
                    )
                    with self.assertRaisesRegex(ValueError, "source preimage mismatch"):
                        binding.verify_cli_output_basis(tree, manifest)
                    with self.assertRaisesRegex(ValueError, "source postimage mismatch"):
                        binding.verify_cli_output_postimages(tree, manifest)


if __name__ == "__main__":
    unittest.main()
