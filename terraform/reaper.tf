# Reaper: fails scans stuck in QUEUED or RUNNING for more than 25 minutes and stops their scanner
# task (docs/architecture.md 5.6). It runs on a schedule, so it is not behind an API route.

module "reaper" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-reaper"
  source_dir         = "${local.lambda_build_dir}/reaper"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days
  timeout            = 60

  environment = {
    JOBS_TABLE  = aws_dynamodb_table.jobs.name
    CLUSTER_ARN = aws_ecs_cluster.scanners.arn
  }
}

# A stuck scan is found within 5 minutes after it passes the 25-minute limit.
resource "aws_cloudwatch_event_rule" "reaper" {
  name                = "${local.prefix}-reaper"
  description         = "Every 5 minutes: fail scans stuck in QUEUED or RUNNING and stop their tasks"
  schedule_expression = "rate(5 minutes)"
}

resource "aws_cloudwatch_event_target" "reaper" {
  rule = aws_cloudwatch_event_rule.reaper.name
  arn  = module.reaper.arn
}

resource "aws_lambda_permission" "reaper_from_eventbridge" {
  statement_id  = "AllowEventBridgeSchedule"
  action        = "lambda:InvokeFunction"
  function_name = module.reaper.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.reaper.arn
}
