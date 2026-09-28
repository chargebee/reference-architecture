#!/bin/bash
# LocalStack ready hook: provision the usage metrics lake bucket.
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-us-east-1}"
BUCKET_NAME="pointer-usage-local"

awslocal s3api create-bucket \
  --region "$REGION" \
  --bucket "$BUCKET_NAME"

echo "[init-s3] created bucket: $BUCKET_NAME"
