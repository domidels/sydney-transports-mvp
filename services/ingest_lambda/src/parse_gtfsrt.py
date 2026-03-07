from google.transit import gtfs_realtime_pb2


def parse_vehicle_positions(raw_bytes: bytes):

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(raw_bytes)

    records = []

    for entity in feed.entity:
        if not entity.HasField("vehicle"):
            continue

        vehicle = entity.vehicle

        records.append(
            {
                "entity_id": entity.id,
                "vehicle_id": vehicle.vehicle.id if vehicle.HasField("vehicle") else None,
                "trip_id": vehicle.trip.trip_id if vehicle.HasField("trip") else None,
                "route_id": vehicle.trip.route_id if vehicle.HasField("trip") else None,
                "lat": vehicle.position.latitude if vehicle.HasField("position") else None,
                "lon": vehicle.position.longitude if vehicle.HasField("position") else None,
                "timestamp": vehicle.timestamp,
            }
        )

    return records