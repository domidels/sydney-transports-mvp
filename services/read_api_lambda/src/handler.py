"""
handler.py — AWS Lambda read function for the bus live-map API.

Serves the latest bus snapshot to the frontend via API Gateway HTTP API.

Architecture
────────────
  Browser  →  CloudFront / API Gateway  →  this Lambda  →  S3 (latest.json)

The ingest Lambda writes ``latest/buses_latest.json`` to the S3 bucket
every ~5 seconds.  This function simply reads that object and returns it
as the HTTP response body, keeping the read path stateless and cheap.

The S3 client is initialised at module level so it is reused across warm
Lambda invocations (connection pooling).

Environment variables (injected by Terraform)
─────────────────────────────────────────────
  RAW_BUCKET_NAME – S3 bucket that contains the latest snapshot.
"""

import os

import boto3

# ── Configuration ─────────────────────────────────────────────────────────────

BUCKET = os.environ["RAW_BUCKET_NAME"]

# S3 key written by the ingest Lambda.
KEY = "latest/buses_latest.json"

# Module-level client — reused across warm invocations for efficiency.
s3 = boto3.client("s3")


# ── Lambda entry point ────────────────────────────────────────────────────────

def lambda_handler(event, context):
    """
    Fetch the latest bus snapshot from S3 and return it as an HTTP response.

    Called by API Gateway on every ``GET /buses/latest`` request.
    The response body is the raw JSON written by the ingest Lambda,
    passed through without modification.

    CORS is enabled via ``Access-Control-Allow-Origin: *`` so the frontend
    can call this endpoint from any origin (including local development).

    Args:
        event:   API Gateway HTTP event dict (not inspected — all requests
                 return the same latest snapshot).
        context: Lambda context object (not used).

    Returns:
        API Gateway-compatible response dict with:
            statusCode (int)  – 200 on success.
            headers    (dict) – Content-Type and CORS headers.
            body       (str)  – JSON string of the latest bus snapshot.
    """
    obj = s3.get_object(Bucket=BUCKET, Key=KEY)

    body = obj["Body"].read().decode()

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            # Allow the browser frontend to call this from any origin.
            "Access-Control-Allow-Origin": "*",
        },
        "body": body,
    }
