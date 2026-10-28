# The HTTP API, CORS, throttling and the authorizer.
# Endpoints are added as `module "route_..."` blocks in routes.tf.

resource "aws_apigatewayv2_api" "api" {
  name          = "${local.prefix}-api"
  protocol_type = "HTTP"

  # The browser sends an OPTIONS preflight because of the Authorization header.
  # API Gateway answers it itself. Exactly one origin, never "*", and no cookies/credentials.
  cors_configuration {
    allow_origins     = [var.allowed_origin]
    allow_methods     = ["GET", "POST", "OPTIONS"]
    allow_headers     = ["Authorization", "Content-Type"]
    allow_credentials = false
    max_age           = 600
  }
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  api_id                            = aws_apigatewayv2_api.api.id
  name                              = "${local.prefix}-jwt"
  authorizer_type                   = "REQUEST"
  authorizer_uri                    = module.authorizer.invoke_arn
  authorizer_payload_format_version = "2.0"
  enable_simple_responses           = true
  identity_sources                  = ["$request.header.Authorization"]
  # Cached per Authorization header, so a valid token is checked once a minute at most.
  authorizer_result_ttl_in_seconds = 60
}

resource "aws_lambda_permission" "authorizer" {
  statement_id  = "AllowApiGatewayAuthorizer"
  action        = "lambda:InvokeFunction"
  function_name = module.authorizer.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.api.execution_arn}/authorizers/${aws_apigatewayv2_authorizer.jwt.id}"
}

# $default stage: the URL has no stage name in it, which is what config.json expects.
resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.api.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_rate_limit  = var.throttle_rate_limit
    throttling_burst_limit = var.throttle_burst_limit
  }

  # Tighter limit for login. Applied after the route exists.
  route_settings {
    route_key              = module.route_login.route_key
    throttling_rate_limit  = var.login_rate_limit
    throttling_burst_limit = var.login_burst_limit
  }
}
