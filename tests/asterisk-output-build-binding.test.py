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

    def test_validates_complete_compile_report_lineage_for_both_profiles(self):
        manifest, _, patch_hash, manifest_hash = binding.load_cli_output_supplement(
            self.manifest_path, self.parent, self.shutdown, self.shutdown_hash
        )
        postimages = [
            dict(path=path, sha256=manifest["applicationVerification"]["postimageSha256"][path])
            for path in binding.EXPECTED_OUTPUT_PATHS
        ]
        application = dict(
            patchSha256=patch_hash,
            appliedWithZeroFuzz=True,
            postimages=postimages,
        )
        report = {
            "cliOutputSupplementPatchSha256": patch_hash,
            "cliOutputSupplementManifestSha256": manifest_hash,
            "cliOutputSupplementParentPatchSha256": self.parent["patchSha256"],
            "cliOutputSupplementParentSupplementPatchSha256": self.shutdown["patchSha256"],
            "cliOutputSupplementParentSupplementManifestSha256": self.shutdown_hash,
            "profiles": [
                {"name": name, "cliOutputSupplement": application}
                for name in ("instrumented", "release")
            ],
        }

        self.assertTrue(binding.validate_cli_output_compile_report(report))

        report["profiles"][1]["cliOutputSupplement"]["postimages"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "does not bind the CLI output supplement"):
            binding.validate_cli_output_compile_report(report)
        report_without_report_bindings = {
            key: value
            for key, value in report.items()
            if key not in binding.CLI_OUTPUT_REPORT_FIELDS
        }
        with self.assertRaisesRegex(ValueError, "incomplete CLI output supplement bindings"):
            binding.validate_cli_output_compile_report(report_without_report_bindings)

    def test_rejects_partial_output_bindings_and_preserves_legacy_reports(self):
        self.assertFalse(binding.validate_cli_output_compile_report({"profiles": []}))
        with self.assertRaisesRegex(ValueError, "incomplete CLI output supplement bindings"):
            binding.validate_cli_output_compile_report(
                {"cliOutputSupplementPatchSha256": "a" * 64}
            )
        with self.assertRaisesRegex(ValueError, "Compile report must be an object"):
            binding.validate_cli_output_compile_report([])


