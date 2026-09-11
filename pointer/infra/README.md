# Pointer App Infrastructure (Terraform)

Terraform stack for the `pointer` Next.js app: VPC, ALB, ACM, Route53, ECS Fargate, optional Lambda worker, ECR, RDS Postgres, SQS + DLQ.

Public URL after apply: `https://pointer.chargebee-labs.com`.

## Layout

```
pointer/infra/
  versions.tf providers.tf variables.tf
  vpc.tf ecr.tf acm.tf alb.tf ecs.tf rds.tf sqs.tf route53.tf outputs.tf
  backend.hcl.example terraform.tfvars.example
  writability-test/      <- separate stack to verify AWS write access
```

## What gets created

| Component | Resource |
| --- | --- |
| Network | `pointer-vpc` (10.20.0.0/16), IGW, 2 public subnets; Lambda mode adds 2 private subnets and one NAT gateway |
| ALB | `pointer-alb` with HTTPS (TLS 1.2+), HTTP -> HTTPS redirect, target group `pointer-tg` |
| Cert | Looks up the existing `*.localcblabs.com` ACM cert by domain (not managed by this stack) |
| DNS | A-alias record `pointer.chargebee-labs.com` -> ALB |
| ECR | `pointer-app` repo (AES256, scan-on-push) |
| ECS | `pointer-cluster`, `pointer-app` Fargate service (1 task, 512 CPU / 1024 MiB, port 3000) |
| Worker | `pointer-worker` runs as either an ECS Fargate service with queue-depth autoscaling (default), or an SQS-triggered ARM64 Lambda |
| RDS | `pointer-db` Postgres (latest default version), `db.t4g.micro`, single-AZ, encrypted at rest, TLS enforced |
| Secrets | `pointer-db-credentials` (auto-generated DB password) and `pointer-app-secrets` (app/Chargebee secrets, populated out-of-band) |
| SQS | `pointer-queue` + `pointer-dlq` (SSE on both, maxReceiveCount=5) |
| Logs | `/ecs/pointer-app` plus `/ecs/pointer-worker` or `/aws/lambda/pointer-worker` (14-day retention) |

All resources are prefixed with `pointer-` and tagged `Project=pointer`, `ManagedBy=terraform`.

## Variables

| Name | Default | Notes |
| --- | --- | --- |
| `aws_profile` | (required) | AWS named profile to authenticate with |
| `region` | `us-east-1` | AWS region |
| `worker_runtime` | `ecs` | Exactly one queue consumer: `ecs` or `lambda` |
| `worker_lambda_image_tag` | `lambda-worker-latest` | ECR tag resolved to a digest when Lambda is selected |
| `worker_lambda_memory_size` | `1024` | Lambda memory in MB |
| `worker_lambda_timeout_seconds` | `60` | Lambda timeout; queue visibility becomes 6x this value |
| `worker_lambda_batch_size` | `10` | Records per Lambda invocation |
| `worker_lambda_max_concurrency` | `2` | Event-source and reserved concurrency cap |

The ECS-specific `worker_*` scaling variables remain available when
`worker_runtime = "ecs"`. See [variables.tf](variables.tf) for the full list.

## Prerequisites

1. **Terraform** `>= 1.15.0`.
2. **AWS profile** with admin-equivalent permissions for the listed services.
3. **State bucket** (created manually):
   ```bash
   aws --profile <profile> s3api create-bucket \
     --bucket <tf-state-bucket> --region us-east-1
   aws --profile <profile> s3api put-bucket-versioning \
     --bucket <tf-state-bucket> --versioning-configuration Status=Enabled
   aws --profile <profile> s3api put-bucket-encryption \
     --bucket <tf-state-bucket> \
     --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
   ```
4. **Route53 hosted zone** for `localcblabs.com` must already exist in the same account (public or private).
5. **ACM certificate** for `*.localcblabs.com` must already exist (`ISSUED` status) in `us-east-1` — this stack looks it up rather than creating one, since the zone isn't publicly resolvable for DNS validation.

## Configure

