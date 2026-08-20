# The ECS worker resources became conditional when the Lambda runtime option was
# added. Preserve their existing state addresses when ECS remains selected.
moved {
  from = aws_cloudwatch_log_group.worker
  to   = aws_cloudwatch_log_group.worker[0]
}

moved {
  from = aws_ecs_task_definition.worker
  to   = aws_ecs_task_definition.worker[0]
}

moved {
  from = aws_ecs_service.worker
  to   = aws_ecs_service.worker[0]
}

moved {
  from = aws_appautoscaling_target.worker
  to   = aws_appautoscaling_target.worker[0]
}

moved {
  from = aws_appautoscaling_policy.worker_scale_out
  to   = aws_appautoscaling_policy.worker_scale_out[0]
}

moved {
  from = aws_appautoscaling_policy.worker_scale_in
  to   = aws_appautoscaling_policy.worker_scale_in[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.worker_backlog_high
  to   = aws_cloudwatch_metric_alarm.worker_backlog_high[0]
}

moved {
  from = aws_cloudwatch_metric_alarm.worker_backlog_low
  to   = aws_cloudwatch_metric_alarm.worker_backlog_low[0]
}
