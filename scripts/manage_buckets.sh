#!/usr/bin/env bash
# Creates or deletes the uploads and reports S3 buckets (Task 11) with the AWS CLI.
#
#   scripts/manage_buckets.sh create <name_prefix>   create both buckets (safe to run again)
#   scripts/manage_buckets.sh delete <name_prefix>   empty and delete both buckets
#
# <name_prefix> is your name_prefix from terraform/env/<yourname>.tfvars (for example rushikesh-sh).
# Why a script: in Learner Lab, Terraform's aws_s3_bucket resource fails after creating a bucket,
# because it reads s3:GetBucketObjectLockConfiguration and the lab denies it. So the buckets are
# made here, and Terraform (storage.tf) looks them up by name and manages their settings
# (public access block, encryption, lifecycle, CORS).
#
# Run `create` before the first `terraform apply`, and `delete` after `terraform destroy`.
# Names match storage.tf: <name_prefix>-uploads-<account id> and <name_prefix>-reports-<account id>.
set -euo pipefail

if [[ $# -ne 2 || ($1 != "create" && $1 != "delete") ]]; then
  echo "Usage: $0 <create|delete> <name_prefix>" >&2
  exit 1
fi
ACTION=$1
PREFIX=$2
if [[ ! ${PREFIX} =~ ^[a-z][a-z0-9-]{1,19}$ ]]; then
  echo "The prefix must be 2 to 20 characters: lowercase letters, digits and hyphens, like rushikesh-sh." >&2
  exit 1
fi

REGION=$(aws configure get region || true)
REGION=${REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKETS=("${PREFIX}-uploads-${ACCOUNT}" "${PREFIX}-reports-${ACCOUNT}")

exists() { aws s3api head-bucket --bucket "$1" >/dev/null 2>&1; }

for bucket in "${BUCKETS[@]}"; do
  if [[ ${ACTION} == "create" ]]; then
    if exists "${bucket}"; then
      echo "Already exists: ${bucket}"
      continue
    fi
    if [[ ${REGION} == "us-east-1" ]]; then
      aws s3api create-bucket --bucket "${bucket}" --region "${REGION}" >/dev/null
    else
      aws s3api create-bucket --bucket "${bucket}" --region "${REGION}" \
        --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
    fi
    echo "Created: ${bucket}"
  else
    if ! exists "${bucket}"; then
      echo "Not found, skipping: ${bucket}"
      continue
    fi
    # The buckets have no versioning, so removing the objects is enough to empty them.
    aws s3 rm "s3://${bucket}" --recursive --quiet
    aws s3api delete-bucket --bucket "${bucket}" --region "${REGION}"
    echo "Deleted: ${bucket}"
  fi
done
