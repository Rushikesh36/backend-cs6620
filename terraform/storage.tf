# S3 buckets for scan uploads (SAST zips) and scanner reports.
# Both are private. Names include the account ID because S3 names are global.

data "aws_caller_identity" "current" {}

locals {
  uploads_bucket_name = "${local.prefix}-uploads-${data.aws_caller_identity.current.account_id}"
  reports_bucket_name = "${local.prefix}-reports-${data.aws_caller_identity.current.account_id}"
}

# ---------- Uploads: the browser PUTs uploads/<jobId>.zip here with a pre-signed URL ----------

resource "aws_s3_bucket" "uploads" {
  bucket = local.uploads_bucket_name
  # Lets `terraform destroy` empty the bucket, so teardown is clean.
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket                  = aws_s3_bucket.uploads.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Uploaded code is only needed until the scan has run, so it is deleted after 1 day.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "expire-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    expiration {
      days = 1
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

# The browser uploads straight to S3, so S3 needs its own CORS rule.
# Only PUT, only from the frontend origin.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_origins = [var.allowed_origin]
    allowed_methods = ["PUT"]
    allowed_headers = ["Content-Type"]
    expose_headers  = ["ETag"]
    max_age_seconds = 600
  }
}

# ---------- Reports: the scanner writes reports/<jobId>.json here ----------

resource "aws_s3_bucket" "reports" {
  bucket        = local.reports_bucket_name
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "reports" {
  bucket                  = aws_s3_bucket.reports.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Findings are stored in DynamoDB after processing, so raw reports are kept only briefly.
resource "aws_s3_bucket_lifecycle_configuration" "reports" {
  bucket = aws_s3_bucket.reports.id

  rule {
    id     = "expire-reports"
    status = "Enabled"

    filter {
      prefix = "reports/"
    }

    expiration {
      days = 14
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}
