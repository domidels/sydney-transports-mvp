import json
import os
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

logger = get_logger(__name__, LOG_LEVEL)

TARGET_ROUTES = {"390X", "379"}
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


def lambda_handler(event, context):
    logger.info("Starting ingestion")

    if not TFNSW_API_KEY:
        raise ValueError("Missing TFNSW_API_KEY")

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

    payload = build_latest_payload(filtered_records)

    if not RAW_BUCKET_NAME:
        logger.info("RAW_BUCKET_NAME not set, skipping S3 write for local test")
        logger.info("Latest payload preview: %s", payload)
        return {
            "statusCode": 200,
            "records_written": len(filtered_records),
            "routes": sorted(TARGET_ROUTES),
            "s3_write": "skipped",
            "s3_key": LATEST_KEY,
        }

    s3 = boto3.client("s3")
    s3.put_object(
        Bucket=RAW_BUCKET_NAME,
        Key=LATEST_KEY,
        Body=json.dumps(payload).encode("utf-8"),
        ContentType="application/json",
        CacheControl="no-store",
    )

    logger.info(
        "Wrote %s records to s3://%s/%s",
        len(filtered_records),
        RAW_BUCKET_NAME,
        LATEST_KEY,
    )

    return {
        "statusCode": 200,
        "records_written": len(filtered_records),
        "routes": sorted(TARGET_ROUTES),
        "s3_key": LATEST_KEY,
    }