```bash
cd pointer/infra

cp backend.hcl.example backend.hcl              # fill in state bucket + profile
cp terraform.tfvars.example terraform.tfvars    # fill in aws_profile
```

## Apply (two-step bootstrap)

The app and selected worker can't start until their images exist in ECR, so we apply in two passes.

```bash
terraform init -backend-config=backend.hcl

# 1. Create the ECR repo first
terraform apply -target=aws_ecr_repository.app

# 2. Build & push the Next.js image as :latest
ACCOUNT_ID=$(aws --profile poc sts get-caller-identity --query Account --output text)
REGION=us-east-1
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/pointer-app

aws --profile <profile> ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# From the Next.js app root (pointer/) — build all image tags:
#   :latest         -> slim runtime image (Next.js standalone) for pointer-app
#   :migrate-latest -> full builder image used by the migration task
#   :worker-latest  -> full builder image used by the webhook worker service
#   :lambda-worker-latest -> bundled AWS Lambda Node.js 22 runtime image
docker buildx build --platform linux/arm64 -t $REPO:latest                   --push .
docker buildx build --platform linux/arm64 -t $REPO:migrate-latest --target builder --push .
docker buildx build --platform linux/arm64 -t $REPO:worker-latest  --target builder --push .
docker buildx build --platform linux/arm64 -t $REPO:lambda-worker-latest --target lambda-worker --push .

# 3. Apply the rest
terraform apply
```

When `apply` completes, outputs include `app_url`, `alb_dns_name`,
`ecr_repository_url`, `sqs_queue_url`, `worker_runtime`, and the selected
runtime's worker name (the other runtime output is `null`).

## Deploying a new image

```bash
# 1. Build & push all image tags
docker buildx build --platform linux/arm64 -t $REPO:latest                   --push .
docker buildx build --platform linux/arm64 -t $REPO:migrate-latest --target builder --push .
docker buildx build --platform linux/arm64 -t $REPO:worker-latest  --target builder --push .
docker buildx build --platform linux/arm64 -t $REPO:lambda-worker-latest --target lambda-worker --push .

# 2. Run Better Auth migrations against the new schema
AWS_PROFILE=poc ./scripts/migrate.sh

# 3. Roll the app service onto the new :latest image
aws --profile poc ecs update-service \
  --cluster pointer-cluster \
  --service pointer-app \
  --force-new-deployment

# 4a. ECS mode: roll the worker service onto the new :worker-latest image
aws --profile poc ecs update-service \
  --cluster pointer-cluster \
  --service pointer-worker \
  --force-new-deployment

# 4b. Lambda mode: apply so Terraform resolves the updated tag to its new digest
terraform apply
```

## Database migrations

Schema migrations are run by a dedicated, short-lived Fargate task (`pointer-app-migrate`) — **not** by the application container. The task uses a separate image tag (`:migrate-latest`) built from the Dockerfile's `builder` stage, because the slim standalone runtime image at `:latest` doesn't ship the better-auth CLI or full `node_modules`.

The task runs `pnpm db:migrate`, which is two steps in a load-bearing order:

1. `scripts/migrate-usage.ts` applies the usage archive's hand-written DDL — the weekly-partitioned `usage_event` table, its single index, and the pg_cron job that provisions upcoming partitions.
2. `@better-auth/cli migrate` applies everything declared in `lib/auth.ts` and its plugins.

The order matters because the CLI cannot emit `PARTITION BY RANGE`. On a fresh database it would create an unpartitioned `usage_event` first, and Postgres has no in-place conversion. Run the other way around, the CLI sees the partitioned table as already existing and limits itself to adding columns.

**One-time pg_cron enablement.** `shared_preload_libraries` is a static parameter, so Terraform only stages it — the extension cannot be created until the instance restarts. After the first `terraform apply` that includes it:

```bash
aws --profile poc rds reboot-db-instance --db-instance-identifier pointer-db
aws --profile poc rds wait db-instance-available --db-instance-identifier pointer-db
```

