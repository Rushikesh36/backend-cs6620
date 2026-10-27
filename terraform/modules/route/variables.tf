variable "api_id" {
  type = string
}

variable "api_execution_arn" {
  type = string
}

variable "route_key" {
  description = "For example \"POST /login\" or \"GET /scans/{jobId}\"."
  type        = string
}

variable "function_name" {
  type = string
}

variable "invoke_arn" {
  type = string
}

variable "authorizer_id" {
  description = "Set for protected routes. null makes the route public (only /login)."
  type        = string
  default     = null
}
