output "route_key" {
  description = "Route key, exposed so the stage can attach per-route throttling after the route exists."
  value       = aws_apigatewayv2_route.this.route_key
}
