from pathlib import Path
from google.transit import gtfs_realtime_pb2

feed = gtfs_realtime_pb2.FeedMessage()
feed.header.gtfs_realtime_version = "2.0"

entity = feed.entity.add()
entity.id = "vehicle_1"

vehicle = entity.vehicle

vehicle.vehicle.id = "bus_123"
vehicle.trip.trip_id = "trip_456"
vehicle.trip.route_id = "route_T1"

vehicle.position.latitude = -33.865143
vehicle.position.longitude = 151.209900

vehicle.timestamp = 1700000000

path = Path("services/ingest_lambda/tests/fixtures/vehicle_positions_sample.pb")
path.parent.mkdir(parents=True, exist_ok=True)

path.write_bytes(feed.SerializeToString())

print("fixture created:", path)