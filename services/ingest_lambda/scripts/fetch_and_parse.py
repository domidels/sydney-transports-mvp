from pathlib import Path

import requests
from dotenv import load_dotenv
from src.logging_config import get_logger
from src.parse_gtfsrt import parse_vehicle_positions
from src.settings import LOG_LEVEL, TFNSW_API_KEY, TFNSW_VEHICLEPOS_URL

ROOT = Path(__file__).resolve().parents[1]
load_dotenv(ROOT / ".env")
logger = get_logger(__name__, LOG_LEVEL)


def main():
    if not TFNSW_API_KEY:
        logger.error("Missing TFNSW_API_KEY")
        raise ValueError("Missing TFNSW_API_KEY")

    logger.info("Fetching GTFS-RT vehicle positions from TFNSW API")

    response = requests.get(
        TFNSW_VEHICLEPOS_URL,
        headers={"Authorization": f"apikey {TFNSW_API_KEY}"},
        timeout=30,
    )

    logger.info("Received response with status_code=%s", response.status_code)

    response.raise_for_status()

    records = parse_vehicle_positions(response.content)

    logger.info("Parsed %s vehicle position records", len(records))

    for record in records[:5]:
        logger.info("Sample record: %s", record)


if __name__ == "__main__":
    main()
