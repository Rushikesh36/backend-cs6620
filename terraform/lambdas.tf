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

# Launcher: reads the scan queue and starts one Fargate scanner task per job (docs/architecture.md 5.3).
# Everything it needs comes from resources defined elsewhere, so no name is typed twice.
module "launcher" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-launcher"
  source_dir         = "${local.lambda_build_dir}/launcher"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days
  # Must stay below the scan queue's visibility timeout (60 s), or messages are delivered twice.
  timeout = 30

  environment = {
    JOBS_TABLE        = aws_dynamodb_table.jobs.name
    CLUSTER_ARN       = aws_ecs_cluster.scanners.arn
    CONTAINER_NAME    = local.scanner_container_name
    SUBNET_IDS        = join(",", aws_subnet.private[*].id)
    SECURITY_GROUP_ID = aws_security_group.scanner.id
    TASK_DEFINITIONS_JSON = jsonencode({
      for type, task in local.scanner_tasks : type => {
        family   = aws_ecs_task_definition.scanner[type].family
        imageTag = regex(":([A-Za-z0-9_.-]+)$", task.image_uri)[0]
      }
    })
    # The real URL of each allow-listed target. Only the launcher and the scanner see it.
    TARGET_URLS_JSON = jsonencode({ "juice-shop" = var.juice_shop_url })
  }
}
