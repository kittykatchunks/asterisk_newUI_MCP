"""Synthetic lifecycle facts only; no real process or connection attestation."""

import os
from pathlib import Path
import re
import sys
import threading
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
from authority import ObservationAuthority
from evidence import EvidenceBinding, EvidenceRequest, EvidenceUnavailable
from ledger import LedgerBinding
from readback import Rejected


class AuthorityTests(unittest.TestCase):
    def setUp(self):
        self.binding = EvidenceBinding(
            LedgerBinding("customer-a", str(uuid.uuid4()), "agent"), str(uuid.uuid4()), 1, str(uuid.uuid4()))
        self.authority = ObservationAuthority()
        self.cancel = threading.Event()

    def ready(self, authority=None):
        authority = authority or self.authority
        authority.start(self.binding)
        authority.child_started()
        authority.association_verified(self.binding)

    def envelope(self, collection):
        return {**collection.expected(), "outcome": "complete",
                "observation": {"newCallsBlocked": True, "dialogs": 0, "removed": False}}

    def test_ordered_states_and_unavailable_collection(self):
        self.assertEqual(self.authority.state(), "unenrolled")
        with self.assertRaisesRegex(Rejected, "unavailable"):
            self.authority.begin()
        with self.assertRaises(Rejected):
            self.authority.child_started()
        with self.assertRaises(Rejected):
            self.authority.association_verified(self.binding)
        self.authority.start(self.binding)
        self.assertEqual(self.authority.state(), "starting")
        with self.assertRaises(Rejected):
            self.authority.association_verified(self.binding)
        with self.assertRaises(Rejected):
            self.authority.begin()
        self.authority.child_started()
        self.assertEqual(self.authority.state(), "association-pending")
        with self.assertRaises(Rejected):
            self.authority.begin()
        self.authority.association_verified(self.binding)
        self.assertEqual(self.authority.state(), "ready")
        with self.assertRaises(Rejected):
            self.authority.start(self.binding)
        collection = self.authority.begin()
        self.assertEqual(self.authority.accept(collection, self.envelope(collection), self.cancel)["dialogs"], 0)

    def test_same_binding_aba_never_revives_old_collection(self):
        self.ready()
        old = self.authority.begin()
        value = self.envelope(old)
        self.authority.invalidate()
        self.assertEqual(self.authority.state(), "invalidated")
        self.ready()
        with self.assertRaisesRegex(Rejected, "changed"):
            self.authority.accept(old, value, self.cancel)
        with self.assertRaisesRegex(Rejected, "single-use"):
            self.authority.accept(old, value, self.cancel)
        fresh = self.authority.begin()
        self.authority.accept(fresh, self.envelope(fresh), self.cancel)

    def test_replacement_session_and_single_use_failures(self):
        self.ready()
        collection = self.authority.begin()
        replacement = ObservationAuthority()
        self.ready(replacement)
        with self.assertRaisesRegex(Rejected, "another authority session"):
            replacement.accept(collection, self.envelope(collection), self.cancel)
        value = {**collection.expected(), "outcome": "unavailable"}
        with self.assertRaises(EvidenceUnavailable):
            self.authority.accept(collection, value, self.cancel)
        with self.assertRaisesRegex(Rejected, "single-use"):
            self.authority.accept(collection, value, self.cancel)
        collection = self.authority.begin()
        self.cancel.set()
        with self.assertRaisesRegex(Rejected, "cancelled"):
            self.authority.accept(collection, self.envelope(collection), self.cancel)
        self.cancel.clear()
        with self.assertRaisesRegex(Rejected, "single-use"):
            self.authority.accept(collection, self.envelope(collection), self.cancel)

    def test_invalidation_and_acceptance_share_coordination_lock(self):
        self.ready()
        collection = self.authority.begin()
        entered, release, attempted, invalidated = (threading.Event() for _ in range(4))
        results, failures = [], []
        original = EvidenceRequest.validate

        def held(request, *args):
            entered.set()
            if not release.wait(2):
                raise AssertionError("Test failed to release validation")
            return original(request, *args)

        def accept():
            try:
                results.append(self.authority.accept(collection, self.envelope(collection), self.cancel))
            except Exception as error:
                failures.append(error)

        def invalidate():
            attempted.set()
            self.authority.invalidate()
            invalidated.set()

        with patch.object(EvidenceRequest, "validate", held):
            accepting = threading.Thread(target=accept)
            invalidating = threading.Thread(target=invalidate)
            accepting.start()
            try:
                self.assertTrue(entered.wait(2))
                invalidating.start()
                self.assertTrue(attempted.wait(2))
                self.assertFalse(invalidated.is_set())
            finally:
                release.set()
                accepting.join(3)
                if invalidating.ident is not None:
                    invalidating.join(3)
            self.assertFalse(accepting.is_alive())
            self.assertFalse(invalidating.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(results), 1)
        self.assertTrue(invalidated.is_set())
        with self.assertRaisesRegex(Rejected, "unavailable"):
            self.authority.begin()


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
