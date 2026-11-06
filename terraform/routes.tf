# Endpoints: one Lambda module + one route module each.
# Run `npm run build` first: it creates the folders under build/lambdas/.

module "login" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-login"
  source_dir         = "${local.lambda_build_dir}/login"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days
  # bcrypt is CPU-heavy and Lambda CPU grows with memory, so login gets more of both.
  memory_size = 512
  timeout     = 10

  environment = {
    USERS_TABLE            = aws_dynamodb_table.users.name
    JWT_SECRET_SSM_NAME    = var.jwt_secret_ssm_name
    TOKEN_LIFETIME_SECONDS = tostring(var.token_lifetime_seconds)
  }
}

# The only public route: no authorizer.
module "route_login" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "POST /login"
  function_name     = module.login.function_name
  invoke_arn        = module.login.invoke_arn
  authorizer_id     = null
}

# POST /scans: create a scan job. SAST also gets a pre-signed link to upload the zip.
module "create_scan" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-create-scan"
  source_dir         = "${local.lambda_build_dir}/create-scan"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    JOBS_TABLE     = aws_dynamodb_table.jobs.name
    UPLOADS_BUCKET = aws_s3_bucket.uploads.bucket
    TARGETS_JSON   = jsonencode(local.targets)
  }
}

module "route_create_scan" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "POST /scans"
  function_name     = module.create_scan.function_name
  invoke_arn        = module.create_scan.invoke_arn
  authorizer_id     = aws_apigatewayv2_authorizer.jwt.id
}

# GET /targets: the DAST allow-list (ids and names only, never the real URL).
module "targets" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-targets"
  source_dir         = "${local.lambda_build_dir}/targets"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    TARGETS_JSON = jsonencode(local.targets)
  }
}

module "route_targets" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "GET /targets"
  function_name     = module.targets.function_name
  invoke_arn        = module.targets.invoke_arn
  authorizer_id     = aws_apigatewayv2_authorizer.jwt.id
}

# POST /scans/{jobId}/start: check the zip, mark the job QUEUED and put it on the scan queue.
module "start_scan" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-start-scan"
  source_dir         = "${local.lambda_build_dir}/start-scan"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    JOBS_TABLE     = aws_dynamodb_table.jobs.name
    UPLOADS_BUCKET = aws_s3_bucket.uploads.bucket
    QUEUE_URL      = aws_sqs_queue.scan.url
  }
}

module "route_start_scan" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "POST /scans/{jobId}/start"
  function_name     = module.start_scan.function_name
  invoke_arn        = module.start_scan.invoke_arn
  authorizer_id     = aws_apigatewayv2_authorizer.jwt.id
}

# GET /scans/{jobId}: status of one scan. The browser polls it every 5 seconds, so it is a single key lookup.
module "get_scan" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-get-scan"
  source_dir         = "${local.lambda_build_dir}/get-scan"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    JOBS_TABLE = aws_dynamodb_table.jobs.name
  }
}

module "route_get_scan" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "GET /scans/{jobId}"
  function_name     = module.get_scan.function_name
  invoke_arn        = module.get_scan.invoke_arn
  authorizer_id     = aws_apigatewayv2_authorizer.jwt.id
}

# GET /projects/{projectId}/scans: scan history of one project, newest first, paged.
module "list_project_scans" {
  source = "./modules/lambda"

  function_name      = "${local.prefix}-list-project-scans"
  source_dir         = "${local.lambda_build_dir}/list-project-scans"
  role_arn           = var.lab_role_arn
  runtime            = local.lambda_runtime
  log_retention_days = var.log_retention_days

  environment = {
    JOBS_TABLE = aws_dynamodb_table.jobs.name
  }
}

module "route_list_project_scans" {
  source = "./modules/route"

  api_id            = aws_apigatewayv2_api.api.id
  api_execution_arn = aws_apigatewayv2_api.api.execution_arn
  route_key         = "GET /projects/{projectId}/scans"
  function_name     = module.list_project_scans.function_name
  invoke_arn        = module.list_project_scans.invoke_arn
  authorizer_id     = aws_apigatewayv2_authorizer.jwt.id
}
