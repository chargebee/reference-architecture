resource "aws_sqs_queue" "dlq" {
  name                       = "${local.name_prefix}-dlq"
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 30
}

resource "aws_sqs_queue" "main" {
  name = "${local.name_prefix}-queue"
  # 4 days. This is the real safety margin for out-of-order delivery: a
  # dependent event (e.g. a subscription before its customer) is retried with
  # increasing backoff until its prerequisite lands. Realistic out-of-order
  # gaps are seconds, so 4 days is ample headroom while maxReceiveCount caps
  # per-message retries before the DLQ.
  message_retention_seconds  = 345600
  sqs_managed_sse_enabled    = true
  visibility_timeout_seconds = 30

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "dlq" {
  queue_url = aws_sqs_queue.dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.main.arn]
  })
}

# --- DLQ monitoring -------------------------------------------------------
# Anything in the DLQ means a webhook could not be processed after 5 attempts
# (or was routed there as poison). Alert so it can be investigated and
# re-driven with infra/scripts/redrive-dlq.sh.

resource "aws_sns_topic" "webhook_dlq_alerts" {
  name              = "${local.name_prefix}-webhook-dlq-alerts"
  kms_master_key_id = "alias/aws/sns"
}

resource "aws_sns_topic_subscription" "webhook_dlq_email" {
  count     = var.dlq_alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.webhook_dlq_alerts.arn
  protocol  = "email"
  endpoint  = var.dlq_alert_email
}

resource "aws_cloudwatch_metric_alarm" "webhook_dlq_not_empty" {
  alarm_name          = "${local.name_prefix}-webhook-dlq-not-empty"
  alarm_description   = "Chargebee webhook DLQ has messages; investigate and redrive."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.dlq.name
  }

  alarm_actions = [aws_sns_topic.webhook_dlq_alerts.arn]
  ok_actions    = [aws_sns_topic.webhook_dlq_alerts.arn]
}