Until then `db:migrate` logs a warning and falls back to creating partitions once per deployment, which is enough to keep writes landing but leaves no scheduler.

**Run them automatically:**

```bash
AWS_PROFILE=poc ./scripts/migrate.sh
```

The script borrows network config (subnets + security group) from the live `pointer-app` service, runs `pointer-app-migrate` as a one-off task, waits for it to stop, and exits with the container's exit code. Logs go to `/ecs/pointer-app-migrate`:

```bash
aws --profile poc logs tail /ecs/pointer-app-migrate --since 10m --follow
```

**Run them manually via the AWS console:**

ECS → `pointer-cluster` → **Tasks** tab → **Run new task** → Launch type **Fargate**, Task definition family **pointer-app-migrate**, latest revision. Under Networking, pick the same subnets and security group as the `pointer-app` service (Assign public IP: **enabled**). Click **Create**. Watch the task in **Tasks**; check logs at `/ecs/pointer-app-migrate`.

Run migrations **before** rolling the app service so the new schema is in place when new app tasks come up.

## Chargebee webhook worker

The webhook ingress endpoint validates, enqueues to SQS, and returns `2xx`.
Terraform's `worker_runtime` selects exactly one independent consumer of that
queue. ECS remains the default, so existing deployments do not change until
`worker_runtime = "lambda"` is set.

### ECS mode

The Fargate service runs `npx tsx workers/chargebee-webhook-worker.ts` from the
`:worker-latest` builder image. Autoscaling is driven by
`ApproximateNumberOfMessagesVisible`:

| Behaviour | Trigger | Effect |
| --- | --- | --- |
| Scale out | backlog ≥ `worker_scale_out_backlog` (default 100) for 1 min | +1 task, +2 when well above threshold |
| Scale in | backlog ≤ `worker_scale_in_backlog` (default 10) for 15 min | −1 task |
| Bounds | `worker_min_count` / `worker_max_count` (default 1 / 10) | floor & ceiling |

Terraform sets the initial `desired_count` (`worker_desired_count`) then ignores drift, so autoscaling owns it thereafter.

**Scale manually** (e.g. to drain a big backlog fast, or pause processing):

```bash
aws --profile poc ecs update-service \
  --cluster pointer-cluster \
  --service pointer-worker \
  --desired-count 5
```

**Tail worker logs:**

```bash
aws --profile poc logs tail /ecs/pointer-worker --since 10m --follow
```

### Lambda mode

Build and push the `lambda-worker` Docker target before selecting Lambda. The
function runs the same message processor as ECS but receives SQS records from an
event source mapping. `ReportBatchItemFailures` acknowledges successful records
and retries only failures. Existing visibility backoff, poison routing, the
source queue's five-attempt redrive policy, and the DLQ alarm are unchanged.

Lambda loads the two JSON secrets directly from Secrets Manager on cold start;
secret values are not copied into Terraform state or Lambda environment
configuration. The event source and function are both capped by
`worker_lambda_max_concurrency` to protect PostgreSQL/Redis connection capacity.

Because the worker needs private RDS/Redis and public Chargebee access, Lambda
runs in private subnets through one NAT gateway. This is a cost-conscious POC
layout; use one NAT per AZ for production availability.

```bash
# terraform.tfvars
worker_runtime = "lambda"

# Build and push first, then:
terraform apply
aws --profile poc logs tail /aws/lambda/pointer-worker --since 10m --follow
```

The generic [SQS-to-Lambda consumer module](modules/sqs-lambda-consumer/) owns
the execution role, function, logs, and event source mapping while accepting a
caller-managed queue. Future background jobs can reuse it without coupling
their queue lifecycle to the function.

## Tear down

```bash
terraform destroy
```

RDS is configured with `skip_final_snapshot = true` and ECR with `force_delete = true` so destroys are clean for a POC. **Do not use these settings in production.**

## Runtime config

ECS receives plaintext values and Secrets Manager field references. Lambda
receives the same non-secret values (AWS supplies `AWS_REGION`), plus the two
secret ARNs; its handler loads and validates both JSON values at cold start.

