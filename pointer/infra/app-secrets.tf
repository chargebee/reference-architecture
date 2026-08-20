# Application-level secrets and config for the pointer app.
#
# Created with placeholder values by Terraform. Real values are set out-of-band
# (AWS console or `aws secretsmanager put-secret-value`) and Terraform ignores
# subsequent changes so `apply` never clobbers them.
#
# To set values:
#   aws --profile <profile> secretsmanager put-secret-value \
#     --secret-id pointer-app-secrets \
#     --secret-string file://app-secrets.json
#
# After updating, force a new ECS deployment so tasks re-fetch the secret:
#   aws --profile <profile> ecs update-service \
#     --cluster pointer-cluster --service pointer-app --force-new-deployment

resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name_prefix}-app-secrets"
  description             = "Pointer app secrets and Chargebee config (managed out-of-band)."
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    better_auth_secret         = "PLACEHOLDER-set-via-aws-cli"
    chargebee_site             = "PLACEHOLDER"
    chargebee_api_key          = "PLACEHOLDER"
    chargebee_webhook_username = "PLACEHOLDER"
    chargebee_webhook_password = "PLACEHOLDER"
    admin_user_ids             = ""
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
