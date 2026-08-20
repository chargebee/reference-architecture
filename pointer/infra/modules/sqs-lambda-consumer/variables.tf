variable "function_name" {
  description = "Name of the Lambda function."
  type        = string
}

variable "description" {
  description = "Description of the Lambda function."
  type        = string
  default     = null
  nullable    = true
}

variable "image_uri" {
  description = "ECR image URI, preferably pinned to a digest."
  type        = string
}

variable "queue_arn" {
  description = "ARN of the caller-managed SQS source queue."
  type        = string
}

variable "queue_visibility_timeout_seconds" {
  description = "Actual source queue visibility timeout, used to validate the Lambda timeout contract."
  type        = number
}

variable "environment_variables" {
  description = "Non-secret environment variables passed to the function."
  type        = map(string)
  default     = {}
}

variable "additional_iam_policy_json" {
  description = "Optional job-specific IAM policy JSON attached to the execution role."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.additional_iam_policy_json == null || can(jsondecode(var.additional_iam_policy_json))
    error_message = "additional_iam_policy_json must be valid JSON when provided."
  }
}

variable "subnet_ids" {
  description = "Private subnet IDs for VPC access. Leave this and security_group_ids empty to run outside a VPC."
  type        = list(string)
  default     = []
}

variable "security_group_ids" {
  description = "Security group IDs for VPC access. Must be set together with subnet_ids."
  type        = list(string)
  default     = []

  validation {
    condition = (
      (length(var.subnet_ids) == 0 && length(var.security_group_ids) == 0) ||
      (length(var.subnet_ids) > 0 && length(var.security_group_ids) > 0)
    )
    error_message = "subnet_ids and security_group_ids must either both be empty or both be non-empty."
  }
}

variable "architecture" {
  description = "Lambda CPU architecture."
  type        = string
  default     = "arm64"

  validation {
    condition     = contains(["arm64", "x86_64"], var.architecture)
    error_message = "architecture must be arm64 or x86_64."
  }
}

variable "memory_size" {
  description = "Function memory in MB."
  type        = number
  default     = 1024

  validation {
    condition     = var.memory_size >= 128 && var.memory_size <= 10240
    error_message = "memory_size must be between 128 and 10240 MB."
  }
}

variable "timeout_seconds" {
  description = "Function timeout in seconds."
  type        = number
  default     = 60

  validation {
    condition     = var.timeout_seconds >= 1 && var.timeout_seconds <= 900
    error_message = "timeout_seconds must be between 1 and 900."
  }
}

variable "batch_size" {
  description = "Maximum SQS records sent to one invocation."
  type        = number
  default     = 10

  validation {
    condition     = var.batch_size >= 1 && var.batch_size <= 10000
    error_message = "batch_size must be between 1 and 10000."
  }
}

variable "maximum_batching_window_seconds" {
  description = "Maximum time Lambda buffers records before invocation."
  type        = number
  default     = 0

  validation {
    condition = (
      var.maximum_batching_window_seconds >= 0 &&
      var.maximum_batching_window_seconds <= 300 &&
      (var.batch_size <= 10 || var.maximum_batching_window_seconds >= 1)
    )
    error_message = "maximum_batching_window_seconds must be 0-300 and at least 1 when batch_size exceeds 10."
  }
}

variable "maximum_concurrency" {
  description = "Maximum concurrent invocations for this SQS event source. Null uses the AWS account/function limit."
  type        = number
  default     = 2
  nullable    = true

  validation {
    condition = (
      var.maximum_concurrency == null ||
      (var.maximum_concurrency >= 2 && var.maximum_concurrency <= 1000)
    )
    error_message = "maximum_concurrency must be null or between 2 and 1000."
  }
}

variable "reserved_concurrency" {
  description = "Reserved function concurrency. Use -1 for unreserved or null to omit the setting."
  type        = number
  default     = 2
  nullable    = true

  validation {
    condition = (
      var.reserved_concurrency == null ||
      var.reserved_concurrency == -1 ||
      var.reserved_concurrency >= 1
    )
    error_message = "reserved_concurrency must be null, -1, or at least 1."
  }
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days."
  type        = number
  default     = 14
}

variable "tags" {
  description = "Tags applied to supported resources."
  type        = map(string)
  default     = {}
}
