# Alarms (Task 32): tell the team by email, through the alerts topic from alerts.tf, when the scan
# pipeline is stuck or failing. Three things can go wrong without any user seeing an error:
# scans waiting in the queue, messages that gave up (the DLQ), and scanner tasks that crashed.

# ---------- Scans waiting too long in the queue ----------
# The launcher normally takes a message within seconds. An old message means the launcher is
# failing, throttled, or capped by launcher_max_concurrency while scans pile up.

resource "aws_cloudwatch_metric_alarm" "scan_queue_age" {
  alarm_name          = "${local.prefix}-scan-queue-age"
  alarm_description   = "The oldest scan has waited in the queue longer than ${var.queue_age_alarm_seconds} seconds. Check the launcher's logs."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateAgeOfOldestMessage"
  dimensions          = { QueueName = aws_sqs_queue.scan.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = var.queue_age_alarm_seconds
  comparison_operator = "GreaterThanThreshold"
  # An empty queue reports nothing, which is the healthy state.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- Messages in the dead-letter queue ----------
# A scan message lands here after 3 failed launches and is kept 14 days. Any message at all means
# a job the launcher could not handle, so the threshold is 0.

resource "aws_cloudwatch_metric_alarm" "scan_dlq_not_empty" {
  alarm_name          = "${local.prefix}-scan-dlq-not-empty"
  alarm_description   = "A scan message failed 3 times and is in the dead-letter queue. Read it, fix the cause, then purge or redrive it."
  namespace           = "AWS/SQS"
  metric_name         = "ApproximateNumberOfMessagesVisible"
  dimensions          = { QueueName = aws_sqs_queue.scan_dlq.name }
  statistic           = "Maximum"
  period              = 60
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}

# ---------- Scanner tasks that failed ----------
# Container Insights is off (ecs.tf, it costs extra), so ECS publishes no task metrics. ECS does
# send a "Task State Change" event for every stopped task, so a second rule on the same event
# source as scanner_task_stopped catches the failures and publishes straight to the topic.
# This also fires when the reaper stops a task that ran too long (exit code 137): that is a
# failed scan too.

resource "aws_cloudwatch_event_rule" "scanner_task_failed" {
  name        = "${local.prefix}-scanner-task-failed"
  description = "A scanner task stopped with a non-zero exit code, or could not start: email the team"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.scanners.arn]
      lastStatus = ["STOPPED"]
      "$or" = [
        { containers = { exitCode = [{ "anything-but" = [0] }] } },
        { stopCode = ["TaskFailedToStart"] },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "scanner_task_failed" {
  rule = aws_cloudwatch_event_rule.scanner_task_failed.name
  arn  = aws_sns_topic.alerts.arn

  # The event is emailed as JSON (task ARN, startedBy = job ID, stop reason, exit code).
}

# CloudWatch alarms in this account may publish to the topic by default, but EventBridge may not.
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowAccountOwner"
        Effect    = "Allow"
        Principal = { AWS = "*" }
        Action    = ["sns:Publish", "sns:Subscribe", "sns:Receive", "sns:GetTopicAttributes", "sns:ListSubscriptionsByTopic"]
        Resource  = aws_sns_topic.alerts.arn
        Condition = { StringEquals = { "AWS:SourceOwner" = data.aws_caller_identity.current.account_id } }
      },
      {
        Sid       = "AllowEventBridgeTaskFailed"
        Effect    = "Allow"
        Principal = { Service = "events.amazonaws.com" }
        Action    = "sns:Publish"
        Resource  = aws_sns_topic.alerts.arn
        Condition = { ArnEquals = { "aws:SourceArn" = aws_cloudwatch_event_rule.scanner_task_failed.arn } }
      },
    ]
  })
}
