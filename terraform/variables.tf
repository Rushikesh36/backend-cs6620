# Everything that differs between the three Learner Lab accounts is a variable.
# Values live in env/<name>.tfvars (copy env/example.tfvars.example).

variable "environment" {
  description = "Lab name shown in the frontend, for example rushikesh."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,20}$", var.environment))
    error_message = "environment must be 2 to 21 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "region" {
  description = "AWS region."
  type        = string
  default     = "us-east-1"
}

variable "name_prefix" {
  description = "Prefix for every resource name, so the three labs never clash. Keep it short."
  type        = string

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,19}$", var.name_prefix))
    error_message = "name_prefix must be 2 to 20 characters: lowercase letters, digits, hyphens, starting with a letter."
  }
}

variable "lab_role_arn" {
  description = "ARN of the existing LabRole. Learner Lab cannot create IAM roles, so every Lambda and task reuses this one."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]+$", var.lab_role_arn))
    error_message = "lab_role_arn must look like arn:aws:iam::123456789012:role/LabRole."
  }
}

variable "frontend_bucket_name" {
  description = "Name of the S3 bucket that hosts the static frontend (already built by the frontend team)."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.frontend_bucket_name))
    error_message = "frontend_bucket_name is not a valid S3 bucket name."
  }
}

variable "allowed_origin" {
  description = "Frontend website URL, used as the only allowed CORS origin. No trailing slash. Never '*'."
  type        = string

  validation {
    condition     = can(regex("^https?://[^/*]+$", var.allowed_origin))
    error_message = "allowed_origin must be like http://bucket.s3-website-us-east-1.amazonaws.com (no trailing slash, no wildcard)."
  }
}

variable "vpc_cidr" {
  description = "Address range of the dedicated VPC that Terraform creates for the scanners."
  type        = string
  default     = "10.20.0.0/16"

  validation {
    condition     = can(regex("^[0-9.]+/([0-9]|1[0-6])$", var.vpc_cidr)) && can(cidrhost(var.vpc_cidr, 0))
    error_message = "vpc_cidr must be a CIDR block of /16 or larger, like 10.20.0.0/16."
  }
}

variable "az_count" {
  description = "How many availability zones get a private subnet."
  type        = number
  default     = 2

  validation {
    condition     = var.az_count >= 1 && var.az_count <= 3
    error_message = "az_count must be 1, 2 or 3."
  }
}

variable "test_app_port" {
  description = "Port the DAST test app listens on. The scanner security group may reach only this port."
  type        = number
  default     = 3000

  validation {
    condition     = var.test_app_port >= 1 && var.test_app_port <= 65535
    error_message = "test_app_port must be between 1 and 65535."
  }
}

variable "semgrep_image_uri" {
  description = "ECR image URI (with a pinned tag, never :latest) for the Semgrep scanner."
  type        = string

  validation {
    condition     = !endswith(var.semgrep_image_uri, ":latest") && can(regex(":[A-Za-z0-9_.-]+$", var.semgrep_image_uri))
    error_message = "semgrep_image_uri must include a pinned tag and must not use :latest."
  }
}

variable "zap_image_uri" {
  description = "ECR image URI (with a pinned tag, never :latest) for the ZAP scanner."
  type        = string

  validation {
    condition     = !endswith(var.zap_image_uri, ":latest") && can(regex(":[A-Za-z0-9_.-]+$", var.zap_image_uri))
    error_message = "zap_image_uri must include a pinned tag and must not use :latest."
  }
}

variable "alert_email" {
  description = "Email address that receives alerts for new HIGH findings."
  type        = string

  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a valid email address."
  }
}

variable "extra_alert_emails" {
  description = "More addresses that receive the same alerts as alert_email, for example the rest of the team. Each must confirm its subscription."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.extra_alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "Every extra_alert_emails entry must be a valid email address."
  }
}

variable "token_lifetime_seconds" {
  description = "How long a login token lives. The API returns this as expiresIn."
  type        = number
  default     = 3600

  validation {
    condition     = var.token_lifetime_seconds >= 300 && var.token_lifetime_seconds <= 86400
    error_message = "token_lifetime_seconds must be between 300 and 86400."
  }
}

variable "juice_shop_url" {
  description = "Real URL of OWASP Juice Shop. Only the backend knows it; it is never sent to the browser."
  type        = string

  validation {
    condition     = can(regex("^https?://[^\\s]+$", var.juice_shop_url))
    error_message = "juice_shop_url must start with http:// or https://."
  }
}

variable "jwt_secret_ssm_name" {
  description = "Name of the SSM SecureString parameter holding the JWT signing secret. Created by a script, NOT by Terraform, so it never lands in state."
  type        = string
  default     = "/security-hub/jwt-secret"
}

variable "log_retention_days" {
  description = "How long CloudWatch logs are kept. Short, to save money."
  type        = number
  default     = 7

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30], var.log_retention_days)
    error_message = "log_retention_days must be one of 1, 3, 5, 7, 14, 30."
  }
}

variable "throttle_rate_limit" {
  description = "Steady requests per second allowed on the whole API."
  type        = number
  default     = 50
}

variable "throttle_burst_limit" {
  description = "Short burst allowed on the whole API."
  type        = number
  default     = 100
}

variable "login_rate_limit" {
  description = "Steady requests per second allowed on POST /login. Tight, to slow down password guessing."
  type        = number
  default     = 2
}

variable "login_burst_limit" {
  description = "Short burst allowed on POST /login."
  type        = number
  default     = 5
}

variable "launcher_max_concurrency" {
  description = "How many launcher invocations may run at once, so a burst of scans cannot start dozens of Fargate tasks. 2 to 1000."
  type        = number
  default     = 2

  validation {
    condition     = var.launcher_max_concurrency >= 2 && var.launcher_max_concurrency <= 1000
    error_message = "launcher_max_concurrency must be between 2 and 1000."
  }
}
