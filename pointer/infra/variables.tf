variable "aws_profile" {
  description = "Named AWS profile (from ~/.aws/credentials or ~/.aws/config) to authenticate with."
  type        = string
}

variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "better_auth_trusted_origins" {
  description = "Extra origins (comma-separated) to add to Better Auth's trustedOrigins list, in addition to BETTER_AUTH_URL. Use for ALB DNS, preview domains, etc."
  type        = string
  default     = ""
}

variable "dlq_alert_email" {
  description = "Email address subscribed to the webhook DLQ CloudWatch alarm (via SNS). Leave empty to skip the subscription and wire an alert channel manually."
  type        = string
  default     = ""
}

# --- Chargebee webhook worker -----------------------------------------------
# The worker is a standalone SQS consumer, deployed as its own ECS service so it
# scales independently of the web/app service (more workers = drain the webhook
# queue faster, with no effect on request-serving capacity).

variable "worker_desired_count" {
  description = "Initial number of Chargebee webhook worker tasks. After creation, desired count is managed by autoscaling (Terraform ignores drift)."
  type        = number
  default     = 1
}

variable "worker_min_count" {
  description = "Minimum worker tasks kept running by autoscaling (floor for queue latency)."
  type        = number
  default     = 1
}

variable "worker_max_count" {
  description = "Maximum worker tasks autoscaling may run during a backlog burst."
  type        = number
  default     = 10
}

variable "worker_scale_out_backlog" {
  description = "Scale OUT (add a worker) when the queue has at least this many visible messages."
  type        = number
  default     = 100
}

variable "worker_scale_in_backlog" {
  description = "Scale IN (remove a worker) when visible messages stay at or below this level."
  type        = number
  default     = 10
}
