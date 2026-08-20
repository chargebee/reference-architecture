# Chargebee webhook Lambda worker. The reusable module deliberately accepts an
# existing queue so switching runtimes never replaces or drains the queue.

data "aws_ecr_image" "lambda_worker" {
  count = local.lambda_worker_enabled ? 1 : 0

  repository_name = aws_ecr_repository.app.name
  image_tag       = var.worker_lambda_image_tag
}

resource "aws_security_group" "lambda_worker" {
  count = local.lambda_worker_enabled ? 1 : 0

  name        = "${local.name_prefix}-lambda-worker-sg"
  description = "Pointer Lambda webhook worker"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-lambda-worker-sg"
  }
}

resource "aws_vpc_security_group_egress_rule" "lambda_worker" {
  count = local.lambda_worker_enabled ? 1 : 0

  security_group_id = aws_security_group.lambda_worker[0].id
  description       = "RDS, Redis, AWS APIs, and Chargebee through NAT"
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}

data "aws_iam_policy_document" "lambda_worker_additional" {
  count = local.lambda_worker_enabled ? 1 : 0

  statement {
    sid     = "ReadWorkerSecrets"
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db.arn,
      aws_secretsmanager_secret.app.arn,
    ]
  }

  # Poison messages are routed immediately rather than consuming the normal
  # retry budget. Exhausted retries still use the source queue redrive policy.
  statement {
    sid       = "SendPoisonToDeadLetterQueue"
    actions   = ["sqs:SendMessage"]
    resources = [aws_sqs_queue.dlq.arn]
  }
}

module "lambda_worker" {
  count  = local.lambda_worker_enabled ? 1 : 0
  source = "./modules/sqs-lambda-consumer"

  function_name = "${local.name_prefix}-worker"
  description   = "Processes Chargebee webhooks and entitlement jobs from SQS"
  image_uri     = "${aws_ecr_repository.app.repository_url}@${data.aws_ecr_image.lambda_worker[0].image_digest}"

  queue_arn                        = aws_sqs_queue.main.arn
  queue_visibility_timeout_seconds = local.worker_queue_visibility_timeout_seconds
  environment_variables            = local.lambda_worker_env
  additional_iam_policy_json       = data.aws_iam_policy_document.lambda_worker_additional[0].json

  subnet_ids         = aws_subnet.lambda_private[*].id
  security_group_ids = [aws_security_group.lambda_worker[0].id]

  architecture         = "arm64"
  memory_size          = var.worker_lambda_memory_size
  timeout_seconds      = var.worker_lambda_timeout_seconds
  batch_size           = var.worker_lambda_batch_size
  maximum_concurrency  = var.worker_lambda_max_concurrency
  reserved_concurrency = var.worker_lambda_max_concurrency

  tags = {
    Name = "${local.name_prefix}-worker"
  }
}
