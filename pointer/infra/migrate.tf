# Standalone migration task (database schema migrations).
#
# Run before each deployment with:
#   ./scripts/migrate.sh
# or via the AWS console: ECS -> pointer-cluster -> Tasks -> Run new task.
#
# Uses a separate image tag (:migrate-latest) built from the Dockerfile's
# `builder` stage, which contains the full source + node_modules required by
# `pnpm db:migrate` (the slim runtime image at :latest does not).
#
# `db:migrate` applies the hand-written usage-archive DDL before invoking the
# Better Auth CLI. The order is load-bearing: `usage_event` is partitioned by
# week, the CLI cannot express that, and there is no in-place conversion from an
# unpartitioned table.

resource "aws_cloudwatch_log_group" "migrate" {
  name              = "/ecs/${local.name_prefix}-app-migrate"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "migrate" {
  family                   = "${local.name_prefix}-app-migrate"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "${local.name_prefix}-app-migrate"
      image     = "${aws_ecr_repository.app.repository_url}:migrate-latest"
      essential = true

      command = ["pnpm", "db:migrate"]

      environment = local.container_env
      secrets     = local.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.migrate.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}
