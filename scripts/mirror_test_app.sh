#!/usr/bin/env bash
# Copies the DAST test app, OWASP Juice Shop, into ECR in your Learner Lab (Task 31). The test
# app runs in the private subnets, which have no internet route, so it cannot pull from Docker Hub.
#
#   scripts/mirror_test_app.sh <prefix>
#
# <prefix> is your name_prefix from terraform/env/<yourname>.tfvars (for example geetha-sh).
# The version is JUICE_SHOP_VERSION in scanners/versions.env. Uses your own lab credentials
# (LabRole can only read ECR). Creates the ECR repository <prefix>-juice-shop if it is missing;
# tags are immutable, so a version that is already there is left alone.
set -euo pipefail

cd "$(dirname "$0")/.."
# shellcheck source=../scanners/versions.env
source scanners/versions.env

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <name_prefix>" >&2
  exit 1
fi
PREFIX=$1
if [[ ! ${PREFIX} =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "The prefix must be lowercase letters, digits and hyphens, like geetha-sh." >&2
  exit 1
fi

REGION=$(aws configure get region || true)
REGION=${REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
REPO="${PREFIX}-juice-shop"
TAG="${JUICE_SHOP_VERSION}"
SOURCE="bkimminich/juice-shop:v${JUICE_SHOP_VERSION}"
URI="${REGISTRY}/${REPO}:${TAG}"

if ! aws ecr describe-repositories --region "${REGION}" --repository-names "${REPO}" >/dev/null 2>&1; then
  aws ecr create-repository --region "${REGION}" --repository-name "${REPO}" \
    --image-tag-mutability IMMUTABLE >/dev/null
  echo "Created ECR repository ${REPO}"
fi

if aws ecr describe-images --region "${REGION}" --repository-name "${REPO}" \
  --image-ids "imageTag=${TAG}" >/dev/null 2>&1; then
  echo "${REPO}:${TAG} is already in ECR."
else
  aws ecr get-login-password --region "${REGION}" |
    docker login --username AWS --password-stdin "${REGISTRY}"
  # Fargate runs linux/amd64 unless the task definition asks for ARM.
  docker pull --platform linux/amd64 "${SOURCE}"
  docker tag "${SOURCE}" "${URI}"
  docker push "${URI}"
fi

echo
echo "Put this in terraform/env/<yourname>.tfvars:"
echo "test_app_image_uri = \"${URI}\""
