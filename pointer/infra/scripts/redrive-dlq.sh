#!/usr/bin/env bash
#
# Redrive Chargebee webhook messages from the DLQ back onto the main queue once
# the root cause of their failure has been fixed. Uses SQS-managed message move
# tasks (start-message-move-task), so there's no manual receive/delete loop.
#
# Usage:
#   AWS_PROFILE=poc ./scripts/redrive-dlq.sh --dry-run   # just report DLQ depth
#   AWS_PROFILE=poc ./scripts/redrive-dlq.sh             # move DLQ -> main queue
#
# Optional flags:
#   --region <r>              AWS region (default: $AWS_REGION or us-east-1)
#   --max-per-second <n>      Cap redrive velocity (default: unset = as fast as possible)
#
# Prerequisites:
#   - terraform apply has created pointer-dlq and pointer-queue.
#   - The DLQ's redrive-allow-policy permits the main queue (see infra/sqs.tf).

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DRY_RUN=0
MAX_PER_SECOND=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --region) REGION="$2"; shift 2 ;;
    --max-per-second) MAX_PER_SECOND="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

export AWS_REGION="$REGION"
export AWS_PAGER=""

DLQ_NAME="pointer-dlq"
MAIN_NAME="pointer-queue"

DLQ_URL="$(aws sqs get-queue-url --queue-name "$DLQ_NAME" --query 'QueueUrl' --output text)"
DLQ_ARN="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"
MAIN_URL="$(aws sqs get-queue-url --queue-name "$MAIN_NAME" --query 'QueueUrl' --output text)"
MAIN_ARN="$(aws sqs get-queue-attributes --queue-url "$MAIN_URL" --attribute-names QueueArn --query 'Attributes.QueueArn' --output text)"

DEPTH="$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names ApproximateNumberOfMessages --query 'Attributes.ApproximateNumberOfMessages' --output text)"
echo ">> DLQ $DLQ_NAME depth (approx): $DEPTH"

if [[ "$DRY_RUN" == "1" ]]; then
  echo ">> dry run: not moving any messages"
  exit 0
fi

if [[ "$DEPTH" == "0" ]]; then
  echo ">> nothing to redrive"
  exit 0
fi

echo ">> starting message move task: $DLQ_NAME -> $MAIN_NAME"
ARGS=(--source-arn "$DLQ_ARN" --destination-arn "$MAIN_ARN")
[[ -n "$MAX_PER_SECOND" ]] && ARGS+=(--max-number-of-messages-per-second "$MAX_PER_SECOND")

TASK_HANDLE="$(aws sqs start-message-move-task "${ARGS[@]}" --query 'TaskHandle' --output text)"
echo ">> task handle: $TASK_HANDLE"
echo ">> monitor with: aws sqs list-message-move-tasks --source-arn $DLQ_ARN --region $REGION"
