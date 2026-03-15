# ─────────────────────────────────────────────────────────────────────────────
# main.tf — Sydney Buses Live, dev environment
#
# Provisions all AWS infrastructure for the project:
#
#   S3 bucket         – stores the raw GTFS snapshot (latest.json) and the
#                       built frontend static files (web_frontend/).
#   IAM roles/policies – least-privilege permissions for Lambda and EventBridge.
#   Lambda (ingest)   – polls the NSW GTFS-RT feed and writes to S3.
#   Lambda (read-api) – reads the latest snapshot from S3 for the frontend.
#   API Gateway       – HTTP API exposing GET /buses/latest to the browser.
#   EventBridge       – triggers the ingest Lambda once per minute.
#   CloudFront        – CDN serving the frontend SPA from S3.
#   ACM certificate   – TLS cert for waverley-bus.live (must be in us-east-1).
#
# Naming convention: all resources share the "${project_name}-${environment}"
# prefix (e.g. "sydney-transport-dev") defined in the `locals` block.
# ─────────────────────────────────────────────────────────────────────────────

provider "aws" {
  region  = var.aws_region
  profile = "sydney-transport"
}

# Used to embed the AWS account ID in globally-unique resource names (S3 bucket).
data "aws_caller_identity" "current" {}

locals {
  prefix = "${var.project_name}-${var.environment}"
}

# ─── S3 ──────────────────────────────────────────────────────────────────────

# Single "raw" bucket used for two purposes:
#   • latest/buses_latest.json  – written by the ingest Lambda every ~5 s.
#   • web_frontend/*            – static frontend files served via CloudFront.
resource "aws_s3_bucket" "raw" {
  bucket        = "${local.prefix}-raw-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # allows `terraform destroy` without manual bucket emptying
}

# ─── CloudWatch ──────────────────────────────────────────────────────────────

# Log group for the ingest Lambda. Retention is capped at 14 days to limit cost.
resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.prefix}-ingest"
  retention_in_days = 14
}

# ─── IAM — Lambda execution role ─────────────────────────────────────────────

# Shared execution role for both Lambda functions (ingest + read-api).
resource "aws_iam_role" "lambda_exec" {
  name = "${local.prefix}-lambda-exec"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Inline policy granting the Lambda role exactly what it needs — no more.
#   • CloudWatch Logs – write execution logs.
#   • S3 PutObject    – ingest Lambda writes the snapshot.
#   • S3 GetObject    – read-api Lambda reads the snapshot.
resource "aws_iam_role_policy" "lambda_policy" {
  name = "${local.prefix}-lambda-policy"
  role = aws_iam_role.lambda_exec.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "${aws_cloudwatch_log_group.lambda.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject"]
        Resource = "${aws_s3_bucket.raw.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject"]
        Resource = "${aws_s3_bucket.raw.arn}/*"
      }
    ]
  })
}

# ─── API Gateway ──────────────────────────────────────────────────────────────

# HTTP API (v2) — simpler and cheaper than REST API for a single-route use case.
resource "aws_apigatewayv2_api" "bus_api" {
  name          = "${local.prefix}-bus-api"
  protocol_type = "HTTP"
}

# Single route: GET /buses/latest → read-api Lambda.
resource "aws_apigatewayv2_route" "buses_latest" {
  api_id    = aws_apigatewayv2_api.bus_api.id
  route_key = "GET /buses/latest"
  target    = "integrations/${aws_apigatewayv2_integration.read_lambda.id}"
}

# Auto-deploy stage — changes to the API are deployed immediately.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.bus_api.id
  name        = "$default"
  auto_deploy = true
}

