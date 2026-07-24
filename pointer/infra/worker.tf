# Chargebee webhook worker — a standalone, independently scalable SQS consumer.
#
# Deployed as its own ECS service (NOT part of the pointer-app service) so it can
# scale on webhook backlog without touching request-serving capacity, and so a
# stuck/slow sync can never degrade the web tier. Like the migrate task, it runs
# the Dockerfile `builder` image (:worker-latest) because it needs the full
# source + node_modules (tsx, the plugin, pg, ioredis) that the slim :latest
# standalone runtime image does not ship.
#
# Horizontal scaling is exactly what the how-to prescribes: "Scales horizontally
# by running more processes." SQS fans messages across consumers and the
# visibility timeout stops two workers double-processing the same message, so no
# leader election / coordination is required — just run more tasks.

resource "aws_cloudwatch_log_group" "worker" {
  name              = "/ecs/${local.name_prefix}-worker"
  retention_in_days = 14
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${local.name_prefix}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution.arn
  # Same task role as the app: it already scopes sqs:ReceiveMessage/DeleteMessage
  # /ChangeMessageVisibility on the main queue and sqs:SendMessage on the DLQ.
  task_role_arn = aws_iam_role.task.arn

  runtime_platform {
    cpu_architecture        = "ARM64"
    operating_system_family = "LINUX"
  }

  container_definitions = jsonencode([
    {
      name      = "${local.name_prefix}-worker"
      image     = "${aws_ecr_repository.app.repository_url}:worker-latest"
      essential = true

      # tsx is a local dependency in the builder image, so npx runs it without a
      # network fetch. Resolves the "@/..." path aliases via tsconfig.json.
      command = ["npx", "tsx", "workers/chargebee-webhook-worker.ts"]

      # Give in-flight handlers time to finish on deploy/scale-in. The worker
      # traps SIGTERM and calls consumer.stop({ abort: false }) to drain.
      stopTimeout = 120

      environment = local.container_env
      secrets     = local.container_secrets

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.worker.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "worker" {
  name             = "${local.name_prefix}-worker"
  cluster          = aws_ecs_cluster.app.id
  task_definition  = aws_ecs_task_definition.worker.arn
  desired_count    = var.worker_desired_count
  launch_type      = "FARGATE"
  platform_version = "LATEST"

  # No load balancer: the worker pulls from SQS, it doesn't serve traffic. It
  # reuses the shared ECS security group (egress to SQS/RDS/Redis/Chargebee is
  # already allowed; the ALB ingress rule is simply unused here).
  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.ecs.id]
    assign_public_ip = true
  }

  # A queue consumer has no readiness gate, so allow a full rolling replace on
  # deploy; unprocessed messages just wait durably in SQS during the swap.
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 200

  # Autoscaling owns desired_count after creation — don't let Terraform reset it.
  lifecycle {
    ignore_changes = [desired_count]
  }
}

# --- Autoscaling on webhook backlog ----------------------------------------
# Scale the worker fleet on the depth of the main queue: more visible messages
# => more workers, draining back down to the floor when the backlog clears.

resource "aws_appautoscaling_target" "worker" {
  max_capacity       = var.worker_max_count
  min_capacity       = var.worker_min_count
  resource_id        = "service/${aws_ecs_cluster.app.name}/${aws_ecs_service.worker.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_scale_out" {
  name               = "${local.name_prefix}-worker-scale-out"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 60
    metric_aggregation_type = "Maximum"

    # +1 task for a moderate backlog, +2 once it is well above the threshold.
    step_adjustment {
      metric_interval_lower_bound = 0
      metric_interval_upper_bound = var.worker_scale_out_backlog * 4
      scaling_adjustment          = 1
    }
    step_adjustment {
      metric_interval_lower_bound = var.worker_scale_out_backlog * 4
      scaling_adjustment          = 2
    }
  }
}

resource "aws_appautoscaling_policy" "worker_scale_in" {
  name               = "${local.name_prefix}-worker-scale-in"
  policy_type        = "StepScaling"
  resource_id        = aws_appautoscaling_target.worker.resource_id
  scalable_dimension = aws_appautoscaling_target.worker.scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker.service_namespace

  step_scaling_policy_configuration {
    adjustment_type         = "ChangeInCapacity"
    cooldown                = 300
    metric_aggregation_type = "Maximum"

    step_adjustment {
      metric_interval_upper_bound = 0
      scaling_adjustment          = -1
    }
  }
}

resource "aws_cloudwatch_metric_alarm" "worker_backlog_high" {
  alarm_name          = "${local.name_prefix}-worker-backlog-high"
  alarm_description   = "Chargebee webhook queue backlog is high; add worker tasks."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.worker_scale_out_backlog
  comparison_operator = "GreaterThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_out.arn]
}

resource "aws_cloudwatch_metric_alarm" "worker_backlog_low" {
  alarm_name          = "${local.name_prefix}-worker-backlog-low"
  alarm_description   = "Chargebee webhook queue backlog is drained; remove worker tasks."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 3
  threshold           = var.worker_scale_in_backlog
  comparison_operator = "LessThanOrEqualToThreshold"
  treat_missing_data  = "notBreaching"

  dimensions = {
    QueueName = aws_sqs_queue.main.name
  }

  alarm_actions = [aws_appautoscaling_policy.worker_scale_in.arn]
}
