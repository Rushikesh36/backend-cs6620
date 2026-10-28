# One API route wired to one Lambda, plus the permission that lets API Gateway call it.

resource "aws_apigatewayv2_integration" "this" {
  api_id                 = var.api_id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "this" {
  api_id             = var.api_id
  route_key          = var.route_key
  target             = "integrations/${aws_apigatewayv2_integration.this.id}"
  authorization_type = var.authorizer_id == null ? "NONE" : "CUSTOM"
  authorizer_id      = var.authorizer_id
}

resource "aws_lambda_permission" "invoke" {
  statement_id  = "AllowApiGateway-${replace(var.route_key, "/[^A-Za-z0-9]/", "-")}"
  action        = "lambda:InvokeFunction"
  function_name = var.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${var.api_execution_arn}/*/*"
}
