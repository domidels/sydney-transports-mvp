#!/bin/bash

set -e

rm -rf dist/read_lambda
mkdir -p dist/read_lambda

cp -r services/read_api_lambda/src/* dist/read_lambda/

cd dist/read_lambda
zip -r ../read_lambda.zip .