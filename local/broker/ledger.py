"""Broker-owned metadata only; no PBX effects, secrets or runtime observations."""

from contextlib import contextmanager
from dataclasses import dataclass
import os
from pathlib import Path
import re
import sqlite3
import stat

from readback import Binding, UUID, safe_integer


@dataclass(frozen=True)
class LedgerBinding:
    customer: str
    epoch: str
    namespace: str

    def __post_init__(self):
        Binding(self.customer, self.epoch, "ledger", 1, 1)
        if not isinstance(self.namespace, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", self.namespace):
            raise ValueError("Invalid ledger namespace")


def _path(path):
    path = Path(path)
    if not path.is_absolute() or path.parent.resolve() != path.parent:
        raise ValueError("Ledger requires an absolute path with canonical parent")
    return path


@contextmanager
def _connection(path, binding, versions=(1, 2)):
    if not isinstance(binding, LedgerBinding):
        raise ValueError("A validated ledger binding is required")
    path = _path(path)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise ValueError("Ledger requires a regular, unlinked-to-other-paths database")
    connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=0.25)
    try:
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("PRAGMA foreign_keys = ON")
        connection.execute("BEGIN IMMEDIATE")
        if connection.execute("PRAGMA user_version").fetchone()[0] not in versions:
            raise ValueError("Unsupported or uninitialized broker ledger")
        rows = connection.execute(
            "SELECT customer, epoch, namespace FROM broker_binding LIMIT 2").fetchall()
        if rows != [(binding.customer, binding.epoch, binding.namespace)]:
            raise ValueError("Broker ledger binding mismatch")
        yield connection
        connection.commit()
    finally:
        connection.close()


def initialize_ledger(path, binding):
    """Explicit local bootstrap only. An existing path is never initialized."""
    if not isinstance(binding, LedgerBinding):
        raise ValueError("A validated ledger binding is required")
    path = _path(path)
    descriptor = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    connection = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True, timeout=0.25)
    try:
        connection.execute("PRAGMA synchronous = FULL")
        connection.execute("BEGIN IMMEDIATE")
        connection.execute(
            "CREATE TABLE broker_binding (customer TEXT NOT NULL, epoch TEXT NOT NULL, "
            "namespace TEXT NOT NULL) STRICT")
        connection.execute(
            "CREATE TABLE broker_generations (generation_id TEXT PRIMARY KEY NOT NULL, "
            "not_after INTEGER NOT NULL CHECK(not_after BETWEEN 1 AND 9007199254740991)) STRICT")
        connection.execute("INSERT INTO broker_binding VALUES (?, ?, ?)",
                           (binding.customer, binding.epoch, binding.namespace))
        connection.execute("PRAGMA user_version = 1")
        connection.commit()
    finally:
        # Leave a failed bootstrap for explicit investigation; never auto-recreate it.
        connection.close()


class Ledger:
    def __init__(self, path, binding):
        self.path = _path(path)
        self.binding = binding
        with _connection(self.path, self.binding) as connection:
            if connection.execute("PRAGMA user_version").fetchone() == (2,):
                self._mappings(connection)

    @staticmethod
    def _record(generation_id, not_after):
        if (not isinstance(generation_id, str) or not UUID.fullmatch(generation_id)
                or type(not_after) is not int or not safe_integer(not_after, 1)):
            raise ValueError("Invalid broker generation metadata")
        return {"generationId": generation_id, "notAfter": not_after}

    def record(self, generation_id, not_after):
        """Record immutable metadata locally; this does not provision a generation."""
        record = self._record(generation_id, not_after)
        with _connection(self.path, self.binding) as connection:
            version = connection.execute("PRAGMA user_version").fetchone()[0]
            if version == 2:
                self._mappings(connection)
            row = connection.execute(
                "SELECT not_after FROM broker_generations WHERE generation_id = ?", (generation_id,)).fetchone()
            if row is None:
                connection.execute("INSERT INTO broker_generations VALUES (?, ?)", (generation_id, not_after))
                if version == 2:
                    _insert_mapping(connection, self.binding, generation_id)
            elif row != (not_after,):
                raise ValueError("Broker generation metadata conflict")
        return record

    def records(self):
        with _connection(self.path, self.binding) as connection:
            if connection.execute("PRAGMA user_version").fetchone() == (2,):
                self._mappings(connection)
            return [self._record(*row) for row in connection.execute(
                "SELECT generation_id, not_after FROM broker_generations ORDER BY generation_id")]

    def _mappings(self, connection):
        from mapping import validate_mapping

        generations = {self._record(*row)["generationId"] for row in connection.execute(
            "SELECT generation_id, not_after FROM broker_generations")}
        result = []
        for generation_id, version, revision, endpoint, auth, aor in connection.execute(
                "SELECT generation_id, derivation_version, mapping_revision, endpoint, auth, aor "
                "FROM broker_mappings ORDER BY generation_id"):
            if type(revision) is not int or revision != 1 or generation_id not in generations:
                raise ValueError("Invalid ledger mapping association or revision")
            value = validate_mapping({
                "version": version, "customer": self.binding.customer, "epoch": self.binding.epoch,
                "namespace": self.binding.namespace, "generationId": generation_id,
                "endpoint": endpoint, "auth": auth, "aor": aor,
            }, self.binding, generation_id)
            result.append({**value, "mappingRevision": revision})
        if {value["generationId"] for value in result} != generations:
            raise ValueError("Missing ledger generation mapping")
        return result

    def mappings(self):
        with _connection(self.path, self.binding, versions=(2,)) as connection:
            return self._mappings(connection)


def _insert_mapping(connection, binding, generation_id):
    from mapping import derive_mapping

    value = derive_mapping(binding, generation_id)
    connection.execute("INSERT INTO broker_mappings VALUES (?, ?, 1, ?, ?, ?)",
                       (generation_id, value["version"], value["endpoint"], value["auth"], value["aor"]))


def migrate_ledger_mappings(path, binding):
    """Explicit local v1 -> v2 migration; all DDL, records and version commit together."""
    with _connection(path, binding, versions=(1,)) as connection:
        connection.execute(
            "CREATE TABLE broker_mappings ("
            "generation_id TEXT PRIMARY KEY NOT NULL REFERENCES broker_generations(generation_id), "
            "derivation_version INTEGER NOT NULL CHECK(derivation_version = 1), "
            "mapping_revision INTEGER NOT NULL CHECK(mapping_revision = 1), "
            "endpoint TEXT NOT NULL UNIQUE, auth TEXT NOT NULL UNIQUE, aor TEXT NOT NULL UNIQUE) STRICT")
        for generation_id, not_after in connection.execute(
                "SELECT generation_id, not_after FROM broker_generations ORDER BY generation_id").fetchall():
            Ledger._record(generation_id, not_after)
            _insert_mapping(connection, binding, generation_id)
        connection.execute("PRAGMA user_version = 2")
