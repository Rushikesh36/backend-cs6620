# All tables are pay-per-request: no idle cost, which suits a small Learner Lab budget.
# Key design and the query behind every endpoint: docs/data-model.md

resource "aws_dynamodb_table" "users" {
  name         = "${local.prefix}-users"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "username"

  attribute {
    name = "username"
    type = "S"
  }
}

resource "aws_dynamodb_table" "jobs" {
  name         = "${local.prefix}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "jobId"

  attribute {
    name = "jobId"
    type = "S"
  }
  attribute {
    name = "projectId"
    type = "S"
  }
  attribute {
    name = "createdAt"
    type = "S"
  }
  attribute {
    name = "status"
    type = "S"
  }
  attribute {
    name = "scope"
    type = "S"
  }

  # Scan history of one project, newest first (GET /projects/{id}/scans).
  global_secondary_index {
    name            = "byProject"
    hash_key        = "projectId"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  # Lets the reaper list QUEUED and RUNNING jobs without scanning the table.
  global_secondary_index {
    name            = "byStatus"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  # Recent scans across all projects (GET /scans). Every job has scope = "ALL".
  # One shared partition is fine at this scale (a few scans per day).
  global_secondary_index {
    name            = "byCreated"
    hash_key        = "scope"
    range_key       = "createdAt"
    projection_type = "ALL"
  }
}

resource "aws_dynamodb_table" "findings" {
  name         = "${local.prefix}-findings"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "fingerprint"

  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "fingerprint"
    type = "S"
  }
}
