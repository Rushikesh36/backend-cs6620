#!/usr/bin/env bash
# Builds the Semgrep (SAST) and ZAP (DAST) scanner images (Task 21), with the pinned versions in
# scanners/versions.env.
#
#   scripts/build_scanner_images.sh                 build for this computer, to test locally
#   scripts/build_scanner_images.sh --push <prefix> build for Fargate (linux/amd64) and push both
#                                                   images to ECR in your Learner Lab
#
# <prefix> is your name_prefix from terraform/env/<yourname>.tfvars (for example geetha-sh).
# Pushing uses your own lab credentials (LabRole can only read ECR). It creates the two ECR
# repositories if they are missing; tags are immutable, so a pushed tag never changes.
set -euo pipefail

cd "$(dirname "$0")/.."
set -a
# shellcheck source=../scanners/versions.env
source scanners/versions.env
set +a

SEMGREP_TAG="${SEMGREP_VERSION}-${IMAGE_REVISION}"
ZAP_TAG="${ZAP_VERSION}-${IMAGE_REVISION}"

build() { # build <scanner> <tag> [extra docker build args...]
  local name=$1 tag=$2
  shift 2
  docker build "$@" \
    --build-arg NODE_VERSION --build-arg SEMGREP_VERSION --build-arg ZAP_VERSION \
    --build-arg SEMGREP_RULE_PACKS \
    -f "scanners/${name}/Dockerfile" -t "${tag}" .
}

if [[ $# -eq 0 ]]; then
  build semgrep "security-hub-semgrep:${SEMGREP_TAG}"
  build zap "security-hub-zap:${ZAP_TAG}"
  echo "Built security-hub-semgrep:${SEMGREP_TAG} and security-hub-zap:${ZAP_TAG}"
  exit 0
fi

if [[ $# -ne 2 || $1 != "--push" ]]; then
  echo "Usage: $0 [--push <name_prefix>]" >&2
  exit 1
fi
PREFIX=$2
if [[ ! ${PREFIX} =~ ^[a-z][a-z0-9-]{1,30}$ ]]; then
  echo "The prefix must be lowercase letters, digits and hyphens, like geetha-sh." >&2
  exit 1
fi

REGION=$(aws configure get region || true)
REGION=${REGION:-us-east-1}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"

aws ecr get-login-password --region "${REGION}" |
  docker login --username AWS --password-stdin "${REGISTRY}"

PUSHED_URI=""
push() { # push <scanner> <tag>; sets PUSHED_URI
  local name=$1 tag=$2 repo="${PREFIX}-$1"
  if ! aws ecr describe-repositories --region "${REGION}" --repository-names "${repo}" >/dev/null 2>&1; then
    aws ecr create-repository --region "${REGION}" --repository-name "${repo}" \
      --image-tag-mutability IMMUTABLE >/dev/null
    echo "Created ECR repository ${repo}"
  fi
  local uri="${REGISTRY}/${repo}:${tag}"
  # Fargate runs linux/amd64 unless the task definition asks for ARM.
  build "${name}" "${uri}" --platform linux/amd64
  docker push "${uri}"
  PUSHED_URI=${uri}
}

push semgrep "${SEMGREP_TAG}"
SEMGREP_URI=${PUSHED_URI}
push zap "${ZAP_TAG}"
ZAP_URI=${PUSHED_URI}

echo
echo "Pushed. Put these in terraform/env/<yourname>.tfvars:"
echo "semgrep_image_uri = \"${SEMGREP_URI}\""
echo "zap_image_uri     = \"${ZAP_URI}\""
