#!/usr/bin/env bash
# Smoke test for a deployed API (Task 26). Calls every endpoint of the contract (contract.md)
# and checks each response against the JSON Schemas in tests/contract/schemas/.
#
#   scripts/smoke.sh <api_base_url> <username> [options]
#
#   --project <id>   project to create the test scan in (default: smoke-test)
#   --dast           also create (not start) a DAST scan for the allow-listed target
#   --wait           after starting the SAST scan, poll it every 5 s (up to 15 minutes) until it
#                    is COMPLETED or FAILED, then check its findings. Needs the scanner running.
#
# The password is read from the SMOKE_PASSWORD environment variable, or asked for with a hidden
# prompt. It is never a command-line argument. The token and the pre-signed upload URL are never
# printed, and the token is passed to curl through a private temporary file, not the command line.
#
# It makes a real scan: a tiny empty zip is uploaded and started. Use your own lab.
# Needs: curl and node (with `npm ci` done). Exits 1 if any check fails.
set -uo pipefail

cd "$(dirname "$0")/.."

usage() {
  sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
  exit 2
}

[[ $# -ge 2 ]] || usage
API=${1%/}
USERNAME=$2
shift 2
PROJECT=smoke-test
DO_DAST=false
DO_WAIT=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --project)
      [[ $# -ge 2 ]] || usage
      PROJECT=$2
      shift 2
      ;;
    --dast) DO_DAST=true; shift ;;
    --wait) DO_WAIT=true; shift ;;
    *) usage ;;
  esac
done

