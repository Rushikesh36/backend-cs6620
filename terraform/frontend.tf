# The dashboard: a static website served straight from S3 (no server).
# scripts/create-buckets.sh creates the bucket (Learner Lab blocks the aws_s3_bucket resource);
# Terraform configures it and writes config.json. The site files are uploaded by
# scripts/deploy.sh in the frontend repo, which never touches config.json.

locals {
  # Placeholder until the API Gateway exists (Task 9). It must be a valid URL, or the site
  # shows its configuration error screen. Replace with the API's endpoint then.
  frontend_api_base_url = "https://api-not-deployed-yet.invalid"
}

# Fails with "not found" if scripts/create-buckets.sh has not been run in this lab yet.
data "aws_s3_bucket" "frontend" {
  bucket = var.frontend_bucket_name
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = data.aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  error_document {
    key = "404.html"
  }
}

# Learner Lab accounts block public bucket policies at the account level by default, and that
# setting overrides the bucket's own. Managing it here makes a fresh lab work without console
# clicks. It applies to the whole lab account; ACLs stay blocked, only policies are allowed.
resource "aws_s3_account_public_access_block" "this" {
  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket = data.aws_s3_bucket.frontend.id

  block_public_acls       = true
  ignore_public_acls      = true
  block_public_policy     = false
  restrict_public_buckets = false
}

# Anyone may read the site files (the S3 website endpoint has no other way to serve them).
resource "aws_s3_bucket_policy" "frontend_public_read" {
  bucket = data.aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadSiteFiles"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${data.aws_s3_bucket.frontend.arn}/*"
    }]
  })

  # S3 rejects a public policy while either block is still on.
  depends_on = [
    aws_s3_account_public_access_block.this,
    aws_s3_bucket_public_access_block.frontend,
  ]
}

# Each lab's settings for the site. no-cache so a new API address shows up on the next load.
resource "aws_s3_object" "frontend_config" {
  bucket        = data.aws_s3_bucket.frontend.id
  key           = "config.json"
  content_type  = "application/json"
  cache_control = "no-cache"

  content = jsonencode({
    apiBaseUrl  = local.frontend_api_base_url
    environment = var.environment
  })
}
