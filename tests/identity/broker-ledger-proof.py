"""Local metadata foundation tests; no listener or PBX access."""

from pathlib import Path
import os
import re
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
from ledger import Ledger, LedgerBinding, initialize_ledger, migrate_ledger_mappings
from mapping import derive_mapping


class LedgerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "ledger #1.sqlite"
        self.binding = LedgerBinding("customer-a", str(uuid.uuid4()), "agent")
        self.generation = str(uuid.uuid4())

    def test_explicit_initialization_and_persistent_immutable_records(self):
        with self.assertRaises(FileNotFoundError):
            Ledger(self.path, self.binding)
        self.assertFalse(self.path.exists())
        initialize_ledger(self.path, self.binding)
        if sys.platform == "linux":
            self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        ledger = Ledger(self.path, self.binding)
        self.assertEqual(ledger.records(), [])
        expected = {"generationId": self.generation, "notAfter": 160000}
        self.assertEqual(ledger.record(self.generation, 160000), expected)
        self.assertEqual(ledger.record(self.generation, 160000), expected)
        with self.assertRaisesRegex(ValueError, "conflict"):
            ledger.record(self.generation, 160001)
        self.assertEqual(Ledger(self.path, self.binding).records(), [expected])
        with self.assertRaises(FileExistsError):
            initialize_ledger(self.path, self.binding)
        self.assertEqual(ledger.records(), [expected])

    def test_binding_rechecked_on_every_operation(self):
        initialize_ledger(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        for binding in (
            LedgerBinding("other", self.binding.epoch, "agent"),
            LedgerBinding("customer-a", str(uuid.uuid4()), "agent"),
            LedgerBinding("customer-a", self.binding.epoch, "other"),
        ):
            with self.assertRaisesRegex(ValueError, "binding mismatch"):
                Ledger(self.path, binding)
        connection = sqlite3.connect(self.path)
        self.addCleanup(connection.close)
        connection.execute("DELETE FROM broker_binding")
        connection.commit()
        for operation in (ledger.records, lambda: ledger.record(self.generation, 160000)):
            with self.assertRaisesRegex(ValueError, "binding mismatch"):
                operation()
        self.assertEqual(connection.execute("SELECT count(*) FROM broker_generations").fetchone(), (0,))

    def test_invalid_inputs_and_uninitialized_existing_database(self):
        with self.assertRaises(ValueError):
            LedgerBinding("customer-a", self.binding.epoch, "../bad")
        with self.assertRaises(ValueError):
            initialize_ledger(Path("relative.sqlite"), self.binding)
        self.path.touch()
        with self.assertRaises(FileExistsError):
            initialize_ledger(self.path, self.binding)
        with self.assertRaisesRegex(ValueError, "uninitialized"):
            Ledger(self.path, self.binding)
        self.path.unlink()
        initialize_ledger(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        for generation, deadline in (("bad", 1), (self.generation, True), (self.generation, 0),
                                     (self.generation, 1.0), (self.generation, 9007199254740992)):
            with self.assertRaises(ValueError):
                ledger.record(generation, deadline)
        self.assertEqual(ledger.records(), [])

    def test_lock_failure_then_recovery_and_unknown_schema(self):
        initialize_ledger(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        connection = sqlite3.connect(self.path)
        self.addCleanup(connection.close)
        connection.execute("BEGIN EXCLUSIVE")
        try:
            with self.assertRaises(sqlite3.OperationalError) as failure:
                ledger.record(self.generation, 160000)
            self.assertEqual(failure.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
        finally:
            connection.rollback()
        ledger.record(self.generation, 160000)
        connection.execute("PRAGMA user_version = 3")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            ledger.records()

    def test_explicit_migration_preserves_records_and_persists_exact_mapping(self):
        initialize_ledger(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        expected = ledger.record(self.generation, 160000)
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            ledger.mappings()
        self.assertEqual(ledger.records(), [expected])
        migrate_ledger_mappings(self.path, self.binding)
        mapping = {**derive_mapping(self.binding, self.generation), "mappingRevision": 1}
        self.assertEqual(ledger.mappings(), [mapping])
        self.assertEqual(Ledger(self.path, self.binding).records(), [expected])
        self.assertEqual(ledger.record(self.generation, 160000), expected)
        with self.assertRaisesRegex(ValueError, "conflict"):
            ledger.record(self.generation, 160001)
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            migrate_ledger_mappings(self.path, self.binding)
        second = str(uuid.uuid4())
        ledger.record(second, 170000)
        self.assertEqual({row["generationId"] for row in ledger.mappings()}, {self.generation, second})
        connection = sqlite3.connect(self.path)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone(), (2,))
            self.assertEqual(connection.execute("SELECT count(*) FROM broker_mappings").fetchone(), (2,))
        finally:
            connection.close()

    def test_migration_failure_rolls_back_schema_rows_and_version(self):
        initialize_ledger(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        for index in range(2):
            ledger.record(f"22222222-2222-2222-2222-{index:012x}", 160000 + index)
        before = ledger.records()
        with patch("mapping.hashlib.sha256") as digest:
            digest.return_value.hexdigest.return_value = "0" * 64
            with self.assertRaises(sqlite3.IntegrityError):
                migrate_ledger_mappings(self.path, self.binding)
        connection = sqlite3.connect(self.path)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone(), (1,))
            self.assertEqual(connection.execute(
                "SELECT name FROM sqlite_master WHERE name = 'broker_mappings'").fetchall(), [])
        finally:
            connection.close()
        self.assertEqual(ledger.records(), before)
        migrate_ledger_mappings(self.path, self.binding)
        self.assertEqual(len(ledger.mappings()), 2)

    def test_v2_insert_conflict_rolls_back_generation_metadata(self):
        initialize_ledger(self.path, self.binding)
        migrate_ledger_mappings(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        with patch("mapping.hashlib.sha256") as digest:
            digest.return_value.hexdigest.return_value = "0" * 64
            ledger.record(self.generation, 160000)
            with self.assertRaises(sqlite3.IntegrityError):
                ledger.record(str(uuid.uuid4()), 170000)
            self.assertEqual(ledger.records(), [{"generationId": self.generation, "notAfter": 160000}])
            self.assertEqual(len(ledger.mappings()), 1)

    def test_corrupt_or_missing_mapping_fails_reads_and_writes(self):
        initialize_ledger(self.path, self.binding)
        migrate_ledger_mappings(self.path, self.binding)
        ledger = Ledger(self.path, self.binding)
        ledger.record(self.generation, 160000)
        connection = sqlite3.connect(self.path)
        self.addCleanup(connection.close)
        connection.execute("UPDATE broker_mappings SET endpoint = 'tampered'")
        connection.commit()
        for operation in (lambda: Ledger(self.path, self.binding), ledger.records, ledger.mappings,
                          lambda: ledger.record(str(uuid.uuid4()), 1)):
            with self.assertRaisesRegex(ValueError, "mapping mismatch"):
                operation()
        connection.execute("DELETE FROM broker_mappings")
        connection.commit()
        for operation in (ledger.records, ledger.mappings, lambda: ledger.record(self.generation, 160000)):
            with self.assertRaisesRegex(ValueError, "Missing ledger"):
                operation()
        self.assertEqual(connection.execute("SELECT count(*) FROM broker_generations").fetchone(), (1,))

    def test_migration_rejects_wrong_binding_and_locks_without_schema_changes(self):
        initialize_ledger(self.path, self.binding)
        wrong = LedgerBinding("other", self.binding.epoch, self.binding.namespace)
        with self.assertRaisesRegex(ValueError, "binding mismatch"):
            migrate_ledger_mappings(self.path, wrong)
        connection = sqlite3.connect(self.path)
        self.addCleanup(connection.close)
        connection.execute("BEGIN EXCLUSIVE")
        try:
            with self.assertRaises(sqlite3.OperationalError) as failure:
                migrate_ledger_mappings(self.path, self.binding)
            self.assertEqual(failure.exception.sqlite_errorcode, sqlite3.SQLITE_BUSY)
        finally:
            connection.rollback()
        self.assertEqual(connection.execute("PRAGMA user_version").fetchone(), (1,))
        self.assertEqual(connection.execute(
            "SELECT name FROM sqlite_master WHERE name = 'broker_mappings'").fetchall(), [])
        migrate_ledger_mappings(self.path, self.binding)
        self.assertEqual(Ledger(self.path, self.binding).mappings(), [])


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
