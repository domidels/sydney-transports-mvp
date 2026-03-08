output "raw_bucket_name" {
  value = aws_s3_bucket.raw.bucket
}

output "lambda_function_name" {
  value = aws_lambda_function.ingest.function_name
}

output "scheduler_name" {
  value = aws_scheduler_schedule.ingest_every_minute.name
}