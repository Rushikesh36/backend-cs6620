#!/usr/bin/env bash
# Creates this lab's S3 buckets. Run once per lab, before `terraform apply`.
#
#   scripts/create-buckets.sh terraform/env/<name>.tfvars
#
# Why not Terraform: Learner Lab's service control policy denies s3:GetBucketObjectLockConfiguration,
# and the aws_s3_bucket resource reads it after every create and refresh (provider 5.x and 6.x), so
# Terraform cannot manage the bucket itself. Everything else on the bucket (CORS, lifecycle rules,
# policies, notifications) is still Terraform; it looks the bucket up by name with
# `data "aws_s3_bucket"`.
#
# Every `*_bucket_name` in the tfvars file is created, except `frontend_bucket_name`: the dashboard's
# bucket is set up by hand (see the frontend repo). Buckets that already exist are left alone.
# Needs the AWS CLI, logged in to the lab (copy the credentials from AWS Details first).
set -euo pipefail

fail() {
  printf 'Error: %s\n' "$1" >&2
  exit 1
}

[ $# -eq 1 ] || fail "Usage: scripts/create-buckets.sh terraform/env/<name>.tfvars"
TFVARS="$1"
[ -f "$TFVARS" ] || fail "No such file: $TFVARS"

# Reads `key = "value"` from the tfvars file.
tfvar() {
  sed -nE "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*\"([^\"]*)\".*/\1/p" "$TFVARS" | head -n 1
}

REGION="$(tfvar region)"
REGION="${REGION:-us-east-1}"
BUCKETS="$(grep -vE '^[[:space:]]*frontend_bucket_name[[:space:]]*=' "$TFVARS" |
  sed -nE 's/^[[:space:]]*[a-z_]+_bucket_name[[:space:]]*=[[:space:]]*"([^"]*)".*/\1/p')"
if [ -z "$BUCKETS" ]; then
  printf 'Nothing to create: no *_bucket_name values (other than frontend_bucket_name) in %s\n' "$TFVARS"
  exit 0
fi

aws sts get-caller-identity >/dev/null 2>&1 || fail "The AWS CLI is not logged in. Copy fresh credentials from Learner Lab."

for bucket in $BUCKETS; do
  # head-bucket: 0 = exists and is ours, 403 = someone else's name, 404 = free.
  if err="$(aws s3api head-bucket --bucket "$bucket" 2>&1)"; then
    printf 'Already exists: %s\n' "$bucket"
    continue
  fi
  case "$err" in
    *404* | *"Not Found"*) ;;
    *403* | *Forbidden*) fail "Bucket name $bucket is taken by another AWS account. Pick another name in $TFVARS." ;;
    *) fail "Could not check bucket $bucket: $err" ;;
  esac

  # us-east-1 is the default location and must not be passed as a LocationConstraint.
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" >/dev/null
  else
    aws s3api create-bucket --bucket "$bucket" --region "$REGION" \
      --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
  fi
  printf 'Created: %s\n' "$bucket"
done
