"""Broker-side synthetic evidence contract; no collector, IPC or PBX adapter."""

from dataclasses import dataclass
import threading
import time
import uuid

from ledger import LedgerBinding
from readback import Rejected, UUID, observation, safe_integer


class EvidenceUnavailable(RuntimeError):
    """The observation authority explicitly could not supply evidence."""


@dataclass(frozen=True)
class EvidenceBinding:
    scope: LedgerBinding
    generation_id: str
    mapping_revision: int
    runtime_instance: str

    def __post_init__(self):
        if (not isinstance(self.scope, LedgerBinding)
                or not isinstance(self.generation_id, str) or not UUID.fullmatch(self.generation_id)
                or type(self.mapping_revision) is not int or not safe_integer(self.mapping_revision, 1)
                or not isinstance(self.runtime_instance, str) or not UUID.fullmatch(self.runtime_instance)):
            raise Rejected("Invalid evidence binding")


class EvidenceRequest:
    """One local validation attempt; elapsed time never comes from the producer."""

    def __init__(self, binding: EvidenceBinding):
        if not isinstance(binding, EvidenceBinding):
            raise Rejected("A validated evidence binding is required")
        self._binding = binding
        self._request_id = str(uuid.uuid4())
        self._started = time.monotonic()
        self._used = False
        self._lock = threading.Lock()

    def expected(self):
        binding = self._binding
        return {
            "version": 1, "customer": binding.scope.customer, "epoch": binding.scope.epoch,
            "namespace": binding.scope.namespace, "generationId": binding.generation_id,
            "mappingRevision": binding.mapping_revision, "runtimeInstance": binding.runtime_instance,
            "requestId": self._request_id,
        }

    def validate(self, value, current: EvidenceBinding, cancellation: threading.Event):
        with self._lock:
            if self._used:
                raise Rejected("Evidence request is single-use")
            self._used = True
        if cancellation.is_set():
            raise Rejected("Evidence request cancelled")
        elapsed = time.monotonic() - self._started
        if not 0 <= elapsed < 5:
            raise Rejected("Evidence collection lifetime expired")
        if not isinstance(current, EvidenceBinding) or current != self._binding:
            raise Rejected("Evidence authority changed during collection")
        expected = self.expected()
        if (not isinstance(value, dict)
                or type(value.get("version")) is not int or type(value.get("mappingRevision")) is not int
                or any(value.get(key) != item for key, item in expected.items())):
            raise Rejected("Evidence binding mismatch")
        outcome = value.get("outcome")
        fields = set(expected) | {"outcome"}
        if outcome == "unavailable":
            if set(value) != fields:
                raise Rejected("Invalid unavailable evidence")
            raise EvidenceUnavailable("Generation evidence unavailable")
        if outcome not in ("complete", "dialogs-unknown") or set(value) != fields | {"observation"}:
            raise Rejected("Invalid evidence outcome or fields")
        result = observation(value["observation"])
        if (outcome == "dialogs-unknown") != (result["dialogs"] == "unknown"):
            raise Rejected("Evidence dialog completeness mismatch")
        if result["removed"] and (not result["newCallsBlocked"] or result["dialogs"] != 0):
            raise Rejected("Contradictory removal evidence")
        return result