class Ao2AccountingSupplementBindingTests(unittest.TestCase):
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
        self.output_path = patches / "queue-policy-output-v1.json"
        (
            self.output,
            _,
            self.output_patch_hash,
            self.output_manifest_hash,
        ) = binding.load_cli_output_supplement(
            self.output_path, self.parent, self.shutdown, self.shutdown_hash
        )
        self.manifest_path = patches / "queue-policy-accounting-v1.json"

    def load_accounting(self, manifest_path=None):
        return binding.load_ao2_accounting_supplement(
            manifest_path or self.manifest_path,
            self.parent,
            self.shutdown,
            self.shutdown_hash,
            self.output,
            self.output_manifest_hash,
        )

    def test_loads_exact_fourth_supplement_and_passed_basis_reports(self):
        manifest, patch_path, patch_hash, manifest_hash = self.load_accounting()

        self.assertEqual(patch_path.name, manifest["patch"])
        self.assertEqual(patch_hash, manifest["patchSha256"])
        self.assertEqual(len(manifest_hash), 64)
        self.assertEqual(
            manifest["changedUpstreamPaths"], binding.EXPECTED_ACCOUNTING_PATHS
        )
        self.assertFalse(manifest["nativeCompiled"])
        self.assertFalse(manifest["nativeTestsExecuted"])
        self.assertFalse(manifest["instrumentation"]["nonAo2AllocatorsAndIoInstrumented"])

    def test_rejects_modified_accounting_patch_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            patches = root / "local" / "asterisk-patches"
            builds = root / "local" / "asterisk-build"
            patches.mkdir(parents=True)
            builds.mkdir(parents=True)
            copied_manifest = patches / self.manifest_path.name
            shutil.copyfile(self.manifest_path, copied_manifest)
            patch_path = patches / "queue-policy-accounting-v1.patch"
            shutil.copyfile(self.manifest_path.parent / patch_path.name, patch_path)
            shutil.copyfile(
                ROOT / "local" / "asterisk-build" / "compile-report-output-v1.json",
                builds / "compile-report-output-v1.json",
            )
            shutil.copyfile(
                ROOT / "local" / "asterisk-build" / "native-test-report-output-v1.json",
                builds / "native-test-report-output-v1.json",
            )
            patch_path.write_bytes(patch_path.read_bytes() + b"\n")

            with self.assertRaisesRegex(ValueError, "patch SHA256 mismatch"):
                self.load_accounting(copied_manifest)

    def test_checks_accounting_preimages_and_postimages(self):
        with tempfile.TemporaryDirectory() as temporary:
            contents = {
                relative: f"accounting-source:{relative}".encode()
                for relative in binding.EXPECTED_ACCOUNTING_PATHS
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
            tree = pathlib.Path(temporary)
            for relative, data in contents.items():
                path = tree / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)

            binding.verify_ao2_accounting_basis(tree, manifest)
            self.assertEqual(
                binding.verify_ao2_accounting_postimages(tree, manifest),
                [
                    dict(path=relative, sha256=hashlib.sha256(contents[relative]).hexdigest())
                    for relative in binding.EXPECTED_ACCOUNTING_PATHS
                ],
            )
            (tree / binding.EXPECTED_ACCOUNTING_PATHS[0]).write_bytes(b"unexpected source")
            with self.assertRaisesRegex(ValueError, "source preimage mismatch"):
                binding.verify_ao2_accounting_basis(tree, manifest)
            with self.assertRaisesRegex(ValueError, "source postimage mismatch"):
                binding.verify_ao2_accounting_postimages(tree, manifest)

    def test_validates_complete_accounting_report_lineage_for_both_profiles(self):
        manifest, _, patch_hash, manifest_hash = self.load_accounting()
        output_application = dict(
            patchSha256=self.output_patch_hash,
            appliedWithZeroFuzz=True,
            postimages=[
                dict(
                    path=path,
                    sha256=self.output["applicationVerification"]["postimageSha256"][path],
                )
                for path in binding.EXPECTED_OUTPUT_PATHS
            ],
        )
        accounting_application = dict(
            patchSha256=patch_hash,
            appliedWithZeroFuzz=True,
            postimages=[
                dict(
                    path=path,
                    sha256=manifest["applicationVerification"]["postimageSha256"][path],
                )
                for path in binding.EXPECTED_ACCOUNTING_PATHS
            ],
        )
        report = {
            "cliOutputSupplementPatchSha256": self.output_patch_hash,
            "cliOutputSupplementManifestSha256": self.output_manifest_hash,
            "cliOutputSupplementParentPatchSha256": self.parent["patchSha256"],
            "cliOutputSupplementParentSupplementPatchSha256": self.shutdown["patchSha256"],
            "cliOutputSupplementParentSupplementManifestSha256": self.shutdown_hash,
            "ao2AccountingSupplementPatchSha256": patch_hash,
            "ao2AccountingSupplementManifestSha256": manifest_hash,
            "ao2AccountingSupplementParentPatchSha256": self.parent["patchSha256"],
            "ao2AccountingSupplementParentSupplementPatchSha256": self.shutdown["patchSha256"],
            "ao2AccountingSupplementParentSupplementManifestSha256": self.shutdown_hash,
            "ao2AccountingSupplementParentOutputSupplementPatchSha256": self.output_patch_hash,
            "ao2AccountingSupplementParentOutputSupplementManifestSha256": (
                self.output_manifest_hash
            ),
            "profiles": [
                {
                    "name": name,
                    "cliOutputSupplement": output_application,
                    "ao2AccountingSupplement": accounting_application,
                }
                for name in ("instrumented", "release")
            ],
        }

        self.assertTrue(binding.validate_cli_output_compile_report(report))
        report["profiles"][1]["ao2AccountingSupplement"]["postimages"][0]["sha256"] = (
            "0" * 64
        )
        with self.assertRaisesRegex(ValueError, "does not bind the AO2 accounting supplement"):
            binding.validate_cli_output_compile_report(report)

    def test_rejects_partial_accounting_report_bindings(self):
        output_application = dict(
            patchSha256=self.output_patch_hash,
            appliedWithZeroFuzz=True,
            postimages=[
                dict(
                    path=path,
                    sha256=self.output["applicationVerification"]["postimageSha256"][path],
                )
                for path in binding.EXPECTED_OUTPUT_PATHS
            ],
        )
        report = {
            "cliOutputSupplementPatchSha256": self.output_patch_hash,
            "cliOutputSupplementManifestSha256": self.output_manifest_hash,
            "cliOutputSupplementParentPatchSha256": self.parent["patchSha256"],
            "cliOutputSupplementParentSupplementPatchSha256": self.shutdown["patchSha256"],
            "cliOutputSupplementParentSupplementManifestSha256": self.shutdown_hash,
            "profiles": [
                {"name": name, "cliOutputSupplement": output_application}
                for name in ("instrumented", "release")
            ],
        }
        report.update(
            {
                field: "b" * 64
                for field in binding.AO2_ACCOUNTING_REPORT_FIELDS[:-1]
            }
        )

        with self.assertRaisesRegex(
            ValueError, "incomplete AO2 accounting supplement bindings"
        ):
            binding.validate_cli_output_compile_report(report)


