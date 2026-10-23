"""Pure generation naming and synthetic ownership checks; no PBX access."""

import hashlib
import json

from ledger import LedgerBinding
from readback import Rejected, UUID


def derive_mapping(scope: LedgerBinding, generation_id: str):
    if (not isinstance(scope, LedgerBinding) or not isinstance(generation_id, str)
            or not UUID.fullmatch(generation_id)):
        raise Rejected("Invalid generation mapping identity")
    encoded = json.dumps(
        ["agent-runtime-mapping", "1", scope.customer, scope.epoch, scope.namespace, generation_id],
        separators=(",", ":"), ensure_ascii=True,
    ).encode("ascii")
    prefix = "ag1-" + hashlib.sha256(encoded).hexdigest()
    return {
        "version": 1, "customer": scope.customer, "epoch": scope.epoch,
        "namespace": scope.namespace, "generationId": generation_id,
        "endpoint": prefix + "-e", "auth": prefix + "-a", "aor": prefix + "-r",
    }


def validate_mapping(value, scope: LedgerBinding, generation_id: str):
    expected = derive_mapping(scope, generation_id)
    if (not isinstance(value, dict) or type(value.get("version")) is not int
            or value != expected):
        raise Rejected("Generation mapping mismatch")
    return expected


def check_mapping_ownership(candidate, owners, occupied):
    """Check synthetic records; caller must supply complete, trusted ownership."""
    if not isinstance(candidate, dict):
        raise Rejected("Invalid generation mapping")
    scope = LedgerBinding(candidate.get("customer"), candidate.get("epoch"), candidate.get("namespace"))
    mapping = validate_mapping(candidate, scope, candidate.get("generationId"))
    if (not isinstance(owners, list) or not isinstance(occupied, set)
            or any(not isinstance(name, str) for name in occupied)):
        raise Rejected("Invalid mapping ownership snapshot")
    known = {}
    for record in owners:
        if not isinstance(record, dict):
            raise Rejected("Invalid mapping ownership record")
        owner_scope = LedgerBinding(record.get("customer"), record.get("epoch"), record.get("namespace"))
        owner = validate_mapping(record, owner_scope, record.get("generationId"))
        for role in ("endpoint", "auth", "aor"):
            name = owner[role]
            if name in known and known[name] != owner:
                raise Rejected("Conflicting generation mapping ownership")
            known[name] = owner
    for role in ("endpoint", "auth", "aor"):
        name = mapping[role]
        if name in known and known[name] != mapping:
            raise Rejected("Conflicting generation mapping ownership")
        if name in occupied and name not in known:
            raise Rejected("Runtime object ownership is unverified")
    return mapping
