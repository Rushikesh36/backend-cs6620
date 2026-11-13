# New-HIGH-finding emails (Task 24, docs/architecture.md 5.5). The processor publishes to this
# topic when a completed scan has newHigh >= 1; the email subscription forwards it.
# AWS first emails var.alert_email a confirmation link; nothing arrives until it is clicked.

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
