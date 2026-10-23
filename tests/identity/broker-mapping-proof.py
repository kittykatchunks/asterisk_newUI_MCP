"""Synthetic mapping vectors and ownership conflicts, without runtime objects."""

from dataclasses import replace
import os
from pathlib import Path
import re
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
from ledger import LedgerBinding
from mapping import check_mapping_ownership, derive_mapping, validate_mapping
from readback import Rejected


class MappingTests(unittest.TestCase):
    def setUp(self):
        self.scope = LedgerBinding("customer-a", "11111111-1111-1111-1111-111111111111", "agent")
        self.generation = "22222222-2222-2222-2222-222222222222"
        self.mapping = derive_mapping(self.scope, self.generation)

    def test_independent_node_reference_vector_and_exact_lengths(self):
        digest = "4678f6092cf257c07370d573000db9bbf08af50b168e301c655a1ae98cca23a3"
        for role, suffix in (("endpoint", "e"), ("auth", "a"), ("aor", "r")):
            self.assertEqual(self.mapping[role], f"ag1-{digest}-{suffix}")
            self.assertEqual(len(self.mapping[role].encode("ascii")), 70)
        self.assertEqual(len({self.mapping[role] for role in ("endpoint", "auth", "aor")}), 3)
        self.assertEqual(derive_mapping(self.scope, self.generation), self.mapping)

    def test_all_identity_components_affect_names(self):
        for scope, generation in (
            (replace(self.scope, customer="other"), self.generation),
            (replace(self.scope, epoch="33333333-3333-3333-3333-333333333333"), self.generation),
            (replace(self.scope, namespace="other"), self.generation),
            (self.scope, "33333333-3333-3333-3333-333333333333"),
        ):
            self.assertNotEqual(derive_mapping(scope, generation)["endpoint"], self.mapping["endpoint"])
        with self.assertRaises(Rejected):
            derive_mapping(self.scope, "../bad")

    def test_exact_record_validation_and_detachment(self):
        self.assertIsNot(validate_mapping(self.mapping, self.scope, self.generation), self.mapping)
        for key in self.mapping:
            altered = dict(self.mapping)
            altered[key] = True if key == "version" else "bad"
            with self.assertRaises(Rejected):
                validate_mapping(altered, self.scope, self.generation)
            del altered[key]
            with self.assertRaises(Rejected):
                validate_mapping(altered, self.scope, self.generation)
        with self.assertRaises(Rejected):
            validate_mapping({**self.mapping, "extension": "1001"}, self.scope, self.generation)

    def test_unowned_objects_fail_and_exact_ownership_is_idempotent(self):
        occupied = {self.mapping["endpoint"]}
        with self.assertRaisesRegex(Rejected, "unverified"):
            check_mapping_ownership(self.mapping, [], occupied)
        self.assertEqual(check_mapping_ownership(self.mapping, [self.mapping], occupied), self.mapping)
        self.assertEqual(check_mapping_ownership(self.mapping, [], set()), self.mapping)
        foreign = derive_mapping(replace(self.scope, customer="other"), self.generation)
        self.assertEqual(check_mapping_ownership(self.mapping, [foreign], {foreign["endpoint"]}), self.mapping)
        with self.assertRaises(Rejected):
            check_mapping_ownership(self.mapping, [{**foreign, "endpoint": self.mapping["endpoint"]}], set())

    def test_forced_digest_collision_is_rejected(self):
        with patch("mapping.hashlib.sha256") as digest:
            digest.return_value.hexdigest.return_value = "0" * 64
            first = derive_mapping(self.scope, self.generation)
            second = derive_mapping(replace(self.scope, customer="other"), self.generation)
            with self.assertRaisesRegex(Rejected, "Conflicting"):
                check_mapping_ownership(first, [second], set())
            with self.assertRaisesRegex(Rejected, "Conflicting"):
                check_mapping_ownership(first, [first, second], set())


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
