from pathlib import Path
import sys
import pytest
ROOT = Path(__file__).resolve().parents[1]
sys.path.append(str(ROOT))

from src.parse_gtfsrt import parse_vehicle_positions


@pytest.fixture
def parsed_records() -> list[dict]:
    fixture_path = Path(__file__).parent / "fixtures" / "vehicle_positions_sample.pb"
    raw_bytes = fixture_path.read_bytes()
    return parse_vehicle_positions(raw_bytes)


def test_parse_fixture_returns_non_empty_list(parsed_records: list[dict]) -> None:
    assert isinstance(parsed_records, list)
    assert len(parsed_records) > 0


def test_parse_fixture_records_have_expected_keys(parsed_records: list[dict]) -> None:
    first_record = parsed_records[0]

    expected_keys = {
        "entity_id",
        "vehicle_id",
        "trip_id",
        "route_id",
        "lat",
        "lon",
        "timestamp",
    }

    assert expected_keys.issubset(first_record.keys())


def test_parse_fixture_lat_lon_and_timestamp_types_are_valid(parsed_records: list[dict]) -> None:
    first_record = parsed_records[0]

    assert first_record["lat"] is None or isinstance(first_record["lat"], float)
    assert first_record["lon"] is None or isinstance(first_record["lon"], float)
    assert isinstance(first_record["timestamp"], int)


def test_parse_fixture_all_records_are_dicts(parsed_records: list[dict]) -> None:
    assert all(isinstance(record, dict) for record in parsed_records)


def test_parse_fixture_contains_at_least_one_record_with_coordinates(parsed_records: list[dict]) -> None:
    assert any(
        record["lat"] is not None and record["lon"] is not None
        for record in parsed_records
    )