class LoaderLifecycleSupplementBindingTests(unittest.TestCase):
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
        self.output_path = patches / "queue-policy-output-v1.json"
        (
            self.output,
            _,
            _,
            self.output_hash,
        ) = binding.load_cli_output_supplement(
            self.output_path, self.parent, self.shutdown, self.shutdown_hash
        )
        self.accounting_path = patches / "queue-policy-accounting-v1.json"
        (
            self.accounting,
            _,
            _,
            self.accounting_hash,
        ) = binding.load_ao2_accounting_supplement(
            self.accounting_path,
            self.parent,
            self.shutdown,
            self.shutdown_hash,
            self.output,
            self.output_hash,
        )
        self.manifest_path = patches / "queue-policy-loader-v1.json"

    def load_loader(self, manifest_path=None, accounting_manifest=None):
        return binding.load_loader_lifecycle_supplement(
            manifest_path or self.manifest_path,
            self.parent,
            self.shutdown,
            self.shutdown_hash,
            self.output,
            self.output_hash,
            accounting_manifest or self.accounting,
            self.accounting_hash,
        )

    def test_loads_exact_fifth_supplement_and_passed_basis_reports(self):
        manifest, patch_path, patch_hash, manifest_hash = self.load_loader()

        self.assertEqual(patch_path.name, manifest["patch"])
        self.assertEqual(patch_hash, manifest["patchSha256"])
        self.assertEqual(len(manifest_hash), 64)
        self.assertEqual(
            manifest["changedUpstreamPaths"], binding.EXPECTED_LOADER_LIFECYCLE_PATHS
        )
        self.assertTrue(manifest["fixtures"]["successfulRemovalWhileLookupPausedCovered"])
        self.assertFalse(manifest["nativeCompiled"])
        self.assertFalse(manifest["nativeTestsExecuted"])

    def test_rejects_modified_loader_patch_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            patches = root / "local" / "asterisk-patches"
            builds = root / "local" / "asterisk-build"
            patches.mkdir(parents=True)
            builds.mkdir(parents=True)
            copied_manifest = patches / self.manifest_path.name
            shutil.copyfile(self.manifest_path, copied_manifest)
            patch_path = patches / "queue-policy-loader-v1.patch"
            shutil.copyfile(self.manifest_path.parent / patch_path.name, patch_path)
            for name in [
                "compile-report-accounting-v1.json",
                "native-test-report-accounting-v1.json",
            ]:
                shutil.copyfile(ROOT / "local" / "asterisk-build" / name, builds / name)
            patch_path.write_bytes(patch_path.read_bytes() + b"\n")

            with self.assertRaisesRegex(ValueError, "patch SHA256 mismatch"):
                self.load_loader(copied_manifest)

    def test_rejects_a_different_accounting_parent(self):
        accounting = dict(self.accounting)
        accounting["patchSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "pinned parent supplements"):
            self.load_loader(accounting_manifest=accounting)

    def test_checks_loader_preimages_and_postimages(self):
        with tempfile.TemporaryDirectory() as temporary:
            contents = {
                relative: f"loader-source:{relative}".encode()
                for relative in binding.EXPECTED_LOADER_LIFECYCLE_PATHS
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
            tree = pathlib.Path(temporary)
            for relative, data in contents.items():
                path = tree / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(data)

            binding.verify_loader_lifecycle_basis(tree, manifest)
            self.assertEqual(
                binding.verify_loader_lifecycle_postimages(tree, manifest),
                [
                    dict(path=relative, sha256=hashlib.sha256(contents[relative]).hexdigest())
                    for relative in binding.EXPECTED_LOADER_LIFECYCLE_PATHS
                ],
            )
            (tree / binding.EXPECTED_LOADER_LIFECYCLE_PATHS[0]).write_bytes(
                b"unexpected source"
            )
            with self.assertRaisesRegex(ValueError, "source preimage mismatch"):
                binding.verify_loader_lifecycle_basis(tree, manifest)
            with self.assertRaisesRegex(ValueError, "source postimage mismatch"):
                binding.verify_loader_lifecycle_postimages(tree, manifest)

    def test_validates_loader_lineage_for_both_compile_profiles(self):
        manifest, _, patch_hash, manifest_hash = self.load_loader()
        report = json.loads(
            (ROOT / "local" / "asterisk-build" / "compile-report-accounting-v1.json")
            .read_text()
        )
        report.update(
            {
                "loaderLifecycleSupplementPatchSha256": patch_hash,
                "loaderLifecycleSupplementManifestSha256": manifest_hash,
                "loaderLifecycleSupplementParentPatchSha256": self.parent["patchSha256"],
                "loaderLifecycleSupplementParentSupplementPatchSha256": (
                    self.shutdown["patchSha256"]
                ),
                "loaderLifecycleSupplementParentSupplementManifestSha256": (
                    self.shutdown_hash
                ),
                "loaderLifecycleSupplementParentOutputSupplementPatchSha256": (
                    self.output["patchSha256"]
                ),
                "loaderLifecycleSupplementParentOutputSupplementManifestSha256": (
                    self.output_hash
                ),
                "loaderLifecycleSupplementParentAccountingSupplementPatchSha256": (
                    self.accounting["patchSha256"]
                ),
                "loaderLifecycleSupplementParentAccountingSupplementManifestSha256": (
                    self.accounting_hash
                ),
            }
        )
        application = {
            "patchSha256": patch_hash,
            "appliedWithZeroFuzz": True,
            "postimages": [
                dict(
                    path=path,
                    sha256=manifest["applicationVerification"]["postimageSha256"][path],
                )
                for path in binding.EXPECTED_LOADER_LIFECYCLE_PATHS
            ],
        }
        for profile in report["profiles"]:
            profile["loaderLifecycleSupplement"] = application

        self.assertTrue(binding.validate_cli_output_compile_report(report))
        report["profiles"][1]["loaderLifecycleSupplement"]["postimages"][0]["sha256"] = (
            "0" * 64
        )
        with self.assertRaisesRegex(
            ValueError, "does not bind the loader lifecycle supplement"
        ):
            binding.validate_cli_output_compile_report(report)


if __name__ == "__main__":
    unittest.main()