# Allow API Gateway to invoke the read-api Lambda.
resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.read_api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.bus_api.execution_arn}/*/*"
}

# AWS_PROXY integration — API Gateway passes the raw event to Lambda and
# returns the Lambda response directly as the HTTP response.
resource "aws_apigatewayv2_integration" "read_lambda" {
  api_id             = aws_apigatewayv2_api.bus_api.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.read_api.invoke_arn
  integration_method = "POST"
}

# ─── Lambda — ingest ─────────────────────────────────────────────────────────

# Polls the NSW GTFS-RT feed and writes the filtered snapshot to S3.
# Timeout is 30 s per the poll window (55 s) — Lambda hard limit is 15 min,
# but the EventBridge schedule fires every minute so 30 s is a safe ceiling.
resource "aws_lambda_function" "ingest" {
  function_name = "${local.prefix}-ingest"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.11"
  timeout       = 30

  filename         = "${path.module}/../../../../dist/lambda_ingest.zip"
  source_code_hash = filebase64sha256("${path.module}/../../../../dist/lambda_ingest.zip")

  environment {
    variables = {
      TFNSW_API_KEY         = var.tfnsw_api_key
      TFNSW_VEHICLEPOS_URL  = var.tfnsw_vehiclepos_url
      RAW_BUCKET_NAME       = aws_s3_bucket.raw.bucket
      LOG_LEVEL             = "INFO"
      POLL_INTERVAL_SECONDS = tostring(var.poll_interval_seconds)
      POLL_WINDOW_SECONDS   = tostring(var.poll_window_seconds)
    }
  }

  # Ensure the log group exists before Lambda is created so the first
  # invocation doesn't fail trying to write to a missing group.
  depends_on = [aws_cloudwatch_log_group.lambda]
}

# ─── Lambda — read API ────────────────────────────────────────────────────────

# Lightweight function that reads latest.json from S3 and returns it.
# No CloudWatch log group is defined explicitly — Lambda auto-creates one.
resource "aws_lambda_function" "read_api" {
  function_name = "${local.prefix}-read-api"
  role          = aws_iam_role.lambda_exec.arn
  handler       = "handler.lambda_handler"
  runtime       = "python3.11"
  timeout       = 10 # S3 GetObject should never take more than a few ms

  filename         = "${path.module}/../../../../dist/read_lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../../../dist/read_lambda.zip")

  environment {
    variables = {
      RAW_BUCKET_NAME = aws_s3_bucket.raw.bucket
    }
  }
}

# ─── IAM — EventBridge Scheduler role ────────────────────────────────────────

# Separate role for EventBridge Scheduler (cannot reuse the Lambda exec role).
resource "aws_iam_role" "scheduler_role" {
  name = "${local.prefix}-scheduler-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "scheduler.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

# Allow the scheduler to invoke the ingest Lambda only.
resource "aws_iam_role_policy" "scheduler_policy" {
  name = "${local.prefix}-scheduler-policy"
  role = aws_iam_role.scheduler_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["lambda:InvokeFunction"]
      Resource = aws_lambda_function.ingest.arn
    }]
  })
}

# ─── EventBridge Scheduler ────────────────────────────────────────────────────

# Triggers the ingest Lambda every minute (configurable via var.schedule_expression).
# flexible_time_window = OFF means exact scheduling with no jitter.
# Retry policy: up to 2 retries within 5 minutes if the Lambda fails.
resource "aws_scheduler_schedule" "ingest_every_minute" {
  name       = "${local.prefix}-every-minute"
  group_name = "default"

  flexible_time_window {
    mode = "OFF"
  }

  schedule_expression          = var.schedule_expression
  schedule_expression_timezone = "Australia/Sydney"

  target {
    arn      = aws_lambda_function.ingest.arn
    role_arn = aws_iam_role.scheduler_role.arn
    input    = jsonencode({ source = "eventbridge-scheduler" })

    retry_policy {
      maximum_event_age_in_seconds = 300
      maximum_retry_attempts       = 2
    }
  }
}

# ─── ACM certificate ──────────────────────────────────────────────────────────

# CloudFront requires certificates to be in us-east-1 regardless of the
# distribution's origin region — hence the provider alias.
resource "aws_acm_certificate" "frontend_cert" {
  provider                  = aws.us_east_1
  domain_name               = var.frontend_domain
  subject_alternative_names = [var.frontend_www_domain]
  validation_method         = "DNS"

  lifecycle {
    # Create the new cert before destroying the old one to avoid downtime.
    create_before_destroy = true
  }
}

resource "aws_acm_certificate_validation" "frontend_cert" {
  provider        = aws.us_east_1
  certificate_arn = aws_acm_certificate.frontend_cert.arn
}

# ─── CloudFront ───────────────────────────────────────────────────────────────

# Origin Access Control — allows CloudFront to read from the S3 bucket
# without making the bucket publicly accessible.
resource "aws_cloudfront_origin_access_control" "frontend" {
  name                              = "${local.prefix}-frontend-oac"
  description                       = "OAC for frontend in shared S3 bucket"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront distribution serving the frontend SPA.
# Origin path is /web_frontend so only that S3 prefix is exposed.
# PriceClass_100 = US, Canada, Europe only — cheapest tier.
resource "aws_cloudfront_distribution" "frontend" {
  enabled             = true
  default_root_object = "index.html"
  aliases             = [var.frontend_domain, var.frontend_www_domain]

  origin {
    domain_name              = aws_s3_bucket.raw.bucket_regional_domain_name
    origin_id                = "raw-bucket-frontend"
    origin_path              = "/web_frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend.id
  }

  default_cache_behavior {
    target_origin_id       = "raw-bucket-frontend"
    viewer_protocol_policy = "redirect-to-https"
    compress               = true

    allowed_methods = ["GET", "HEAD", "OPTIONS"]
    cached_methods  = ["GET", "HEAD"]

    forwarded_values {
      query_string = true
      cookies {
        forward = "none"
      }
    }
  }

  # SPA fallback: 403/404 from S3 (missing key) → serve index.html with 200
  # so client-side routing handles the path.
  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.frontend_cert.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }

  price_class = "PriceClass_100"

  depends_on = [aws_acm_certificate_validation.frontend_cert]
}

# ─── S3 bucket policy ─────────────────────────────────────────────────────────

# Allow CloudFront (and only CloudFront) to read the frontend prefix.
# The condition on AWS:SourceArn restricts access to this specific distribution.
data "aws_iam_policy_document" "raw_bucket_policy" {
  statement {
    sid    = "AllowCloudFrontReadFrontend"
    effect = "Allow"

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    actions = ["s3:GetObject"]

    resources = [
      "${aws_s3_bucket.raw.arn}/web_frontend/*"
    ]

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.frontend.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "raw_bucket_policy" {
  bucket = aws_s3_bucket.raw.id
  policy = data.aws_iam_policy_document.raw_bucket_policy.json
}

# ─── Outputs ──────────────────────────────────────────────────────────────────

output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.frontend.domain_name
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.frontend.id
}

output "frontend_cert_validation_records" {
  value = aws_acm_certificate.frontend_cert.domain_validation_options
}
