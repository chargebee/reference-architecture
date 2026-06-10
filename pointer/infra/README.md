# Pointer App Infrastructure (Terraform)

Terraform stack for the `pointer` Next.js app: VPC, ALB, ACM, Route53, ECS Fargate, ECR, RDS Postgres, SQS + DLQ.

Public URL after apply: `https://pointer.localcblabs.com`.

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
| Network | `pointer-vpc` (10.20.0.0/16), IGW, 2 public subnets across 2 AZs |
| ALB | `pointer-alb` with HTTPS (TLS 1.2+), HTTP -> HTTPS redirect, target group `pointer-tg` |
| Cert | Looks up the existing `*.localcblabs.com` ACM cert by domain (not managed by this stack) |
| DNS | A-alias record `pointer.localcblabs.com` -> ALB |
| ECR | `pointer-app` repo (AES256, scan-on-push) |
| ECS | `pointer-cluster`, `pointer-app` Fargate service (1 task, 512 CPU / 1024 MiB, port 3000) |
| RDS | `pointer-db` Postgres (latest default version), `db.t4g.micro`, single-AZ, encrypted at rest, TLS enforced |
| Secrets | `pointer-db-credentials` (auto-generated DB password) and `pointer-app-secrets` (app/Chargebee secrets, populated out-of-band) |
| SQS | `pointer-queue` + `pointer-dlq` (SSE on both, maxReceiveCount=5) |
| Logs | `/ecs/pointer-app` CloudWatch log group (14-day retention) |

All resources are prefixed with `pointer-` and tagged `Project=pointer`, `ManagedBy=terraform`.

## Variables

Only two:

| Name | Default | Notes |
| --- | --- | --- |
| `aws_profile` | (required) | AWS named profile to authenticate with |
| `region` | `us-east-1` | AWS region |

Everything else lives in `locals` inside [providers.tf](providers.tf).

## Prerequisites

1. **Terraform** `>= 1.6.0`.
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

The ECS service can't start until an image exists in ECR, so we apply in two passes.

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

# From the Next.js app root (pointer/) — build both image tags:
#   :latest         -> slim runtime image (Next.js standalone)
#   :migrate-latest -> full builder image used by the migration task
docker buildx build --platform linux/arm64 -t $REPO:latest                   --push .
docker buildx build --platform linux/arm64 -t $REPO:migrate-latest --target builder --push .

# 3. Apply the rest
terraform apply
```

When `apply` completes, outputs include `app_url`, `alb_dns_name`, `ecr_repository_url`, `sqs_queue_url`, `db_secret_arn`, `app_secret_arn`, and `migrate_task_family`.

## Deploying a new image

```bash
# 1. Build & push both image tags
docker buildx build --platform linux/arm64 -t $REPO:latest                   --push .
docker buildx build --platform linux/arm64 -t $REPO:migrate-latest --target builder --push .

# 2. Run Better Auth migrations against the new schema
AWS_PROFILE=poc ./scripts/migrate.sh

# 3. Roll the app service onto the new :latest image
aws --profile poc ecs update-service \
  --cluster pointer-cluster \
  --service pointer-app \
  --force-new-deployment
```

## Database migrations

Better Auth's schema migrations are run by a dedicated, short-lived Fargate task (`pointer-app-migrate`) — **not** by the application container. The task uses a separate image tag (`:migrate-latest`) built from the Dockerfile's `builder` stage, because the slim standalone runtime image at `:latest` doesn't ship the better-auth CLI or full `node_modules`.

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

## Tear down

```bash
terraform destroy
```

RDS is configured with `skip_final_snapshot = true` and ECR with `force_delete = true` so destroys are clean for a POC. **Do not use these settings in production.**

## Application config

The ECS task receives env vars from two sources.

**Plaintext (from the task definition):**

| Var | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `PORT` | `3000` |
| `AWS_REGION` | `<region>` |
| `SQS_QUEUE_URL` | primary queue URL |
| `BETTER_AUTH_URL` | `https://pointer.localcblabs.com` |

**Injected from Secrets Manager (decrypted by the ECS execution role at task start):**

| Var | Source |
| --- | --- |
| `DATABASE_URL` | `pointer-db-credentials` → `database_url` |
| `BETTER_AUTH_SECRET` | `pointer-app-secrets` → `better_auth_secret` |
| `CHARGEBEE_SITE` | `pointer-app-secrets` → `chargebee_site` |
| `CHARGEBEE_API_KEY` | `pointer-app-secrets` → `chargebee_api_key` |
| `CHARGEBEE_WEBHOOK_USERNAME` | `pointer-app-secrets` → `chargebee_webhook_username` |
| `CHARGEBEE_WEBHOOK_PASSWORD` | `pointer-app-secrets` → `chargebee_webhook_password` |

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
  "chargebee_webhook_password": "..."
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
- **Network:** SGs reference each other (ALB -> ECS:3000, ECS -> RDS:5432); RDS not publicly accessible.
- **IAM:** Execution role's `GetSecretValue` scoped to the single DB secret ARN. Task role's SQS actions scoped to the queue ARN. No wildcard resources.
- **Secrets:** DB password generated by `random_password`, stored only in Secrets Manager, injected via ECS `secrets` (never `environment`). Not exposed in outputs.
- **ALB:** `drop_invalid_header_fields = true`.
- **ECR:** `scan_on_push = true`.

### POC trade-offs (harden before production)

- Single AZ for RDS, single-task ECS service.
- ECS tasks in public subnets with public IPs (no NAT Gateway).
- ECR `image_tag_mutability = MUTABLE` (deploys via `:latest`).
- RDS `skip_final_snapshot = true`, `deletion_protection = false`.
- ECR `force_delete = true`.
- No WAF, no VPC Flow Logs, no ALB access logs, no Performance Insights / Enhanced Monitoring.

## Related stacks

- [`writability-test/`](writability-test/) — separate, disposable stack used to verify the AWS profile can write into the account.
