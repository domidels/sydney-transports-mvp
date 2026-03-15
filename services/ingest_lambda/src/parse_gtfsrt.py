"""
parse_gtfsrt.py — GTFS-RT protobuf parser.

Converts a raw GTFS-Realtime binary payload (VehiclePositions feed)
into a list of plain Python dicts that the rest of the ingest pipeline
can work with without depending on protobuf types.

The NSW Transport GTFS-RT vehicle positions feed is fetched from:
  https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses
"""

from google.transit import gtfs_realtime_pb2


def parse_vehicle_positions(raw_bytes: bytes) -> list[dict]:
    """
    Parse a GTFS-Realtime VehiclePositions protobuf binary into a list of dicts.

    Each dict represents one vehicle entity from the feed and contains only the
    fields relevant to the live map (position, trip, route).  Fields that are
    absent from the protobuf message are set to None rather than raising an
    AttributeError, so downstream code can do simple null-checks.

    Args:
        raw_bytes: Raw protobuf bytes as returned by the NSW Transport API.

    Returns:
        List of vehicle dicts with the following keys:
            entity_id   (str)   – Feed entity ID (unique within the feed message).
            vehicle_id  (str|None) – Physical vehicle identifier.
            trip_id     (str|None) – GTFS trip ID for the current service run.
            route_id    (str|None) – GTFS route ID (e.g. "NSWTrains_390X_...").
            direction_id (int|None) – 0 or 1 per GTFS spec (currently always 0 in NSW feed).
            lat         (float|None) – WGS-84 latitude.
            lon         (float|None) – WGS-84 longitude.
            timestamp   (int)   – Unix epoch seconds of the last GPS fix.
    """
    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(raw_bytes)

    records = []

    for entity in feed.entity:
        # Skip entities that carry no vehicle position data.
        if not entity.HasField("vehicle"):
            continue

        vehicle = entity.vehicle

        records.append(
            {
                "entity_id": entity.id,
                # vehicle.vehicle is an optional sub-message — guard with HasField.
                "vehicle_id": vehicle.vehicle.id
                if vehicle.HasField("vehicle")
                else None,
                # trip info is optional; absent for vehicles between services.
                "trip_id": vehicle.trip.trip_id if vehicle.HasField("trip") else None,
                "route_id": vehicle.trip.route_id if vehicle.HasField("trip") else None,
                "direction_id": vehicle.trip.direction_id
                if vehicle.HasField("trip")
                else None,
                # position is optional; absent if GPS fix is unavailable.
                "lat": vehicle.position.latitude
                if vehicle.HasField("position")
                else None,
                "lon": vehicle.position.longitude
                if vehicle.HasField("position")
                else None,
                "timestamp": vehicle.timestamp,
            }
        )

    return records
