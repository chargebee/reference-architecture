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
