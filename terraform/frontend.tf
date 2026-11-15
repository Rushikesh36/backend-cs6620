# The dashboard's S3 bucket: static website settings and the config.json the dashboard reads.
# The frontend team builds and uploads the site itself. Terraform only looks the bucket up by name
# (like storage.tf, it must already exist; Learner Lab cannot create buckets through Terraform)
# and manages the website settings, public read access and config.json.

data "aws_s3_bucket" "frontend" {
  bucket = var.frontend_bucket_name
}

resource "aws_s3_bucket_website_configuration" "frontend" {
  bucket = data.aws_s3_bucket.frontend.id

  index_document {
    suffix = "index.html"
  }

  # The frontend is a static export that builds its own not-found page as 404.html. Unknown paths
  # must show that page. Do not point this at index.html or add a rule that turns a 404 into a 200:
  # the frontend's tests and its not-found page expect a real "not found".
  error_document {
    key = "404.html"
  }
}

# A website endpoint is only reachable over HTTP and only for public objects, so this bucket is the
# one public bucket in the project. It holds the built site and config.json, nothing private.
resource "aws_s3_bucket_public_access_block" "frontend" {
  bucket                  = data.aws_s3_bucket.frontend.id
  block_public_acls       = false
  block_public_policy     = false
  ignore_public_acls      = false
  restrict_public_buckets = false
}

resource "aws_s3_bucket_policy" "frontend_public_read" {
  bucket = data.aws_s3_bucket.frontend.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "PublicReadForWebsite"
      Effect    = "Allow"
      Principal = "*"
      Action    = "s3:GetObject"
      Resource  = "${data.aws_s3_bucket.frontend.arn}/*"
    }]
  })

  # The policy is refused while the public access block still forbids public policies.
  depends_on = [aws_s3_bucket_public_access_block.frontend]
}

# Read by the dashboard at start-up, so one build of the site works against any lab's API.
# Only values that are already public go in: the API address and the lab name.
resource "aws_s3_object" "config" {
  bucket       = data.aws_s3_bucket.frontend.id
  key          = "config.json"
  content_type = "application/json"
  # Without this, browsers may show an old API address after a re-deploy.
  cache_control = "no-cache"

  content = jsonencode({
    apiBaseUrl  = aws_apigatewayv2_api.api.api_endpoint
    environment = var.environment
  })
}
