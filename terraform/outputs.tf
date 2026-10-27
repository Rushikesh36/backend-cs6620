# Real outputs (api_base_url, bucket names, website URL) are added together with the
# resources they describe, starting in Task 9.

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
