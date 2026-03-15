# ─────────────────────────────────────────────────────────────────────────────
# variables.tf — Input variables for the dev environment.
#
# Sensitive values (tfnsw_api_key) must be supplied at plan/apply time via
# a tfvars file or the TF_VAR_* environment variable mechanism.
# They are never stored in state in plaintext.
# ─────────────────────────────────────────────────────────────────────────────

# ─── AWS ─────────────────────────────────────────────────────────────────────

variable "aws_region" {
  type        = string
  description = "AWS region for all resources except the ACM certificate (which must be us-east-1 for CloudFront)."
  default     = "ap-southeast-2" # Sydney
}

# ─── Naming ───────────────────────────────────────────────────────────────────

variable "project_name" {
  type        = string
  description = "Short project identifier used as a prefix for all resource names."
  default     = "sydney-transport"
}

variable "environment" {
  type        = string
  description = "Deployment environment (dev, staging, prod). Included in resource names."
  default     = "dev"
}

# ─── NSW Transport API ────────────────────────────────────────────────────────

variable "tfnsw_api_key" {
  type        = string
  description = "API key for the NSW Transport Open Data GTFS-RT feed. Marked sensitive so Terraform redacts it from plan output."
  sensitive   = true
}

variable "tfnsw_vehiclepos_url" {
  type        = string
  description = "GTFS-RT vehicle positions endpoint. Override only if the NSW API URL changes."
  default     = "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses"
}

# ─── Ingest polling ───────────────────────────────────────────────────────────

variable "schedule_expression" {
  type        = string
  description = "EventBridge Scheduler expression controlling how often the ingest Lambda is triggered (e.g. 'rate(1 minute)')."
  default     = "rate(1 minute)"
}

variable "poll_interval_seconds" {
  type        = number
  description = "Seconds between consecutive NSW API calls within a single Lambda invocation. The NSW feed updates every ~10 s, so 5 s gives two fetches per update cycle."
  default     = 5
}

variable "poll_window_seconds" {
  type        = number
  description = "Total seconds the ingest Lambda continues polling before returning. Set to 55 s so it covers almost a full minute without overlapping the next trigger."
  default     = 55
}

# ─── Frontend / CloudFront ────────────────────────────────────────────────────

variable "frontend_domain" {
  type        = string
  description = "Primary custom domain for the CloudFront distribution (e.g. waverley-bus.live)."
  default     = "waverley-bus.live"
}

variable "frontend_www_domain" {
  type        = string
  description = "www subdomain added as a Subject Alternative Name on the ACM certificate."
  default     = "www.waverley-bus.live"
}

# ─── Provider alias ───────────────────────────────────────────────────────────

# ACM certificates for CloudFront must be created in us-east-1.
# This alias provider is referenced by aws_acm_certificate resources in main.tf.
provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = "sydney-transport"
}
