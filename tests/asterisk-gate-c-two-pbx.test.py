import hashlib
import importlib.util
import json
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER_PATH = ROOT / "local" / "asterisk-build" / "runtime-two-pbx-gate-c.py"
SPEC = importlib.util.spec_from_file_location("runtime_two_pbx_gate_c", RUNNER_PATH)
gate_c = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate_c)


def canonical_lf_sha256(path):
    return hashlib.sha256(path.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


class GateCTwoPbxEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.namespace = "cp-0123456789abcdef01234567"

    def test_exact_own_and_foreign_namespace_snapshots(self):
        own = gate_c.expected_snapshot(self.namespace)
        foreign = gate_c.expected_snapshot(self.namespace, include_target=False)

        self.assertEqual([row["name"] for row in own["objects"]], [
            self.namespace + "-smoke",
            "proof-queue",
        ])
        self.assertEqual([row["name"] for row in foreign["objects"]], ["proof-queue"])

    def test_snapshot_parser_rejects_extra_output_and_changed_facts(self):
        expected = gate_c.expected_snapshot(self.namespace)
        raw = json.dumps(expected)

        self.assertEqual(gate_c.validate_snapshot(raw, expected), expected)
        with self.assertRaisesRegex(ValueError, "exactly one line"):
            gate_c.validate_snapshot(raw + "\nextra", expected)
        with self.assertRaisesRegex(ValueError, "exact expected facts"):
            gate_c.validate_snapshot(json.dumps(gate_c.expected_snapshot(
                self.namespace, include_target=False
            )), expected)
        with self.assertRaisesRegex(ValueError, "8 KiB"):
            gate_c.validate_snapshot(" " * 8193, expected)

    def test_disk_only_and_loaded_only_fixtures_are_distinct(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = pathlib.Path(temporary) / "queues.conf"
            gate_c.write_queue_configuration(
                path, self.namespace, include_target=True, include_disk_only=True
            )
            disk_only = path.read_text()
            self.assertIn(f"[{self.namespace}-smoke]", disk_only)
            self.assertIn(f"[{self.namespace}-disk-only]", disk_only)

            gate_c.write_queue_configuration(
                path, self.namespace, include_target=False, include_disk_only=False
            )
            loaded_only = path.read_text()
            self.assertNotIn(f"[{self.namespace}-smoke]", loaded_only)
            self.assertNotIn(f"[{self.namespace}-disk-only]", loaded_only)
            self.assertIn("[proof-queue]", loaded_only)

    def test_rejects_invalid_namespace_and_attempt_beyond_cap(self):
        for namespace in ["cp-too-short", "CP-" + "0" * 24, "cp-" + "g" * 24]:
            with self.subTest(namespace=namespace):
                with self.assertRaisesRegex(ValueError, "Namespace"):
                    gate_c.expected_snapshot(namespace)
        with self.assertRaisesRegex(ValueError, "between 1 and 10"):
            gate_c.validate_attempt(11)
        with self.assertRaisesRegex(ValueError, "between 1 and 10"):
            gate_c.validate_attempt(True)

    def test_existing_image_is_exactly_bound_to_its_original_compile(self):
        image = gate_c.runtime.read_json(
            ROOT / "local" / "asterisk-build" / "image-build-validation-nss.json"
        )["imageId"]

        lineage = gate_c.verify_image_lineage(image)

        self.assertEqual(lineage["originalReleaseOutputs"], 44)
        self.assertEqual(lineage["originalReleaseOutputsMatched"], 44)
        self.assertEqual(lineage["latestGateBReleaseOutputs"], 44)
        self.assertEqual(lineage["latestGateBReleaseOutputsMatchedToExistingBundle"], 0)

    def test_two_container_launch_limits_fit_a_bounded_shared_daemon_budget(self):
        with tempfile.TemporaryDirectory() as temporary:
            arguments = gate_c.container_arguments(
                "sha256:" + "a" * 64,
                "asterisk-gate-c-test",
                "owner",
                pathlib.Path(temporary),
            )

        self.assertIn("--cpus=2", arguments)
        self.assertIn("--memory=2g", arguments)
        self.assertIn("--memory-swap=2g", arguments)
        self.assertIn("--network=none", arguments)
        self.assertIn("--read-only", arguments)
        self.assertIn("--cap-drop=ALL", arguments)

    def test_committed_gate_c_attempt_records_policy_facts_and_cleanup(self):
        report = json.loads(
            (ROOT / "local" / "asterisk-build" / "gate-c-two-pbx-attempt-2.json")
            .read_text()
        )

        self.assertTrue(report["passed"])
        self.assertEqual(len(report["observations"]), 8)
        self.assertEqual(report["imageLineage"]["originalReleaseOutputsMatched"], 44)
        self.assertEqual(
            report["imageLineage"]["latestGateBReleaseOutputsMatchedToExistingBundle"], 0
        )
        self.assertTrue(report["allOwnedContainersRemoved"])
        self.assertTrue(report["fixtureConfigurationRemoved"])
        self.assertEqual(report["exitCodes"], {"customer-a": 0, "customer-b": 0})
        self.assertTrue(all(value is False for value in report["actions"].values()))
        self.assertEqual(report["runnerSha256"],
                         "209972488c650effe77556067c12fd4662d956300cd3ae22c38da43e86abc5bc")
        self.assertEqual(report["runnerSha256Normalization"], "raw-execution-file-bytes")
        self.assertIn("CRLF files differ", report["evidenceFileHashNormalization"])

    def test_failed_first_attempt_records_manual_container_cleanup(self):
        report = json.loads(
            (ROOT / "local" / "asterisk-build" / "gate-c-two-pbx-report.json")
            .read_text()
        )

        self.assertFalse(report["passed"])
        self.assertTrue(report["cleanupResolution"]["manualCleanupAfterHarnessFailure"])
        self.assertTrue(report["cleanupResolution"]["containerRemoved"])
        self.assertTrue(report["cleanupResolution"]["ownedFixtureDirectoriesRemoved"])
        self.assertFalse(report["cleanupResolution"]["queueQueriesIssued"])

    def test_build_preparation_binds_gate_c_attempts_and_current_runner(self):
        record = json.loads(
            (ROOT / "local" / "asterisk-patches" / "build-preparation.json")
            .read_text()
        )["gateCTwoPbxProof"]
        attempt_1 = ROOT / "local" / "asterisk-build" / "gate-c-two-pbx-report.json"
        attempt_2 = ROOT / "local" / "asterisk-build" / "gate-c-two-pbx-attempt-2.json"
        runner = ROOT / "local" / "asterisk-build" / "runtime-two-pbx-gate-c.py"

        self.assertEqual(len(record["attempts"]), 2)
        self.assertEqual(
            canonical_lf_sha256(attempt_1),
            record["attempts"][0]["reportSha256"],
        )
        self.assertEqual(
            canonical_lf_sha256(attempt_2),
            record["attempts"][1]["reportSha256"],
        )
        self.assertEqual(
            canonical_lf_sha256(runner),
            record["runnerCurrentSha256"],
        )


if __name__ == "__main__":
    unittest.main()
