resource "aws_elasticache_subnet_group" "app" {
  name       = "${local.name_prefix}-redis"
  subnet_ids = aws_subnet.public[*].id

  tags = {
    Name = "${local.name_prefix}-redis-subnet-group"
  }
}

resource "aws_security_group" "redis" {
  name        = "${local.name_prefix}-redis-sg"
  description = "Pointer ElastiCache Redis OSS"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-redis-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_ecs" {
  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from ECS tasks"
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "redis_from_lambda_worker" {
  count = local.lambda_worker_enabled ? 1 : 0

  security_group_id            = aws_security_group.redis.id
  description                  = "Redis from Lambda webhook worker"
  referenced_security_group_id = aws_security_group.lambda_worker[0].id
  from_port                    = 6379
  to_port                      = 6379
  ip_protocol                  = "tcp"
}

resource "aws_elasticache_cluster" "app" {
  cluster_id           = "${local.name_prefix}-redis"
  engine               = "redis"
  node_type            = "cache.t4g.micro"
  num_cache_nodes      = 1
  parameter_group_name = "default.redis7"
  port                 = 6379

  subnet_group_name  = aws_elasticache_subnet_group.app.name
  security_group_ids = [aws_security_group.redis.id]

  apply_immediately = true
}
