"""Pure hospital eligibility and ranking logic.

The engine intentionally depends on simple dictionaries so it can be tested
without FastAPI or a database and replaced with a real routing provider later.
"""
from dataclasses import dataclass
from math import asin, cos, radians, sin, sqrt
from typing import Mapping

RESOURCE_LABELS = {
    "icu": "ICU bed", "ventilator": "Ventilator", "ot": "Operating theatre",
    "trauma": "Trauma team", "bloodOneg": "O-negative blood",
    "cardiology": "Cardiology", "neuro": "Neurology", "pediatric": "Pediatrics",
}
DEFAULT_WEIGHTS = {"resource": 45, "travel": 25, "freshness": 15, "capacity": 15}

@dataclass(frozen=True)
class RankingResult:
    hospital_id: str
    hospital_name: str
    hospital_address: str
    hospital_resources: dict
    hospital_lat: float
    hospital_lng: float
    eligible: bool
    final_score: float
    resource_score: float
    travel_score: float
    freshness_score: float
    capacity_score: float
    distance_km: float
    eta_minutes: int
    freshness_age_seconds: int
    missing_resources: tuple[str, ...]
    resource_details: tuple[dict, ...]

    def as_dict(self) -> dict:
        return {
            "hospital_id": self.hospital_id, "hospital_name": self.hospital_name,
            "hospital_address": self.hospital_address, "hospital_resources": self.hospital_resources,
            "hospital_lat": self.hospital_lat, "hospital_lng": self.hospital_lng,
            "eligible": self.eligible, "final_score": round(self.final_score, 1),
            "resource_score": round(self.resource_score, 1), "travel_score": round(self.travel_score, 1),
            "freshness_score": round(self.freshness_score, 1), "capacity_score": round(self.capacity_score, 1),
            "distance_km": round(self.distance_km, 1), "eta_minutes": self.eta_minutes,
            "freshness_age_seconds": self.freshness_age_seconds,
            "missing_resources": list(self.missing_resources), "resource_details": list(self.resource_details),
        }

def haversine_km(origin: tuple[float, float], destination: tuple[float, float]) -> float:
    lat1, lng1, lat2, lng2 = map(radians, (*origin, *destination))
    dlat, dlng = lat2 - lat1, lng2 - lng1
    value = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlng / 2) ** 2
    return 6371 * 2 * asin(sqrt(value))

def freshness_score(age_seconds: int) -> float:
    if age_seconds <= 30: return 100.0
    if age_seconds <= 120: return 85.0
    if age_seconds <= 300: return 60.0
    return max(0.0, 20.0 - min(20.0, (age_seconds - 300) / 60))

def rank_hospitals(*, hospitals: list[Mapping], requirements: Mapping[str, int], ambulance_location: tuple[float, float], now_timestamp: float, weights: Mapping[str, float] | None = None, speed_kmh: float = 30.0) -> list[RankingResult]:
    weights = weights or DEFAULT_WEIGHTS
    results: list[RankingResult] = []
    for hospital in hospitals:
        resources = hospital.get("resources", {})
        details = []
        missing = []
        for key, required in requirements.items():
            available = int(resources.get(key, 0))
            ok = available >= required
            details.append({"key": key, "label": RESOURCE_LABELS.get(key, key), "required": required, "available": available, "sufficient": ok})
            if not ok: missing.append(RESOURCE_LABELS.get(key, key))
        resource_score = (sum(item["sufficient"] for item in details) / len(details) * 100) if details else 100.0
        distance = haversine_km(ambulance_location, (float(hospital["lat"]), float(hospital["lng"])))
        eta = max(2, round(distance / speed_kmh * 60 * 1.2))
        travel_score = max(0.0, 100.0 - eta * 2.4)
        age = max(0, int(now_timestamp - float(hospital["updated_at"])))
        fresh_score = freshness_score(age)
        spare_scores = [min(2.0, resources.get(key, 0) / max(1, required)) for key, required in requirements.items()]
        capacity_score = min(100.0, sum(spare_scores) / len(spare_scores) * 50) if spare_scores else 70.0
        final = (resource_score * weights["resource"] + travel_score * weights["travel"] + fresh_score * weights["freshness"] + capacity_score * weights["capacity"]) / 100
        if missing: final = max(0.0, final - 35)
        results.append(RankingResult(hospital_id=hospital["id"], hospital_name=hospital["name"], hospital_address=hospital.get("address", ""), hospital_resources=dict(resources), hospital_lat=float(hospital["lat"]), hospital_lng=float(hospital["lng"]), eligible=not missing, final_score=final, resource_score=resource_score, travel_score=travel_score, freshness_score=fresh_score, capacity_score=capacity_score, distance_km=distance, eta_minutes=eta, freshness_age_seconds=age, missing_resources=tuple(missing), resource_details=tuple(details)))
    return sorted(results, key=lambda item: (not item.eligible, -item.final_score))
