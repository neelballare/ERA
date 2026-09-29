import time

from backend.services.allocation_engine import rank_hospitals
from backend.services.reservation_service import reserve_resources


def hospital(identifier, name, resources, updated_at=None, lat=18.52, lng=73.85):
    return {"id": identifier, "name": name, "resources": resources, "updated_at": updated_at or time.time()}


def test_missing_mandatory_resource_is_ineligible():
    result = rank_hospitals(hospitals=[hospital("H-01", "Care", {"icu": 2, "trauma": 0})], requirements={"icu": 1, "trauma": 1}, ambulance_location=(18.52, 73.85), now_timestamp=time.time())
    assert result[0].eligible is False
    assert "Trauma team" in result[0].missing_resources
    assert result[0].resource_score == 50


def test_capacity_and_freshness_are_transparent():
    now = time.time()
    results = rank_hospitals(hospitals=[hospital("A", "Near", {"icu": 1}, now - 10), hospital("B", "Spare", {"icu": 4}, now - 10)], requirements={"icu": 1}, ambulance_location=(18.52, 73.85), now_timestamp=now)
    assert results[0].freshness_score == 100
    assert next(item for item in results if item.hospital_id == "B").capacity_score > next(item for item in results if item.hospital_id == "A").capacity_score


def test_two_requests_cannot_reserve_the_last_icu_bed():
    first = reserve_resources({"icu": 1}, {"icu": 1})
    second = reserve_resources(first.resources, {"icu": 1})
    assert first.accepted is True
    assert second.accepted is False
    assert second.reason