**Plaintext (from the task definition):**

| Var | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `AWS_REGION` | `<region>` |
| `CHARGEBEE_WEBHOOK_SQS_QUEUE_URL` | primary queue URL |
| `CHARGEBEE_WEBHOOK_DLQ_URL` | dead-letter queue URL |
| `BETTER_AUTH_URL` | `https://pointer.chargebee-labs.com` |

**Injected from Secrets Manager (decrypted by the ECS execution role at task start):**

| Var | Source |
| --- | --- |
| `DATABASE_URL` | `pointer-db-credentials` → `database_url` |
| `BETTER_AUTH_SECRET` | `pointer-app-secrets` → `better_auth_secret` |
| `CHARGEBEE_SITE` | `pointer-app-secrets` → `chargebee_site` |
| `CHARGEBEE_API_KEY` | `pointer-app-secrets` → `chargebee_api_key` |
| `CHARGEBEE_WEBHOOK_USERNAME` | `pointer-app-secrets` → `chargebee_webhook_username` |
| `CHARGEBEE_WEBHOOK_PASSWORD` | `pointer-app-secrets` → `chargebee_webhook_password` |
| `OPENROUTER_API_KEY` | `pointer-app-secrets` → `openrouter_api_key` |
| `ADMIN_USER_IDS` | `pointer-app-secrets` → `admin_user_ids` |

`.env.local` is **not** used in production. It's excluded from the Docker build via `.dockerignore`, and Next.js only reads it during `next dev` / `next build` on a developer machine.

### Setting the app secrets

`pointer-app-secrets` is created with placeholder values and `ignore_changes = [secret_string]`, so Terraform never overwrites real values. Set them once via CLI:

```bash
cat > app-secrets.json <<EOF
{
  "better_auth_secret": "$(openssl rand -base64 32)",
  "chargebee_site": "your-test-site",
  "chargebee_api_key": "test_xxxxxxxx",
  "chargebee_webhook_username": "...",
  "chargebee_webhook_password": "...",
  "admin_user_ids": ""
}
EOF

aws --profile <profile> secretsmanager put-secret-value \
  --secret-id pointer-app-secrets \
  --secret-string file://app-secrets.json

rm app-secrets.json

aws --profile <profile> ecs update-service \
  --cluster pointer-cluster \
  --service pointer-app \
  --force-new-deployment
```

The full DB credential bundle (username, password, host, port, dbname, database_url) is available in `pointer-db-credentials`.

## Security baseline

- **At rest:** RDS (KMS `aws/rds`), SQS (SSE), Secrets Manager (default KMS), ECR (AES256).
- **In transit:** ALB HTTPS only (TLS 1.2+; HTTP -> HTTPS redirect), RDS `rds.force_ssl=1`, `DATABASE_URL` uses `sslmode=require`.
- **Network:** SGs reference each other (ALB -> ECS:3000, compute -> RDS:5432/Redis:6379); RDS is not publicly accessible. Lambda mode uses private subnets and NAT egress.
- **IAM:** Execution role's `GetSecretValue` scoped to the single DB secret ARN. Task role's SQS actions scoped to the queue ARN. No wildcard resources.
- **Secrets:** DB password generated by `random_password`, stored only in Secrets Manager, injected via ECS `secrets` (never `environment`). Not exposed in outputs.
- **ALB:** `drop_invalid_header_fields = true`.
- **ECR:** `scan_on_push = true`.

### POC trade-offs (harden before production)

- Single AZ for RDS, single-task ECS service.
- ECS tasks in public subnets with public IPs. Lambda mode adds a single-AZ NAT gateway; use one per AZ for production.
- ECR `image_tag_mutability = MUTABLE` (deploys via `:latest`).
- RDS `skip_final_snapshot = true`, `deletion_protection = false`.
- ECR `force_delete = true`.
- No WAF, no VPC Flow Logs, no ALB access logs, no Performance Insights / Enhanced Monitoring.

## Related stacks

- [`writability-test/`](writability-test/) — separate, disposable stack used to verify the AWS profile can write into the account.
