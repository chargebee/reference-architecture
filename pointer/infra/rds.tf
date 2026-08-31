data "aws_rds_engine_version" "postgres" {
  engine       = "postgres"
  default_only = true
}

resource "aws_db_subnet_group" "app" {
  name       = "${local.name_prefix}-db"
  subnet_ids = aws_subnet.public[*].id

  tags = {
    Name = "${local.name_prefix}-db-subnet-group"
  }
}

resource "aws_security_group" "db" {
  name        = "${local.name_prefix}-db-sg"
  description = "Pointer RDS Postgres"
  vpc_id      = aws_vpc.main.id

  tags = {
    Name = "${local.name_prefix}-db-sg"
  }
}

resource "aws_vpc_security_group_ingress_rule" "db_from_ecs" {
  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from ECS tasks"
  referenced_security_group_id = aws_security_group.ecs.id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_vpc_security_group_ingress_rule" "db_from_lambda_worker" {
  count = local.lambda_worker_enabled ? 1 : 0

  security_group_id            = aws_security_group.db.id
  description                  = "Postgres from Lambda webhook worker"
  referenced_security_group_id = aws_security_group.lambda_worker[0].id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}

resource "aws_db_parameter_group" "app" {
  name        = "${local.name_prefix}-db-pg"
  family      = "postgres${split(".", data.aws_rds_engine_version.postgres.version)[0]}"
  description = "Pointer Postgres parameter group to enforce TLS"

  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }

  # pg_cron creates the weekly `usage_event` partitions. It is loaded at server
  # start, so this is a static parameter: Terraform stages it, and the instance
  # must be rebooted before `CREATE EXTENSION pg_cron` will succeed. See the
  # "Database migrations" section of infra/README.md.
  parameter {
    name         = "shared_preload_libraries"
    value        = "pg_cron"
    apply_method = "pending-reboot"
  }

  # pg_cron keeps its metadata in exactly one database and defaults to
  # `postgres`. Jobs scheduled from the app database would never be read.
  parameter {
    name         = "cron.database_name"
    value        = local.db_name
    apply_method = "pending-reboot"
  }
}

resource "random_password" "db_master" {
  length  = 32
  special = true
  # RDS disallows: / @ " and space in master passwords.
  override_special = "!#$%&*()-_=+[]{}<>:?"
}

resource "aws_secretsmanager_secret" "db" {
  name                    = "${local.name_prefix}-db-credentials"
  description             = "Master credentials and connection info for the pointer Postgres database"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db" {
  secret_id = aws_secretsmanager_secret.db.id
  secret_string = jsonencode({
    username     = aws_db_instance.app.username
    password     = random_password.db_master.result
    host         = aws_db_instance.app.address
    port         = aws_db_instance.app.port
    dbname       = aws_db_instance.app.db_name
    database_url = "postgresql://${aws_db_instance.app.username}:${urlencode(random_password.db_master.result)}@${aws_db_instance.app.address}:${aws_db_instance.app.port}/${aws_db_instance.app.db_name}?uselibpqcompat=true&sslmode=require"
  })
}

resource "aws_db_instance" "app" {
  identifier     = "${local.name_prefix}-db"
  engine         = "postgres"
  engine_version = data.aws_rds_engine_version.postgres.version
  instance_class = "db.t4g.micro"

  allocated_storage     = 20
  max_allocated_storage = 100
  storage_type          = "gp3"
  storage_encrypted     = true

  db_name  = local.db_name
  username = "pointer"
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.app.name
  vpc_security_group_ids = [aws_security_group.db.id]
  parameter_group_name   = aws_db_parameter_group.app.name
  publicly_accessible    = false
  multi_az               = false

  backup_retention_period    = 7
  copy_tags_to_snapshot      = true
  auto_minor_version_upgrade = true

  # POC convenience — flip both of these for prod.
  skip_final_snapshot = true
  deletion_protection = false

  apply_immediately = true
}
