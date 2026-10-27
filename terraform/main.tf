locals {
  # Every resource name starts with this, for example "rushikesh-sh".
  prefix = var.name_prefix

  lambda_runtime = "nodejs22.x"

  # `npm run build` writes one folder per Lambda here. Terraform zips them.
  lambda_build_dir = "${path.module}/../build/lambdas"
}
