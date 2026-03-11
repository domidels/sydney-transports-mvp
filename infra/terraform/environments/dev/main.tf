provider "aws" {
  region  = var.aws_region
  profile = "sydney-transport"
}

data "aws_caller_identity" "current" {}

locals {
  prefix = "${var.project_name}-${var.environment}"
}

resource "aws_s3_bucket" "raw" {
  bucket = "${local.prefix}-raw-${data.aws_caller_identity.current.account_id}"
  force_destroy = true
}


resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.prefix}-ingest"
  retention_in_days = 14
}

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
        Effect = "Allow"
        Action = [
          "s3:PutObject"
        ]
        Resource = "${aws_s3_bucket.raw.arn}/*"
      },
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject"
        ]
        Resource = "${aws_s3_bucket.raw.arn}/*"
      }
    ]
  })
}
resource "aws_apigatewayv2_api" "bus_api" {
  name          = "${local.prefix}-bus-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_route" "buses_latest" {
  api_id = aws_apigatewayv2_api.bus_api.id

  route_key = "GET /buses/latest"
  target    = "integrations/${aws_apigatewayv2_integration.read_lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id = aws_apigatewayv2_api.bus_api.id

  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowExecutionFromAPIGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.read_api.function_name
  principal     = "apigateway.amazonaws.com"

  source_arn = "${aws_apigatewayv2_api.bus_api.execution_arn}/*/*"
}

resource "aws_apigatewayv2_integration" "read_lambda" {
  api_id = aws_apigatewayv2_api.bus_api.id

  integration_type = "AWS_PROXY"
  integration_uri  = aws_lambda_function.read_api.invoke_arn

  integration_method = "POST"
}

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
      TFNSW_API_KEY        = var.tfnsw_api_key
      TFNSW_VEHICLEPOS_URL = var.tfnsw_vehiclepos_url
      RAW_BUCKET_NAME      = aws_s3_bucket.raw.bucket
      LOG_LEVEL            = "INFO"
      POLL_INTERVAL_SECONDS = tostring(var.poll_interval_seconds)
      POLL_WINDOW_SECONDS   = tostring(var.poll_window_seconds)
    }
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function" "read_api" {
  function_name = "${local.prefix}-read-api"

  role    = aws_iam_role.lambda_exec.arn
  handler = "handler.lambda_handler"
  runtime = "python3.11"

  filename         = "${path.module}/../../../../dist/read_lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/../../../../dist/read_lambda.zip")

  timeout = 10

  environment {
    variables = {
      RAW_BUCKET_NAME = aws_s3_bucket.raw.bucket
    }
  }
}

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

resource "aws_iam_role_policy" "scheduler_policy" {
  name = "${local.prefix}-scheduler-policy"
  role = aws_iam_role.scheduler_role.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "lambda:InvokeFunction"
      ]
      Resource = aws_lambda_function.ingest.arn
    }]
  })
}

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