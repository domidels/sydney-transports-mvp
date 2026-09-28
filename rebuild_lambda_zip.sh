#!/bin/bash

rm -rf dist/lambda_ingest
mkdir -p dist/lambda_ingest

# The ingest Lambda runs on arm64 (see main.tf). Pin the install to
# aarch64 wheels explicitly so the zip is correct regardless of the
# architecture of the machine running this script — a package built with
# a plain `pip install` on an x86_64 machine would bundle incompatible
# compiled dependencies (protobuf's C extension) and crash at runtime.
pip install \
  --platform manylinux2014_aarch64 \
  --implementation cp \
  --python-version 311 \
  --only-binary=:all: \
  -r services/ingest_lambda/requirements.txt \
  -t dist/lambda_ingest
cp -r services/ingest_lambda/src/* dist/lambda_ingest/

cd dist/lambda_ingest && zip -r ../lambda_ingest.zip .