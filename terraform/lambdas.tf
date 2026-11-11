# Lambdas that are not tied to one endpoint. Each endpoint's Lambda lives next to its route.
# Run `npm run build` first: it creates the folders under build/lambdas/.

module "authorizer" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-authorizer"
  source_dir         = "${local.lambda_build_dir}/authorizer"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    JWT_SECRET_SSM_NAME = var.jwt_secret_ssm_name
  }
}

# Results processor: reads a finished scan's report, diffs and stores its findings, and moves the
# job to COMPLETED or FAILED. Its only trigger is the EventBridge rule for stopped ECS tasks, which
# is added with the ECS cluster (Task 22). The one writer of the findings table.
module "processor" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-processor"
  source_dir         = "${local.lambda_build_dir}/processor"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days
  # Reports can hold thousands of findings: room to parse them and write in batches.
  memory_size = 512
  timeout     = 60

  environment = {
    JOBS_TABLE     = aws_dynamodb_table.jobs.name
    FINDINGS_TABLE = aws_dynamodb_table.findings.name
    REPORTS_BUCKET = data.aws_s3_bucket.reports.bucket
  }
}