if [[ ! ${API} =~ ^https?://[^[:space:]]+$ ]]; then
  echo "The API address must start with http:// or https:// (terraform output api_base_url)." >&2
  exit 2
fi
if [[ ! ${PROJECT} =~ ^[a-z][a-z0-9-]{2,49}$ ]]; then
  echo "The project must be 3 to 50 characters: lowercase letters, digits, hyphens, starting with a letter." >&2
  exit 2
fi
for tool in curl node; do
  command -v "${tool}" >/dev/null || { echo "Missing tool: ${tool}" >&2; exit 2; }
done
[[ -x node_modules/.bin/tsx ]] || { echo "Run npm ci first." >&2; exit 2; }

if [[ -z ${SMOKE_PASSWORD:-} ]]; then
  read -r -s -p "Password for ${USERNAME}: " SMOKE_PASSWORD
  echo
fi

TMP=$(mktemp -d)
chmod 700 "${TMP}"
trap 'rm -rf "${TMP}"' EXIT
BODY="${TMP}/body"
AUTH_HEADER="${TMP}/auth"

PASSED=0
FAILED=0
STATUS=""

pass() { PASSED=$((PASSED + 1)); echo "PASS  $1"; }
fail() { FAILED=$((FAILED + 1)); echo "FAIL  $1"; }

# json_get <file> <javascript expression using j> [arg]: prints a value from a JSON file. Nothing is
# printed for null or undefined. `a` in the expression is the optional third argument. The
# expressions are fixed text in this script, never input from the API.
json_get() {
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const a = process.argv[3];
    const v = eval(process.argv[2]);
    if (v !== undefined && v !== null) process.stdout.write(typeof v === "object" ? JSON.stringify(v) : String(v));' \
    "$1" "$2" "${3:-}"
}

# json_obj key=value ...: prints a JSON object of text values. A value like @NAME is read from the
# environment variable NAME, so a password never appears on a command line.
json_obj() {
  node -e 'const o = {}; for (const kv of process.argv.slice(1)) { const i = kv.indexOf("=");
    const v = kv.slice(i + 1); o[kv.slice(0, i)] = v.startsWith("@") ? process.env[v.slice(1)] ?? "" : v; }
    process.stdout.write(JSON.stringify(o));' "$@"
}

# request <method> <path> [json-body] [token-mode: default "auth" | "none"]
# Sets STATUS and writes the response body to ${BODY}. The request body goes through a private
# file, so nothing secret is on the command line.
request() {
  local method=$1 path=$2 data=${3:-} mode=${4:-auth}
  local args=(-sS -o "${BODY}" -w '%{http_code}' -X "${method}" "${API}${path}" -H 'Content-Type: application/json')
  [[ ${mode} == auth ]] && args+=(-H "@${AUTH_HEADER}")
  if [[ -n ${data} ]]; then
    printf '%s' "${data}" >"${TMP}/request.json"
    args+=(--data "@${TMP}/request.json")
  fi
  STATUS=$(curl "${args[@]}" 2>"${TMP}/curl-error") || STATUS="000 ($(head -c 200 "${TMP}/curl-error"))"
}

# expect <label> <status> [schema]: checks the last response.
expect() {
  local label=$1 want=$2 schema=${3:-}
  if [[ ${STATUS} != "${want}" ]]; then
    fail "${label}: expected HTTP ${want}, got ${STATUS}"
    return 1
  fi
  if [[ -n ${schema} ]]; then
    local out
    if ! out=$(node_modules/.bin/tsx scripts/check_response.ts "${schema}" <"${BODY}" 2>&1); then
      fail "${label}: ${out}"
      return 1
    fi
  fi
  pass "${label}"
}

# expect_error <label> <status> [exact message]: an { error } body, optionally with exact words.
expect_error() {
  local label=$1 want=$2 message=${3:-}
  expect "${label}" "${want}" error || return 1
  if [[ -n ${message} && $(json_get "${BODY}" 'j.error') != "${message}" ]]; then
    fail "${label}: message was '$(json_get "${BODY}" 'j.error')', expected '${message}'"
    return 1
  fi
  return 0
}

echo "Smoke test: ${API}  (project ${PROJECT})"
echo

# ---------- Login, and what a bad token gets ----------
request GET /targets "" none
if [[ ${STATUS} == 401 ]]; then pass "no token -> 401"; else fail "no token: expected 401, got ${STATUS}"; fi

# API Gateway turns a Lambda authorizer denial into 403 (only a missing header is a 401), so the
# dashboard logs the user out on 401 OR 403. A bad token must not get a 5xx, which would not.
printf 'Authorization: Bearer %s\n' 'aaaa.bbbb.cccc' >"${AUTH_HEADER}"
request GET /targets
if [[ ${STATUS} == 401 || ${STATUS} == 403 ]]; then
  pass "invalid token -> ${STATUS} (the dashboard logs out on 401 and 403)"
else
  fail "invalid token: expected 401 or 403, got ${STATUS}"
fi

request POST /login "$(json_obj "username=${USERNAME}" "password=definitely-not-the-password")" none
expect_error "login with a wrong password" 401

export SMOKE_PASSWORD
request POST /login "$(json_obj "username=${USERNAME}" "password=@SMOKE_PASSWORD")" none
if ! expect "login" 200 login-response; then
  echo
  echo "Cannot go on without a token. ${PASSED} passed, ${FAILED} failed."
  exit 1
fi
printf 'Authorization: Bearer %s\n' "$(json_get "${BODY}" 'j.token')" >"${AUTH_HEADER}"
chmod 600 "${AUTH_HEADER}"
unset SMOKE_PASSWORD

request GET /targets
expect "GET /targets" 200 targets-response
TARGET_ID=$(json_get "${BODY}" 'j.targets[0]?.targetId')

# ---------- A SAST scan, from creation to the first status ----------
request POST /scans "$(json_obj "projectId=${PROJECT}" scanType=SAST)"
if expect "POST /scans (SAST)" 200 create-scan-sast-response; then
  JOB_ID=$(json_get "${BODY}" 'j.jobId')
  UPLOAD_URL=$(json_get "${BODY}" 'j.upload.url')
  UPLOAD_TYPE=$(json_get "${BODY}" 'j.upload.headers["Content-Type"]')
else
  JOB_ID=""
fi

request POST /scans '{"projectId":"Bad ID!","scanType":"SAST"}'
expect_error "POST /scans with a bad project id" 400

if [[ -n ${JOB_ID} ]]; then
  request POST "/scans/${JOB_ID}/start"
  expect_error "start before the upload" 400

  # An empty zip (22 bytes, starts with "PK"). A pre-signed PUT takes no Authorization header.
  printf 'PK\005\006\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000\000' >"${TMP}/empty.zip"
  UPLOAD_STATUS=$(curl -sS -o /dev/null -w '%{http_code}' -X PUT -H "Content-Type: ${UPLOAD_TYPE}" \
    --data-binary "@${TMP}/empty.zip" "${UPLOAD_URL}" 2>/dev/null) || UPLOAD_STATUS=000
  if [[ ${UPLOAD_STATUS} == 200 ]]; then pass "PUT to the pre-signed URL"; else fail "PUT to the pre-signed URL: HTTP ${UPLOAD_STATUS}"; fi
  unset UPLOAD_URL

  request POST "/scans/${JOB_ID}/start"
  expect "POST /scans/{jobId}/start" 200 start-scan-response

  request POST "/scans/${JOB_ID}/start"
  expect_error "start twice" 409 "This scan was already started."

  request GET "/scans/${JOB_ID}"
  if expect "GET /scans/{jobId}" 200 scan-item; then
    if [[ $(json_get "${BODY}" 'j.jobId') == "${JOB_ID}" && $(json_get "${BODY}" 'j.projectId') == "${PROJECT}" ]]; then
      pass "GET /scans/{jobId} is the scan we created"
    else
      fail "GET /scans/{jobId} returned another scan"
    fi
  fi
fi

request GET "/scans/123e4567-e89b-42d3-a456-426614174999"
expect_error "GET an unknown scan" 404 "Scan not found."

# ---------- Lists ----------
request GET "/projects/${PROJECT}/scans"
if expect "GET /projects/{projectId}/scans" 200 scan-list-response && [[ -n ${JOB_ID} ]]; then
  if [[ $(json_get "${BODY}" 'j.items.some((i) => i.jobId === a)' "${JOB_ID}") == true ]]; then
    pass "the new scan is in its project's list"
  else
    fail "the new scan is missing from its project's list"
  fi
fi

request GET "/projects/${PROJECT}/scans?limit=1"
if expect "GET /projects/{projectId}/scans?limit=1" 200 scan-list-response; then
  if [[ $(json_get "${BODY}" 'j.items.length') -le 1 ]]; then pass "limit=1 returns at most one scan"; else fail "limit=1 returned more than one scan"; fi
fi
request GET "/projects/${PROJECT}/scans?limit=0"
expect_error "limit=0" 400
request GET "/projects/${PROJECT}/scans?cursor=not-a-real-cursor!"
expect_error "invalid cursor" 400
request GET "/projects/${PROJECT}/scans?limit=1&cursor=$(printf '{"jobId":"x"}' | base64 | tr '+/' '-_' | tr -d '=\n')"
expect_error "tampered cursor" 400

request GET "/projects/smoke-no-such-project/scans"
if expect "an unknown project's scans" 200 scan-list-response; then
  if [[ $(json_get "${BODY}" 'j.items.length') -eq 0 ]]; then pass "unknown project -> empty list, not 404"; else fail "unknown project returned scans"; fi
fi

request GET "/scans?limit=5"
expect "GET /scans" 200 scan-list-response

# ---------- Findings ----------
request GET "/projects/${PROJECT}/findings?scanType=SAST"
expect "GET /projects/{projectId}/findings?scanType=SAST" 200 findings-response
request GET "/projects/${PROJECT}/findings?scanType=DAST"
expect "GET /projects/{projectId}/findings?scanType=DAST" 200 findings-response
request GET "/projects/${PROJECT}/findings"
expect_error "findings without scanType" 400
request GET "/projects/${PROJECT}/findings?scanType=XSS"
expect_error "findings with a bad scanType" 400

# ---------- DAST (create only; it is not started) ----------
if ${DO_DAST}; then
  if [[ -z ${TARGET_ID} ]]; then
    fail "DAST: /targets returned no target"
  else
    request POST /scans "$(json_obj "projectId=${PROJECT}" scanType=DAST "targetId=${TARGET_ID}")"
    expect "POST /scans (DAST)" 200 create-scan-dast-response
  fi
  request POST /scans "$(json_obj "projectId=${PROJECT}" scanType=DAST "targetId=http://evil.example")"
  expect_error "DAST with a target that is not on the list" 400
fi

# ---------- Wait for the scanner ----------
if ${DO_WAIT} && [[ -n ${JOB_ID} ]]; then
  echo
  echo "Waiting for the scan to finish (polling every 5 seconds, up to 15 minutes)..."
  FINAL=""
  for _ in $(seq 1 180); do
    request GET "/scans/${JOB_ID}"
    [[ ${STATUS} == 200 ]] || { fail "polling: HTTP ${STATUS}"; break; }
    if ! out=$(node_modules/.bin/tsx scripts/check_response.ts scan-item <"${BODY}" 2>&1); then
      fail "polling: ${out}"
      break
    fi
    state=$(json_get "${BODY}" 'j.status')
    if [[ ${state} == COMPLETED || ${state} == FAILED ]]; then FINAL=${state}; break; fi
    sleep 5
  done
  if [[ -z ${FINAL} ]]; then
    fail "the scan did not finish in 15 minutes (last status ${state:-unknown})"
  else
    pass "the scan finished: ${FINAL} ($(json_get "${BODY}" 'j.error ?? "no error"'))"
    request GET "/projects/${PROJECT}/findings?scanType=SAST"
    expect "findings after the scan" 200 findings-response
  fi
fi

echo
echo "${PASSED} passed, ${FAILED} failed."
[[ ${FAILED} -eq 0 ]]
