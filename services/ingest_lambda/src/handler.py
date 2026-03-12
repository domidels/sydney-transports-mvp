import json
import os
import time
from datetime import UTC, datetime
from pathlib import Path

import boto3
import requests
from dotenv import load_dotenv
from logging_config import get_logger
from parse_gtfsrt import parse_vehicle_positions

ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"

if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TFNSW_API_KEY = os.getenv("TFNSW_API_KEY")
TFNSW_VEHICLEPOS_URL = os.getenv(
    "TFNSW_VEHICLEPOS_URL",
    "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
)
RAW_BUCKET_NAME = os.getenv("RAW_BUCKET_NAME")
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "5"))
POLL_WINDOW_SECONDS = int(os.getenv("POLL_WINDOW_SECONDS", "55"))

logger = get_logger(__name__, LOG_LEVEL)

TARGET_ROUTES = {"390X", "379", "370", "313", "373", "350", "333"}
LATEST_KEY = "latest/buses_latest.json"


def extract_route_short_name(route_id: str | None) -> str | None:
    if not route_id:
        return None
    return route_id[5:] if len(route_id) > 5 else route_id


def build_latest_payload(filtered_records: list[dict]) -> dict:
    now = datetime.now(UTC)
    return {
        "generated_at_utc": now.isoformat(),
        "routes": sorted(TARGET_ROUTES),
        "vehicle_count": len(filtered_records),
        "vehicles": filtered_records,
    }


def fetch_filtered_records() -> list[dict]:
    response = requests.get(
        TFNSW_VEHICLEPOS_URL,
        headers={"Authorization": f"apikey {TFNSW_API_KEY}"},
        timeout=30,
    )
    response.raise_for_status()

    records = parse_vehicle_positions(response.content)

    filtered_records = [
        record
        for record in records
        if extract_route_short_name(record.get("route_id")) in TARGET_ROUTES
    ]

    logger.info(
        "Total vehicles=%s | filtered vehicles=%s",
        len(records),
        len(filtered_records),
    )

    if records:
        sample_route_ids = sorted(
            {record.get("route_id") for record in records if record.get("route_id")}
        )[:30]
        logger.info("Sample route_ids seen: %s", sample_route_ids)

    return filtered_records


def write_latest_payload(payload: dict) -> None:
    if not RAW_BUCKET_NAME:
        logger.info("RAW_BUCKET_NAME not set, skipping S3 write for local test")
        logger.info("Latest payload preview: %s", payload)
        return

    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=RAW_BUCKET_NAME,
        Key=LATEST_KEY,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-store",
    )

    logger.info("Wrote latest snapshot to s3://%s/%s", RAW_BUCKET_NAME, LATEST_KEY)


def lambda_handler(event, context):
    logger.info(
        "Starting ingestion loop | poll_interval=%ss | poll_window=%ss",
        POLL_INTERVAL_SECONDS,
        POLL_WINDOW_SECONDS,
    )

    if not TFNSW_API_KEY:
        raise ValueError("Missing TFNSW_API_KEY")

    started_at = time.time()
    iterations = 0
    last_count = 0

    while time.time() - started_at < POLL_WINDOW_SECONDS:
        filtered_records = fetch_filtered_records()
        payload = build_latest_payload(filtered_records)
        write_latest_payload(payload)

        iterations += 1
        last_count = len(filtered_records)

        elapsed = time.time() - started_at
        remaining = POLL_WINDOW_SECONDS - elapsed

        if remaining <= POLL_INTERVAL_SECONDS:
            break

        time.sleep(POLL_INTERVAL_SECONDS)

    return {
        "statusCode": 200,
        "iterations": iterations,
        "records_written_last_snapshot": last_count,
        "routes": sorted(TARGET_ROUTES),
        "s3_key": LATEST_KEY,
    }


def main() -> None:
    result = lambda_handler({}, None)
    logger.info("Local execution result: %s", result)


if __name__ == "__main__":
    main()
