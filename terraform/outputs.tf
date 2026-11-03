# More outputs (bucket names, website URL) are added together with their resources.

output "resource_prefix" {
  description = "Prefix used in the names of all resources in this environment."
  value       = local.prefix
}

output "environment" {
  description = "Lab name for this deployment."
  value       = var.environment
}

output "table_names" {
  description = "DynamoDB table names."
  value = {
    users    = aws_dynamodb_table.users.name
    jobs     = aws_dynamodb_table.jobs.name
    findings = aws_dynamodb_table.findings.name
  }
}

output "api_base_url" {
  description = "Base URL of the API. Goes into the frontend's config.json as apiBaseUrl."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "api_id" {
  value = aws_apigatewayv2_api.api.id
}

output "uploads_bucket" {
  description = "Bucket for SAST zip uploads. Lambdas read it as UPLOADS_BUCKET."
  value       = aws_s3_bucket.uploads.bucket
}

output "reports_bucket" {
  description = "Bucket for scanner reports. Lambdas read it as REPORTS_BUCKET."
  value       = aws_s3_bucket.reports.bucket
}

output "scan_queue_url" {
  description = "SQS queue for scans waiting to start. Lambdas read it as QUEUE_URL."
  value       = aws_sqs_queue.scan.url
}

output "scan_queue_arn" {
  value = aws_sqs_queue.scan.arn
}

output "scan_dlq_url" {
  description = "Dead-letter queue for scan messages that failed 3 times."
  value       = aws_sqs_queue.scan_dlq.url
}

output "network" {
  description = "The dedicated VPC. Used by the ECS task definitions and the launcher (Tasks 20 and 22)."
  value = {
    vpc_id                  = aws_vpc.main.id
    private_subnet_ids      = aws_subnet.private[*].id
    scanner_security_group  = aws_security_group.scanner.id
    test_app_security_group = aws_security_group.test_app.id
    endpoint_security_group = aws_security_group.endpoints.id
    test_app_port           = var.test_app_port
  }
}
