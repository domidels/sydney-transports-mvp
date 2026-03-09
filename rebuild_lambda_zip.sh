#!/bin/bash

rm -rf dist/lambda_ingest
mkdir -p dist/lambda_ingest

pip install -r services/ingest_lambda/requirements.txt -t dist/lambda_ingest
cp -r services/ingest_lambda/src/* dist/lambda_ingest/

cd dist/lambda_ingest && zip -r ../lambda_ingest.zip .