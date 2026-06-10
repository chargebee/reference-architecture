resource "aws_ecr_repository" "app" {
  name = "${local.name_prefix}-app"

  # POC uses :latest. Switch to IMMUTABLE + tagged deploys for prod.
  image_tag_mutability = "MUTABLE"
  force_delete         = true

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}
