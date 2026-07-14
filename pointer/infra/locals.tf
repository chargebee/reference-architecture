locals {
  name_prefix    = "pointer"
  domain         = "pointer.chargebee-labs.com"
  container_port = 3000
  vpc_cidr       = "10.20.0.0/16"
  az_count       = 2
  azs            = slice(data.aws_availability_zones.available.names, 0, local.az_count)

  # Shared env + secrets injected into every pointer container (app + migrate).
  container_env = [
    { name = "NODE_ENV", value = "production" },
    { name = "AWS_REGION", value = var.region },
    { name = "CHARGEBEE_WEBHOOK_SQS_QUEUE_URL", value = aws_sqs_queue.main.url },
    { name = "REDIS_URL", value = "redis://${aws_elasticache_cluster.app.cache_nodes[0].address}:${aws_elasticache_cluster.app.cache_nodes[0].port}" },
    { name = "BETTER_AUTH_URL", value = "https://${local.domain}" },
    { name = "BETTER_AUTH_TRUSTED_ORIGINS", value = "https://${local.domain}" },
  ]

  container_secrets = [
    {
      name      = "DATABASE_URL"
      valueFrom = "${aws_secretsmanager_secret.db.arn}:database_url::"
    },
    {
      name      = "BETTER_AUTH_SECRET"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:better_auth_secret::"
    },
    {
      name      = "CHARGEBEE_SITE"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:chargebee_site::"
    },
    {
      name      = "CHARGEBEE_API_KEY"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:chargebee_api_key::"
    },
    {
      name      = "CHARGEBEE_WEBHOOK_USERNAME"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:chargebee_webhook_username::"
    },
    {
      name      = "CHARGEBEE_WEBHOOK_PASSWORD"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:chargebee_webhook_password::"
    },
    {
      name      = "ADMIN_USER_IDS"
      valueFrom = "${aws_secretsmanager_secret.app.arn}:admin_user_ids::"
    }
  ]
}
