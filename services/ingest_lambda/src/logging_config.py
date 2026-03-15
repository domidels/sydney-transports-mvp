"""
logging_config.py — Shared logger factory for Lambda functions.

Lambda's execution environment may reuse the same Python process across
invocations (warm start).  This module guards against adding duplicate
handlers by checking whether the logger already has handlers before
attaching a new StreamHandler, which prevents log lines from being
duplicated in CloudWatch.

All output goes to stdout so that the Lambda runtime forwards it to the
CloudWatch log group configured in Terraform.
"""

import logging
import sys


def get_logger(name: str, level: str = "INFO") -> logging.Logger:
    """
    Return a configured logger, creating it only if it doesn't already exist.

    The logger writes to stdout with the format:
        YYYY-MM-DD HH:MM:SS | LEVEL | name | message

    On warm Lambda invocations the existing logger (with its handlers) is
    returned as-is to avoid duplicate log entries in CloudWatch.

    Args:
        name:  Logger name — typically ``__name__`` of the calling module.
        level: Logging level string (e.g. "INFO", "DEBUG"). Case-insensitive.

    Returns:
        A fully configured logging.Logger instance.
    """
    logger = logging.getLogger(name)

    # Guard: if handlers are already attached this is a warm invocation — reuse.
    if logger.handlers:
        return logger

    logger.setLevel(level.upper())

    handler = logging.StreamHandler(sys.stdout)
    formatter = logging.Formatter(
        fmt="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )
    handler.setFormatter(formatter)

    logger.addHandler(handler)

    # Prevent log records from bubbling up to the root logger, which would
    # produce a second copy of every line via Lambda's default handler.
    logger.propagate = False

    return logger
