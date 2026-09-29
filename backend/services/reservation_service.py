from dataclasses import dataclass
from threading import Lock
from typing import Mapping

reservation_lock = Lock()

@dataclass(frozen=True)
class ReservationResult:
    accepted: bool
    resources: dict[str, int]
    reason: str = ""

def reserve_resources(current: Mapping[str, int], required: Mapping[str, int]) -> ReservationResult:
    """Atomically validate and decrement a resource snapshot for local MVP use.

    A database implementation should replace the process lock with a transaction
    and row-level lock while keeping this contract unchanged.
    """
    with reservation_lock:
        updated = dict(current)
        missing = [key for key, amount in required.items() if updated.get(key, 0) < amount]
        if missing: return ReservationResult(False, dict(current), f"Insufficient resources: {', '.join(missing)}")
        for key, amount in required.items(): updated[key] -= amount
        return ReservationResult(True, updated)
