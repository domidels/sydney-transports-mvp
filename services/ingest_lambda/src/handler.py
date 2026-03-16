"""
handler.py — AWS Lambda ingest function for Sydney bus live positions.

Architecture overview
─────────────────────
EventBridge Scheduler triggers this Lambda once per minute.  Rather than
doing a single fetch and exiting, the handler runs an internal polling
loop for ~55 seconds, calling the NSW Transport GTFS-RT API every
POLL_INTERVAL_SECONDS and writing the filtered result to S3.  This gives
the frontend near-real-time updates (the NSW feed itself refreshes every
~10 s) while staying within EventBridge's 1-minute minimum schedule.

Data flow
─────────
  NSW GTFS-RT feed  →  fetch_filtered_records()
                    →  build_latest_payload()
                    →  write_latest_payload()  →  S3 (latest/buses_latest.json)
                                                →  API Gateway / read Lambda
                                                →  Browser

Environment variables (injected by Terraform)
─────────────────────────────────────────────
  TFNSW_API_KEY          – NSW Transport API key (required).
  TFNSW_VEHICLEPOS_URL   – GTFS-RT vehicle positions endpoint.
  RAW_BUCKET_NAME        – S3 bucket where the snapshot is written.
  LOG_LEVEL              – Python logging level (default: INFO).
  POLL_INTERVAL_SECONDS  – Seconds between feed fetches (default: 5).
  POLL_WINDOW_SECONDS    – Total seconds to keep polling per invocation (default: 55).
"""

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

# ── Local dev: load .env if present (not used in Lambda) ─────────────────────
ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = ROOT / ".env"

if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

# ── Configuration ─────────────────────────────────────────────────────────────

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
TFNSW_API_KEY = os.getenv("TFNSW_API_KEY")
TFNSW_VEHICLEPOS_URL = os.getenv(
    "TFNSW_VEHICLEPOS_URL",
    "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
)
RAW_BUCKET_NAME = os.getenv("RAW_BUCKET_NAME")

# Seconds between each call to the NSW feed within a single Lambda invocation.
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "5"))

# How long (seconds) to keep polling before letting the Lambda return.
# Set to 55 s so the next EventBridge trigger (at 60 s) overlaps cleanly.
POLL_WINDOW_SECONDS = int(os.getenv("POLL_WINDOW_SECONDS", "55"))

logger = get_logger(__name__, LOG_LEVEL)

# ── Domain constants ──────────────────────────────────────────────────────────

# Only these route short names are retained; all other buses are filtered out.
TARGET_ROUTES = {"390X", "379", "370", "313", "373", "350", "333", "380", "726e", "360", "362"}

# S3 key for the rolling "latest" snapshot consumed by the read Lambda.
LATEST_KEY = "latest/buses_latest.json"


# ── Helpers ───────────────────────────────────────────────────────────────────

def extract_route_short_name(route_id: str | None) -> str | None:
    """
    Extract the human-readable route short name from a GTFS route_id string.

    NSW route IDs follow the pattern ``<operator>_<short_name>_<variant>``,
    e.g. ``NSWTrains_390X_1``.  The short name starts at character index 5
    (after the first 5-character operator prefix).

    Args:
        route_id: Raw GTFS route_id string, or None.

    Returns:
        Route short name (e.g. "390X"), or None if route_id is absent.
    """
    if not route_id:
        return None
    return route_id[5:] if len(route_id) > 5 else route_id


def build_latest_payload(filtered_records: list[dict]) -> dict:
    """
    Wrap filtered vehicle records in a timestamped JSON payload.

    Args:
        filtered_records: List of vehicle dicts from parse_vehicle_positions(),
                          already filtered to TARGET_ROUTES.

    Returns:
        Dict with keys:
            generated_at_utc (str)  – ISO-8601 UTC timestamp of this snapshot.
            routes           (list) – Sorted list of monitored route short names.
            vehicle_count    (int)  – Number of vehicles in this snapshot.
            vehicles         (list) – The filtered vehicle dicts.
    """
    now = datetime.now(UTC)
    return {
        "generated_at_utc": now.isoformat(),
        "routes": sorted(TARGET_ROUTES),
        "vehicle_count": len(filtered_records),
        "vehicles": filtered_records,
    }


def fetch_filtered_records() -> list[dict]:
    """
    Fetch the NSW GTFS-RT vehicle positions feed and return only buses
    whose route short name is in TARGET_ROUTES.

    Makes a single HTTP GET to TFNSW_VEHICLEPOS_URL with the API key header,
    parses the protobuf response, and filters by route.

    Returns:
        List of vehicle dicts for TARGET_ROUTES buses only.

    Raises:
        requests.HTTPError: If the API returns a non-2xx status.
        requests.Timeout:   If the request exceeds 30 seconds.
    """
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

    # Log a sample of route IDs seen in the full feed (useful for debugging
    # route ID format changes in the NSW GTFS data).
    if records:
        sample_route_ids = sorted(
            {record.get("route_id") for record in records if record.get("route_id")}
        )[:30]
        logger.info("Sample route_ids seen: %s", sample_route_ids)

    return filtered_records


def write_latest_payload(payload: dict) -> None:
    """
    Serialise the payload to JSON and write it to S3 at LATEST_KEY.

    The object is written with ``Cache-Control: no-store`` so that the
    API Gateway / CloudFront layer never serves a stale copy.

    If RAW_BUCKET_NAME is not set (local development), the payload is
    logged instead of written to S3.

    Args:
        payload: Dict produced by build_latest_payload().
    """
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


# ── Lambda entry point ────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """
    Lambda entry point — polls the NSW feed and writes to S3 in a loop.

    Called once per minute by EventBridge Scheduler.  Runs an internal
    loop for POLL_WINDOW_SECONDS, fetching the feed every POLL_INTERVAL_SECONDS
    and writing the filtered snapshot to S3 each time.

    The loop exits early when fewer than POLL_INTERVAL_SECONDS remain in
    the window to avoid overlapping with the next scheduled invocation.

    Args:
        event:   EventBridge event payload (not used; source is logged).
        context: Lambda context object (not used).

    Returns:
        Dict with:
            statusCode                   – 200 on success.
            iterations                   – Number of feed fetches performed.
            records_written_last_snapshot – Vehicle count in the final write.
            routes                       – Sorted list of monitored routes.
            s3_key                       – S3 key of the written object.
    """
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

        # Stop if there isn't enough time for another full poll cycle.
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


# ── Local development entry point ─────────────────────────────────────────────

def main() -> None:
    """Run lambda_handler locally for testing without deploying to AWS."""
    result = lambda_handler({}, None)
    logger.info("Local execution result: %s", result)


if __name__ == "__main__":
    main()
