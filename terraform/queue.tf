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
