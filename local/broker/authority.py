"""Synthetic in-process lifecycle coordination, not a PBX supervisor."""

from dataclasses import dataclass
import threading
import uuid

from evidence import EvidenceBinding, EvidenceRequest
from readback import Rejected


@dataclass
class _Collection:
    session: str
    revision: int
    request: EvidenceRequest
    used: bool = False

    def expected(self):
        return self.request.expected()


class ObservationAuthority:
    """All lifecycle/association assertions must come from a trusted caller."""

    def __init__(self):
        self._lock = threading.Lock()
        self._session = str(uuid.uuid4())
        self._revision = 0
        self._state = "unenrolled"
        self._binding = None

    def state(self):
        with self._lock:
            return self._state

    def start(self, binding: EvidenceBinding):
        if not isinstance(binding, EvidenceBinding):
            raise Rejected("A validated authority binding is required")
        with self._lock:
            if self._state not in ("unenrolled", "invalidated"):
                raise Rejected("Authority must be invalidated before starting")
            self._revision += 1
            self._binding = binding
            self._state = "starting"

    def child_started(self):
        with self._lock:
            if self._state != "starting":
                raise Rejected("Authority child-start transition is out of order")
            self._revision += 1
            self._state = "association-pending"

    def association_verified(self, binding: EvidenceBinding):
        with self._lock:
            if self._state != "association-pending" or binding != self._binding:
                raise Rejected("Authority association transition is invalid")
            self._revision += 1
            self._state = "ready"

    def invalidate(self):
        with self._lock:
            self._revision += 1
            self._state = "invalidated"
            self._binding = None

    def begin(self):
        with self._lock:
            if self._state != "ready":
                raise Rejected("Observation authority is unavailable")
            return _Collection(self._session, self._revision, EvidenceRequest(self._binding))

    def accept(self, collection, value, cancellation: threading.Event):
        with self._lock:
            if not isinstance(collection, _Collection):
                raise Rejected("Invalid authority collection")
            if collection.session != self._session:
                raise Rejected("Collection belongs to another authority session")
            if collection.used:
                raise Rejected("Authority collection is single-use")
            collection.used = True
            if self._state != "ready" or collection.revision != self._revision:
                raise Rejected("Observation authority changed during collection")
            return collection.request.validate(value, self._binding, cancellation)
