terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    # Zips the bundled Lambda folders in build/lambdas/ (created by `npm run build`).
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Default: local state (git-ignored). State can contain secrets, so never commit it.
  # To share state instead, see backend.s3.tf.example.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "unified-security-hub"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
