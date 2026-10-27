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
