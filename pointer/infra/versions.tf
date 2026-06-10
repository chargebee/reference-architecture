terraform {
  required_version = ">= 1.15.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Partial backend configuration. The S3 bucket must exist before `terraform init`.
  # Initialize with: terraform init -backend-config=backend.hcl
  backend "s3" {}
}
