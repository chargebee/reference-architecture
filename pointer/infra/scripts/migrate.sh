#!/usr/bin/env bash
#
# Run the Better Auth migration task on Fargate, wait for it to finish, and
# surface the container exit code. Network config (subnets + security group)
# is borrowed from the live pointer-app service so the script has no other
# inputs beyond the AWS profile.
#
# Usage:
#   AWS_PROFILE=poc ./scripts/migrate.sh [--region us-east-1]
#
# Prerequisites:
#   - The :migrate-latest image has been pushed to ECR (built from the
#     Dockerfile `builder` target).
#   - `terraform apply` has created pointer-cluster, pointer-app service,
#     and the pointer-app-migrate task definition.

set -euo pipefail
set -x

CLUSTER="pointer-cluster"
SERVICE="pointer-app"
TASK_DEF="pointer-app-migrate"

export AWS_REGION="${AWS_REGION:-us-east-1}"
export AWS_PAGER=""

aws_cli() {
  docker run --rm -i -v ~/.aws:/root/.aws -v $(pwd):/aws --env-file <(env | grep ^AWS_) amazon/aws-cli "$@"
}

echo ">> borrowing network config from service $SERVICE"
NETWORK_CONFIG="$(aws_cli ecs describe-services \
  --cluster "$CLUSTER" \
  --services "$SERVICE" \
  --query 'services[0].networkConfiguration' \
  --output json)"

if [[ "$NETWORK_CONFIG" == "null" ]]; then
  echo "error: could not read networkConfiguration from $SERVICE" >&2
  exit 1
fi

echo ">> starting migration task ($TASK_DEF)"
TASK_ARN="$(aws_cli ecs run-task \
  --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" \
  --launch-type FARGATE \
  --network-configuration "$NETWORK_CONFIG" \
  --started-by "migrate.sh" \
  --query 'tasks[0].taskArn' \
  --output text)"

echo ">> task ARN: $TASK_ARN"
echo ">> waiting for task to stop (this can take ~30-90s)..."
aws_cli ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$TASK_ARN"

DESCRIBE="$(aws_cli ecs describe-tasks \
  --cluster "$CLUSTER" \
  --tasks "$TASK_ARN" \
  --output json)"

EXIT_CODE="$(echo "$DESCRIBE" | jq -r '.tasks[0].containers[0].exitCode // "null"')"
STOPPED_REASON="$(echo "$DESCRIBE" | jq -r '.tasks[0].stoppedReason // ""')"

echo ">> container exit code: $EXIT_CODE"
[[ -n "$STOPPED_REASON" ]] && echo ">> stopped reason: $STOPPED_REASON"
echo ">> logs: aws logs tail /ecs/pointer-app-migrate --since 10m --follow"

if [[ "$EXIT_CODE" != "0" ]]; then
  exit 1
fi
