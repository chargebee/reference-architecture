locals {
  vpc_enabled = length(var.subnet_ids) > 0
}

data "aws_iam_policy_document" "assume_role" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "this" {
  name               = "${var.function_name}-role"
  assume_role_policy = data.aws_iam_policy_document.assume_role.json
  tags               = var.tags
}

data "aws_iam_policy_document" "runtime" {
  statement {
    sid = "ConsumeSourceQueue"
    actions = [
      "sqs:ReceiveMessage",
      "sqs:DeleteMessage",
      "sqs:GetQueueAttributes",
      "sqs:GetQueueUrl",
      "sqs:ChangeMessageVisibility",
    ]
    resources = [var.queue_arn]
  }

  statement {
    sid = "WriteFunctionLogs"
    actions = [
      "logs:CreateLogStream",
      "logs:PutLogEvents",
    ]
    resources = ["${aws_cloudwatch_log_group.this.arn}:*"]
  }
}

resource "aws_iam_role_policy" "runtime" {
  name   = "${var.function_name}-runtime"
  role   = aws_iam_role.this.id
  policy = data.aws_iam_policy_document.runtime.json
}

resource "aws_iam_role_policy" "additional" {
  count = var.additional_iam_policy_json == null ? 0 : 1

  name   = "${var.function_name}-additional"
  role   = aws_iam_role.this.id
  policy = var.additional_iam_policy_json
}

resource "aws_iam_role_policy_attachment" "vpc_access" {
  count = local.vpc_enabled ? 1 : 0

  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/aws/lambda/${var.function_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_lambda_function" "this" {
  function_name = var.function_name
  description   = var.description
  role          = aws_iam_role.this.arn

  package_type = "Image"
  image_uri    = var.image_uri
  architectures = [
    var.architecture,
  ]

  memory_size                    = var.memory_size
  timeout                        = var.timeout_seconds
  reserved_concurrent_executions = var.reserved_concurrency

  dynamic "vpc_config" {
    for_each = local.vpc_enabled ? [true] : []
    content {
      subnet_ids         = var.subnet_ids
      security_group_ids = var.security_group_ids
    }
  }

  environment {
    variables = var.environment_variables
  }

  tags = var.tags

  depends_on = [
    aws_cloudwatch_log_group.this,
    aws_iam_role_policy.runtime,
    aws_iam_role_policy.additional,
    aws_iam_role_policy_attachment.vpc_access,
  ]

  lifecycle {
    precondition {
      condition = var.queue_visibility_timeout_seconds >= (
        6 * var.timeout_seconds + var.maximum_batching_window_seconds
      )
      error_message = "The source queue visibility timeout must be at least six times the Lambda timeout plus the batching window."
    }
  }
}

resource "aws_lambda_event_source_mapping" "this" {
  event_source_arn = var.queue_arn
  function_name    = aws_lambda_function.this.arn
  enabled          = true

  batch_size                         = var.batch_size
  maximum_batching_window_in_seconds = var.maximum_batching_window_seconds
  function_response_types            = ["ReportBatchItemFailures"]

  dynamic "scaling_config" {
    for_each = var.maximum_concurrency == null ? [] : [var.maximum_concurrency]
    content {
      maximum_concurrency = scaling_config.value
    }
  }
}
