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
