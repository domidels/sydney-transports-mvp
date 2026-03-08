import os


def getenv(name: str, default=None):
    return os.getenv(name, default)


def require(name: str):
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing environment variable: {name}")
    return value


TFNSW_API_KEY = getenv("TFNSW_API_KEY")

TFNSW_VEHICLEPOS_URL = getenv(
    "TFNSW_VEHICLEPOS_URL",
    "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
)

LOG_LEVEL = getenv("LOG_LEVEL", "INFO")
