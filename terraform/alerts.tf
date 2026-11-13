# New-HIGH-finding emails (Task 24, docs/architecture.md 5.5). The processor publishes to this
# topic when a completed scan has newHigh >= 1; every email subscription gets a copy.
# AWS first emails each address a confirmation link; nothing arrives there until it is clicked.

resource "aws_sns_topic" "alerts" {
  name = "${local.prefix}-alerts"
}

resource "aws_sns_topic_subscription" "alert_email" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

# Teammates who should get the same emails. alert_email is left out so it is not subscribed twice.
resource "aws_sns_topic_subscription" "extra_alert_email" {
  for_each = setsubtract(toset(var.extra_alert_emails), [var.alert_email])

  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = each.value
}
