import os

import boto3

BUCKET = os.environ["RAW_BUCKET_NAME"]
KEY = "latest/buses_latest.json"

s3 = boto3.client("s3")


def lambda_handler(event, context):
    obj = s3.get_object(Bucket=BUCKET, Key=KEY)

    body = obj["Body"].read().decode()

    return {
        "statusCode": 200,
        "headers": {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
        },
        "body": body,
    }
