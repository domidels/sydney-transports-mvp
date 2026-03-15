# ─────────────────────────────────────────────────────────────────────────────
# outputs.tf — Terraform outputs for the dev environment.
#
# These values are printed after `terraform apply` and can be retrieved later
# with `terraform output`.  Use them to configure DNS records, the frontend
# API_URL constant, or CI/CD pipelines.
# ─────────────────────────────────────────────────────────────────────────────

# S3 bucket name — needed when uploading the built frontend files.
output "raw_bucket_name" {
  value = aws_s3_bucket.raw.bucket
}

# Ingest Lambda function name — useful for manual invocations and monitoring.
output "lambda_function_name" {
  value = aws_lambda_function.ingest.function_name
}

# EventBridge schedule name — for monitoring and manual triggering.
output "scheduler_name" {
  value = aws_scheduler_schedule.ingest_every_minute.name
}

# API Gateway endpoint — set this as API_URL in services/web_frontend/app.js.
output "bus_api_url" {
  value = aws_apigatewayv2_api.bus_api.api_endpoint
}
