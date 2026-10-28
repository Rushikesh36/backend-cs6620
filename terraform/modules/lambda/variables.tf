variable "function_name" {
  description = "Full Lambda name, already including the environment prefix."
  type        = string
}

variable "source_dir" {
  description = "Folder with the bundled code (build/lambdas/<name>, made by npm run build). Must contain index.mjs."
  type        = string
}

variable "role_arn" {
  description = "Execution role. In Learner Lab this is the existing LabRole."
  type        = string
}

variable "runtime" {
  type    = string
  default = "nodejs22.x"
}

variable "handler" {
  type    = string
  default = "index.handler"
}

variable "memory_size" {
  type    = number
  default = 256
}

variable "timeout" {
  description = "Seconds."
  type        = number
  default     = 10
}

variable "environment" {
  description = "Environment variables for the function. Never put secrets here (they show up in the console)."
  type        = map(string)
  default     = {}
}

variable "log_retention_days" {
  type = number
}
