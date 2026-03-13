variable "aws_region" {
  type        = string
  description = "AWS region"
  default     = "ap-southeast-2"
}

variable "project_name" {
  type        = string
  description = "Project name"
  default     = "sydney-transport"
}

variable "environment" {
  type        = string
  description = "Environment name"
  default     = "dev"
}

variable "tfnsw_api_key" {
  type        = string
  description = "TFNSW API key"
  sensitive   = true
}

variable "tfnsw_vehiclepos_url" {
  type        = string
  description = "TFNSW Vehicle Positions endpoint"
  default     = "https://api.transport.nsw.gov.au/v1/gtfs/vehiclepos/buses"
}

variable "schedule_expression" {
  type        = string
  description = "EventBridge Scheduler expression"
  default     = "rate(1 minute)"
}

variable "poll_interval_seconds" {
  type        = number
  description = "Polling interval inside Lambda"
  default     = 5
}

variable "poll_window_seconds" {
  type        = number
  description = "Total polling window inside Lambda"
  default     = 55
}

variable "frontend_domain" {
  type    = string
  default = "waverley-bus.live"
}

variable "frontend_www_domain" {
  type    = string
  default = "www.waverley-bus.live"
}

provider "aws" {
  alias   = "us_east_1"
  region  = "us-east-1"
  profile = "sydney-transport"
}