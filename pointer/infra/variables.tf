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

variable "worker_runtime" {
  description = "Runtime used for the Chargebee webhook queue consumer. Exactly one of ECS or Lambda is deployed."
  type        = string
  default     = "ecs"

  validation {
    condition     = contains(["ecs", "lambda"], var.worker_runtime)
    error_message = "worker_runtime must be either \"ecs\" or \"lambda\"."
  }
}

# ECS worker scaling.

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

# Lambda worker packaging and scaling.

variable "worker_lambda_image_tag" {
  description = "ECR tag for the ARM64 Lambda worker image. Terraform resolves it to an immutable digest."
  type        = string
  default     = "lambda-worker-latest"
}

variable "worker_lambda_memory_size" {
  description = "Memory allocated to the Lambda webhook worker in MB."
  type        = number
  default     = 1024

  validation {
    condition     = var.worker_lambda_memory_size >= 128 && var.worker_lambda_memory_size <= 10240
    error_message = "worker_lambda_memory_size must be between 128 and 10240 MB."
  }
}

variable "worker_lambda_timeout_seconds" {
  description = "Lambda webhook worker timeout. The SQS visibility timeout is derived as six times this value."
  type        = number
  default     = 60

  validation {
    condition     = var.worker_lambda_timeout_seconds >= 1 && var.worker_lambda_timeout_seconds <= 150
    error_message = "worker_lambda_timeout_seconds must be between 1 and 150 seconds so the derived queue visibility remains within the worker's 15-minute backoff cap."
  }
}

variable "worker_lambda_batch_size" {
  description = "Maximum SQS records sent to one Lambda webhook worker invocation."
  type        = number
  default     = 10

  validation {
    condition     = var.worker_lambda_batch_size >= 1 && var.worker_lambda_batch_size <= 10
    error_message = "worker_lambda_batch_size must be between 1 and 10."
  }
}

variable "worker_lambda_max_concurrency" {
  description = "Maximum and reserved concurrency for the Lambda worker, bounding database and Redis connections."
  type        = number
  default     = 2

  validation {
    condition     = var.worker_lambda_max_concurrency >= 2 && var.worker_lambda_max_concurrency <= 100
    error_message = "worker_lambda_max_concurrency must be between 2 and 100."
  }
}
