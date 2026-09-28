resource "aws_s3_bucket" "usage" {
  count = local.usage_lake_enabled ? 1 : 0

  bucket_prefix = "${local.name_prefix}-usage-"

  tags = {
    Name = "${local.name_prefix}-usage"
  }
}

resource "aws_s3_bucket_public_access_block" "usage" {
  count = local.usage_lake_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.usage[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "usage" {
  count = local.usage_lake_enabled ? 1 : 0

  bucket = aws_s3_bucket.usage[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

data "aws_iam_policy_document" "usage_lake_read" {
  count = local.usage_lake_enabled ? 1 : 0

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.usage[0].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.usage_lake_prefix}/*"]
    }
  }

  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.usage[0].arn}/${var.usage_lake_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "usage_lake_read" {
  count = local.usage_lake_enabled ? 1 : 0

  name   = "${local.name_prefix}-usage-lake-read"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.usage_lake_read[0].json
}

data "aws_iam_policy_document" "usage_lake_write" {
  count = local.usage_lake_enabled && local.ecs_worker_enabled ? 1 : 0

  statement {
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.usage[0].arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${var.usage_lake_prefix}/*"]
    }
  }

  statement {
    actions = [
      "s3:GetObject",
      "s3:PutObject",
    ]
    resources = ["${aws_s3_bucket.usage[0].arn}/${var.usage_lake_prefix}/*"]
  }
}

resource "aws_iam_role_policy" "usage_lake_write" {
  count = local.usage_lake_enabled && local.ecs_worker_enabled ? 1 : 0

  name   = "${local.name_prefix}-usage-lake-write"
  role   = aws_iam_role.worker_task[0].id
  policy = data.aws_iam_policy_document.usage_lake_write[0].json
}
