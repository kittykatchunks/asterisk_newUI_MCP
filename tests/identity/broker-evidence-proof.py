"""Synthetic evidence validation only; never collects PBX state."""

from dataclasses import replace
import os
from pathlib import Path
import re
import sys
import threading
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
from evidence import EvidenceBinding, EvidenceRequest, EvidenceUnavailable
from ledger import LedgerBinding
from readback import Rejected


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.binding = EvidenceBinding(
            LedgerBinding("customer-a", str(uuid.uuid4()), "agent"),
            str(uuid.uuid4()), 1, str(uuid.uuid4()))
        self.cancel = threading.Event()

    def envelope(self, request, outcome="complete", **observation):
        return {**request.expected(), "outcome": outcome, "observation": {
            "newCallsBlocked": True, "dialogs": 0, "removed": False, **observation}}

    def test_complete_unknown_and_detached_results(self):
        for outcome, dialogs in (("complete", 0), ("complete", 12), ("dialogs-unknown", "unknown")):
            request = EvidenceRequest(self.binding)
            value = self.envelope(request, outcome, dialogs=dialogs)
            result = request.validate(value, self.binding, self.cancel)
            self.assertEqual(result, value["observation"])
            value["observation"]["dialogs"] = 99
            self.assertEqual(result["dialogs"], dialogs)
        request = EvidenceRequest(self.binding)
        self.assertEqual(request.validate(self.envelope(request, removed=True),
                                         self.binding, self.cancel)["removed"], True)
        request = EvidenceRequest(self.binding)
        self.assertFalse(request.validate(self.envelope(request, newCallsBlocked=False),
                                          self.binding, self.cancel)["newCallsBlocked"])

    def test_exact_binding_and_fields(self):
        for value in (None, [], "", 1):
            with self.assertRaises(Rejected):
                EvidenceRequest(self.binding).validate(value, self.binding, self.cancel)
        for field, wrong in (
            ("version", True), ("version", 1.0), ("customer", "other"), ("epoch", str(uuid.uuid4())),
            ("namespace", "other"), ("generationId", str(uuid.uuid4())), ("mappingRevision", 2),
            ("mappingRevision", True), ("runtimeInstance", str(uuid.uuid4())),
            ("requestId", str(uuid.uuid4())), ("secret", "forbidden"), ("outcome", "missing"),
        ):
            with self.subTest(field=field, wrong=wrong):
                request = EvidenceRequest(self.binding)
                value = self.envelope(request)
                value[field] = wrong
                with self.assertRaises(Rejected):
                    request.validate(value, self.binding, self.cancel)
        for field in self.envelope(EvidenceRequest(self.binding)):
            request = EvidenceRequest(self.binding)
            value = self.envelope(request)
            del value[field]
            with self.assertRaises(Rejected):
                request.validate(value, self.binding, self.cancel)

    def test_unavailable_never_becomes_missing_or_empty_success(self):
        request = EvidenceRequest(self.binding)
        value = {**request.expected(), "outcome": "unavailable"}
        with self.assertRaisesRegex(EvidenceUnavailable, "unavailable"):
            request.validate(value, self.binding, self.cancel)
        with self.assertRaisesRegex(Rejected, "single-use"):
            request.validate(value, self.binding, self.cancel)
        request = EvidenceRequest(self.binding)
        with self.assertRaises(Rejected):
            request.validate(self.envelope(request, "unavailable"), self.binding, self.cancel)

    def test_unknown_malformed_and_contradictory_observations(self):
        for outcome, data in (
            ("complete", {"dialogs": "unknown"}), ("dialogs-unknown", {"dialogs": 0}),
            ("complete", {"dialogs": True}), ("complete", {"dialogs": -1}),
            ("complete", {"dialogs": 9007199254740992}), ("complete", {"extra": True}),
            ("complete", {"removed": True, "dialogs": 1}),
            ("dialogs-unknown", {"removed": True, "dialogs": "unknown"}),
            ("complete", {"removed": True, "newCallsBlocked": False}),
        ):
            request = EvidenceRequest(self.binding)
            with self.assertRaises(Rejected):
                request.validate(self.envelope(request, outcome, **data), self.binding, self.cancel)
        request = EvidenceRequest(self.binding)
        value = self.envelope(request)
        value["observation"] = None
        with self.assertRaises(Rejected):
            request.validate(value, self.binding, self.cancel)

    def test_lifetime_boundaries_and_changed_authority(self):
        for elapsed, valid in ((0, True), (4.999, True), (5, False), (5.001, False), (-1, False)):
            with patch("evidence.time.monotonic", side_effect=[100, 100 + elapsed]):
                request = EvidenceRequest(self.binding)
                value = self.envelope(request)
                if valid:
                    request.validate(value, self.binding, self.cancel)
                else:
                    with self.assertRaisesRegex(Rejected, "lifetime"):
                        request.validate(value, self.binding, self.cancel)
        for current in (
            replace(self.binding, mapping_revision=2),
            replace(self.binding, runtime_instance=str(uuid.uuid4())),
            replace(self.binding, scope=replace(self.binding.scope, epoch=str(uuid.uuid4()))),
        ):
            request = EvidenceRequest(self.binding)
            with self.assertRaisesRegex(Rejected, "authority changed"):
                request.validate(self.envelope(request), current, self.cancel)

    def test_cancellation_replay_and_invalid_binding(self):
        request = EvidenceRequest(self.binding)
        value = self.envelope(request)
        self.cancel.set()
        with self.assertRaisesRegex(Rejected, "cancelled"):
            request.validate(value, self.binding, self.cancel)
        self.cancel.clear()
        with self.assertRaisesRegex(Rejected, "single-use"):
            request.validate(value, self.binding, self.cancel)
        fresh = EvidenceRequest(self.binding)
        with self.assertRaisesRegex(Rejected, "binding mismatch"):
            fresh.validate(value, self.binding, self.cancel)
        for change in ({"mapping_revision": True}, {"mapping_revision": 0}, {"generation_id": "bad"},
                       {"runtime_instance": "bad"}, {"scope": None}):
            with self.assertRaises(Rejected):
                replace(self.binding, **change)


if __name__ == "__main__":
    if sys.platform == "linux":
        if os.getuid() == 0:
            os.setgroups([])
            os.setgid(2100)
            os.setuid(1101)
        assert os.getuid() != 0
        with open("/proc/self/status", encoding="ascii") as status:
            assert re.search(r"^CapEff:\s+0+$", status.read(), re.MULTILINE)
    unittest.main(verbosity=2)
