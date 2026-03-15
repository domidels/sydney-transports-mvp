"""
settings.py — Environment variable helpers for the ingest Lambda.

All runtime configuration is injected via environment variables by
Terraform (see infra/terraform/environments/dev/main.tf).  This module
provides thin wrappers around os.getenv so callers never have to import
os directly, and exposes the module-level constants used across the
ingest package.
"""

import os


def getenv(name: str, default=None):
    """
    Return the value of an environment variable, or a default if unset.

    Args:
        name:    Name of the environment variable.
        default: Value to return when the variable is absent (default: None).

    Returns:
        The string value of the variable, or default.
    """
    return os.getenv(name, default)


def require(name: str) -> str:
    """
    Return the value of a required environment variable.

    Raises:
        ValueError: If the variable is absent or empty.

    Args:
        name: Name of the environment variable.

    Returns:
        The non-empty string value of the variable.
    """
    value = os.getenv(name)
    if not value:
        raise ValueError(f"Missing environment variable: {name}")
    return value


# ── Module-level constants ────────────────────────────────────────────────────

# NSW Transport API key — required at runtime, injected by Terraform.
TFNSW_API_KEY = getenv("TFNSW_API_KEY")

# GTFS-RT vehicle positions endpoint for all NSW buses.
TFNSW_VEHICLEPOS_URL = getenv(
    "TFNSW_VEHICLEPOS_URL",
    "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses",
)

# Python logging level passed to get_logger().
LOG_LEVEL = getenv("LOG_LEVEL", "INFO")
