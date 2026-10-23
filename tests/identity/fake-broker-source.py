"""Test-only reader for fake-provisioning-runtime.ts; never a PBX source."""

from contextlib import contextmanager
from pathlib import Path
import sqlite3

import readback as broker


class FakeRuntimeSource:
    def __init__(self, path, binding):
        self.path = Path(path)
        if not self.path.is_absolute() or not isinstance(binding, broker.Binding):
            raise ValueError("An absolute fake database path and broker binding are required")
        self.binding = binding

    @staticmethod
    def _check(cancellation):
        if cancellation.is_set():
            raise InterruptedError("Fake source read cancelled")

    @contextmanager
    def _snapshot(self, cancellation):
        self._check(cancellation)
        connection = sqlite3.connect(self.path.as_uri() + "?mode=ro", uri=True, timeout=0.25)
        try:
            connection.row_factory = sqlite3.Row
            connection.set_progress_handler(lambda: int(cancellation.is_set()), 100)
            connection.execute("PRAGMA query_only = ON")
            connection.execute("BEGIN")
            rows = connection.execute("SELECT customer, epoch FROM fake_binding LIMIT 2").fetchall()
            if (len(rows) != 1 or rows[0]["customer"] != self.binding.customer
                    or rows[0]["epoch"] != self.binding.epoch):
                raise ValueError("Fake runtime binding mismatch")
            self._check(cancellation)
            yield connection
            self._check(cancellation)
        finally:
            connection.close()

    @staticmethod
    def _state(row):
        if (row is None or not isinstance(row["id"], str) or not broker.UUID.fullmatch(row["id"])
                or not isinstance(row["extension"], str) or not broker.safe_integer(row["deadline"], 1)
                or row["phase"] not in ("prepared", "active", "draining", "removed")
                or not broker.safe_integer(row["dialogs"], -1)):
            raise ValueError("Invalid or missing fake generation")
        return row

    def inventory(self, cancellation):
        with self._snapshot(cancellation) as connection:
            rows = connection.execute(
                "SELECT * FROM fake_generations WHERE phase != 'removed' ORDER BY id LIMIT 101"
            ).fetchall()
            result = []
            for row in rows:
                state = self._state(row)
                result.append({"generationId": state["id"], "notAfter": state["deadline"],
                               "draining": state["phase"] == "draining"})
            return broker.inventory(result)

    def generation(self, generation_id, cancellation):
        if not isinstance(generation_id, str) or not broker.UUID.fullmatch(generation_id):
            raise ValueError("Invalid fake generation ID")
        with self._snapshot(cancellation) as connection:
            state = self._state(connection.execute(
                "SELECT * FROM fake_generations WHERE id = ?", (generation_id,)
            ).fetchone())
            return broker.observation({
                "newCallsBlocked": state["phase"] != "active",
                "dialogs": "unknown" if state["dialogs"] == -1 else state["dialogs"],
                "removed": state["phase"] == "removed",
            })
