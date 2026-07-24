#!/bin/bash
# LocalStack ready hook: provision the Chargebee webhook SQS queue and its DLQ.
# Mirrors infra/sqs.tf (main queue -> DLQ redrive, maxReceiveCount=5) so local
# dev matches production. Runs once when LocalStack becomes ready.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
QUEUE_NAME="pointer-queue"
DLQ_NAME="pointer-dlq"

# Dead-letter queue (14 day retention, matching infra/sqs.tf).
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$DLQ_NAME" \
  --attributes '{"MessageRetentionPeriod":"1209600","VisibilityTimeout":"30"}'

DLQ_URL="$(awslocal sqs get-queue-url --region "$REGION" --queue-name "$DLQ_NAME" --query 'QueueUrl' --output text)"
DLQ_ARN="$(awslocal sqs get-queue-attributes --region "$REGION" --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

# Main queue (4 day retention) with redrive to the DLQ after 5 failed receives.
awslocal sqs create-queue \
  --region "$REGION" \
  --queue-name "$QUEUE_NAME" \
  --attributes '{
    "MessageRetentionPeriod": "345600",
    "VisibilityTimeout": "30",
    "RedrivePolicy": "{\"deadLetterTargetArn\":\"'"$DLQ_ARN"'\",\"maxReceiveCount\":\"5\"}"
  }'

echo "[init-sqs] created queues: $QUEUE_NAME (redrive -> $DLQ_NAME)"
echo "[init-sqs] CHARGEBEE_WEBHOOK_SQS_QUEUE_URL=http://localhost:4566/000000000000/${QUEUE_NAME}"
echo "[init-sqs] CHARGEBEE_WEBHOOK_DLQ_URL=http://localhost:4566/000000000000/${DLQ_NAME}"
