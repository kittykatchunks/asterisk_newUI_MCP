"""Local metadata foundation tests; no listener or PBX access."""

from pathlib import Path
import os
import re
import sqlite3
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "local" / "broker"))
from ledger import Ledger, LedgerBinding, initialize_ledger


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
        connection.execute("PRAGMA user_version = 2")
        with self.assertRaisesRegex(ValueError, "Unsupported"):
            ledger.records()


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
