output "app_url" {
  description = "Public URL of the pointer app."
  value       = "https://${local.domain}"
}

output "alb_dns_name" {
  description = "Public DNS name of the ALB (Route53 record points here)."
  value       = aws_lb.app.dns_name
}

output "ecr_repository_url" {
  description = "ECR repository URL to push the Next.js image to (tag :latest)."
  value       = aws_ecr_repository.app.repository_url
}

output "sqs_queue_url" {
  description = "URL of the primary SQS queue."
  value       = aws_sqs_queue.main.url
}

output "sqs_dlq_url" {
  description = "URL of the webhook dead-letter queue (poison + exhausted-retry messages)."
  value       = aws_sqs_queue.dlq.url
}

output "redis_url" {
  description = "Connection URL for the ElastiCache Redis OSS cluster (VPC-internal)."
  value       = "redis://${aws_elasticache_cluster.app.cache_nodes[0].address}:${aws_elasticache_cluster.app.cache_nodes[0].port}"
}

output "db_secret_arn" {
  description = "ARN of the Secrets Manager secret holding DB credentials and DATABASE_URL."
  value       = aws_secretsmanager_secret.db.arn
}

output "app_secret_arn" {
  description = "ARN of the Secrets Manager secret holding app secrets (Better Auth, Chargebee). Populate values out-of-band."
  value       = aws_secretsmanager_secret.app.arn
}

output "migrate_task_family" {
  description = "ECS task definition family used to run Better Auth migrations (see scripts/migrate.sh)."
  value       = aws_ecs_task_definition.migrate.family
}

output "worker_service_name" {
  description = "ECS service running the Chargebee webhook worker (scale independently of the app)."
  value       = aws_ecs_service.worker.name
}
