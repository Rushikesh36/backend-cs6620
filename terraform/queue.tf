# Scan queue. POST /scans/{id}/start puts a message here; the launcher Lambda reads it.
# Messages that fail 3 times move to the dead-letter queue (DLQ) so nothing is lost silently.

resource "aws_sqs_queue" "scan_dlq" {
  name                      = "${local.prefix}-scan-dlq"
  message_retention_seconds = 1209600 # 14 days, to leave time to look at failures
}

resource "aws_sqs_queue" "scan" {
  name = "${local.prefix}-scan"
  # Must be longer than the launcher Lambda timeout, or messages are delivered twice.
  visibility_timeout_seconds = 60
  message_retention_seconds  = 86400 # 1 day: a scan nobody started by tomorrow is stale

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dlq.arn
    maxReceiveCount     = 3
  })
}

# SQS -> launcher. AWS polls the queue and calls the Lambda, so the launcher has no polling code.
resource "aws_lambda_event_source_mapping" "launcher" {
  event_source_arn = aws_sqs_queue.scan.arn
  function_name    = module.launcher.function_name
  # One scan per invocation, so one failure never holds back another scan.
  batch_size = 1
  # Report only the failed message back to SQS (see lambdas/launcher/handler.ts).
  function_response_types = ["ReportBatchItemFailures"]

  # Caps how many launchers run at once. The project decided against reserved concurrency (TASKS.md,
  # Task 20). The minimum AWS allows here is 2.
  scaling_config {
    maximum_concurrency = var.launcher_max_concurrency
  }
}
