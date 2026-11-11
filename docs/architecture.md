# Unified Security Hub: Agreed Architecture

Team 6 (CS6620). This is the single agreed design. All code, Terraform and docs must follow it. If something in the repo (TASKS.md, HANDOFF.md, tfvars examples, code) disagrees with this file, this file wins; flag the conflict instead of silently picking one.

---

## 1. What the system does

Users start security scans and review the results.

- **SAST:** user uploads a source zip; Semgrep scans it.
- **DAST:** user picks a test app from a server-side allow-list (by `targetId`, never a URL); ZAP attacks it.
- Every scan runs in a fresh, throwaway Fargate task.
- After each scan, findings are compared with the previous scan of the same project and scan type: **NEW / STILL OPEN / FIXED**.
- An email alert (SNS) is sent only when a scan has at least one **NEW HIGH** finding.

---

## 2. Components

| Area             | Components                                                                                                                                                                    |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients          | Static Next.js frontend on an S3 website; GitHub Actions (CI)                                                                                                                 |
| Front door       | API Gateway **HTTP API**, one CORS origin (the frontend), Lambda authorizer (payload 2.0, simple response, 60 s cache)                                                        |
| Auth             | Login Lambda (bcrypt, HS256 JWT, `exp` matches `expiresIn`); authorizer Lambda; JWT secret in **SSM Parameter Store** (SecureString), created by a script, never by Terraform |
| API Lambdas      | targets, create scan, start scan, get scan, list project scans, list recent scans, list findings                                                                              |
| Job pipeline     | **One** SQS scan queue shared by SAST and DAST, with a dead-letter queue; launcher Lambda (SQS trigger) calls `ecs:RunTask`                                                   |
| Scanning         | ECS on Fargate, two task definitions (Semgrep, ZAP), images in ECR with pinned tags                                                                                           |
| Network          | Dedicated VPC created by Terraform, private subnets only, VPC endpoints, no NAT, no internet gateway route                                                                    |
| Test app         | DAST test app runs as an ECS service inside the VPC, image mirrored into ECR, desired count **0** by default                                                                  |
| Results          | Results processor Lambda (single trigger, see 5.5); writes findings; updates job status; sends SNS alert                                                                      |
| Failure handling | EventBridge rule on ECS "Task State Change" STOPPED → processor; scheduled reaper Lambda for stuck jobs                                                                       |
| Storage          | S3: uploads bucket and reports bucket (private); DynamoDB: users, jobs, findings                                                                                              |
| Observability    | JSON logs with secrets redacted and `jobId` on every job-related line; CloudWatch alarms                                                                                      |
| Infrastructure   | Terraform, local state per person; every role is the pre-made **LabRole**                                                                                                     |

Lambdas run **outside** the VPC. Only the Fargate tasks and the test app run inside it.

---

## 3. Learner Lab constraints (hard rules)

- Region `us-east-1` (or `us-west-2`).
- No IAM roles can be created. Every Lambda, ECS task role and task execution role uses `var.lab_role_arn` (LabRole). Never add `aws_iam_role` resources.
- LabRole has **read-only** ECR access; images are pushed with the user's own lab credentials, from a laptop (not from GitHub Actions, whose credentials would expire).
- Max 10 concurrent Lambda execution environments per account. Do not use reserved concurrency; cap the SQS trigger with `maximum_concurrency` instead.
- Lab credentials expire every session. Exceeding the budget disables the account and deletes everything.
- Cognito and Step Functions are not used.

---

## 4. Network

- Terraform creates a **dedicated VPC** (CIDR and AZ count as variables). It does not take an existing `vpc_id` / `subnet_ids`.
- **Private subnets only** for scanners and the test app. Route tables have **no** internet route. No NAT gateway. No public IPs (`assignPublicIp = DISABLED`).
- **VPC endpoints:**
  - S3 **gateway** endpoint (free)
  - Interface endpoints: `ecr.api`, `ecr.dkr`, `logs`
  - Interface endpoints live in **one AZ** to keep cost down.
- **Security groups:**
  - Scanner SG: no inbound rules; egress only to the test app SG, the endpoint SG and the S3 prefix list.
  - Test app SG: inbound only from the scanner SG, on the app port.
  - Endpoint SG: inbound 443 from the scanner SG and the test app SG.
- Must be verified early: Learner Lab allows creating these VPC endpoints, and their current hourly price.

---

## 5. Flows

### 5.1 Sign in

1. Client calls `POST /login` with username and password.
2. Login Lambda checks the bcrypt hash (one compare on every path, dummy hash for unknown users). Wrong user, wrong password and disabled user all return the identical 401.
3. Returns a JWT (HS256, signed with the SSM secret, cached 5 min per container).
4. Every other route goes through the Lambda authorizer. Forged, expired or `alg: none` tokens are denied.

### 5.2 Create and start a scan

1. `POST /scans` creates a job (`CREATED`).
   - SAST: returns a pre-signed S3 PUT URL (900 s) for `uploads/`.
   - DAST: request carries a `targetId` from the allow-list.
2. Client uploads the zip directly to S3 (SAST).
3. `POST /scans/{jobId}/start` checks the zip (size and magic bytes for SAST), moves the job `CREATED → QUEUED` atomically, and sends an SQS message containing only `jobId` and `scanType`. A second start returns 409.

### 5.3 Launch

1. SQS triggers the launcher Lambda.
2. Launcher moves the job `QUEUED → RUNNING` with a conditional write. If that returns false (duplicate delivery), it discards the message.
3. Launcher calls `ecs:RunTask` with `startedBy = jobId`, private subnets, scanner SG, public IP disabled, and container overrides (job ID, scan type, S3 location or target, report bucket, image tag).
4. If RunTask fails, the job becomes `FAILED` ("Could not start scanner task").

### 5.4 Scan

- The container is **stateless**: downloads its input from S3, runs the scanner, writes the raw and normalised reports to the reports bucket, exits. Nothing is kept inside the container.
- Hard timeout inside the wrapper script (and a stop timeout on the task).
- Runs **offline**: Semgrep uses rules baked into the image with metrics off; ZAP must not download updates or add-ons at start-up.
- Image tags are pinned versions. Terraform rejects `latest`. The image tag is saved on the job record.

### 5.5 Process results (single trigger)

- The processor's **only** trigger is the EventBridge rule for ECS "Task State Change" with `lastStatus = STOPPED` on our cluster.
- Processor reads `jobId` from `startedBy`, then:
  - non-zero exit code or no exit code → `FAILED` "Scanner exited with code N" / stop reason
  - exit 0 and no report in S3 → `FAILED` "No report produced"
  - exit 0 and report present → parse, fingerprint, diff, write findings, update summary, `COMPLETED`
- Sends an SNS email if `newHigh >= 1`.
- Safe against duplicate events: status changes go through `transitionJob`, which refuses a second change.

### 5.6 Stuck jobs (reaper)

- Scheduled Lambda (EventBridge schedule) queries the `byStatus` index for jobs stuck in `QUEUED` or `RUNNING` beyond the limit (25 minutes for running), stops the ECS task if one exists, and marks the job `FAILED` "Timed out after 25 minutes".

---

## 6. Job status rules

`CREATED → QUEUED → RUNNING → COMPLETED | FAILED`

- All transitions live in one table in code (`ALLOWED_FROM`) and are applied with conditional writes via `transitionJob`.
- `QUEUED` may jump straight to `COMPLETED` or `FAILED`, because the task-stopped event can arrive before the `RUNNING` update.
- `COMPLETED` and `FAILED` are final. Nothing may change them.

---

## 7. Data model (DynamoDB, PAY_PER_REQUEST, no PITR)

**users**

- PK `username`
- `passwordHash`, `role` (`user` | `ci`), `disabled`, timestamps

**jobs**

- PK `jobId`
- `projectId`, `scanType`, `targetId`, `status`, `requestedBy`, `imageTag`, `createdAt`, `queuedAt`, `startedAt`, `finishedAt`, `summary` (`new`, `newHigh`, `stillOpen`, `fixed`), `error`
- GSI `byProject`: `projectId` + `createdAt` (scan history)
- GSI `byStatus`: `status` + `createdAt` (reaper)
- GSI `byCreated`: `scope = "ALL"` + `createdAt` (recent scans list)

**findings**

- PK `projectId#scanType`, SK `fingerprint`
- `ruleId`, `severity` (`HIGH` | `MEDIUM` | `LOW` | `INFO`), `location`, `message`, `state` (`OPEN` | `FIXED`), `firstSeenJobId`, `lastSeenJobId`

**Fingerprint** (sha256, stable when line numbers move):

- SAST: `projectId | SAST | ruleId | file path | normalised code snippet`
- DAST: `projectId | DAST | ruleId | HTTP method | URL path without query values | parameter name`

**Diff:** not in table → NEW (`OPEN`); already `OPEN` → STILL OPEN; `OPEN` but missing from this scan → `FIXED`; a `FIXED` finding that returns counts as NEW.

**Writers (one owner per table):**

- users: only the add-user script and the login path
- findings: only the results processor (API only reads)
- jobs: created by the API; status changed only through `transitionJob` by start-scan, launcher, processor and reaper

---

## 8. API

| Method | Path                             | Notes                                                    |
| ------ | -------------------------------- | -------------------------------------------------------- |
| POST   | `/login`                         | No auth. Tighter throttle than other routes              |
| GET    | `/targets`                       | Allow-list; never returns the real target URL            |
| POST   | `/scans`                         | Creates job; SAST returns pre-signed upload URL          |
| POST   | `/scans/{jobId}/start`           | Zip checks, CREATED → QUEUED, 409 on repeat              |
| GET    | `/scans/{jobId}`                 | Status, summary, error                                   |
| GET    | `/projects/{projectId}/scans`    | Paged (tamper-proof cursor), empty list for new projects |
| GET    | `/scans`                         | Recent scans via `byCreated`                             |
| GET    | `/projects/{projectId}/findings` | Filter by `scanType`                                     |

Errors use one JSON shape. CORS is set on API Gateway, not in Lambdas.

---

## 9. Storage (S3)

- Uploads bucket (private): `uploads/{jobId}.zip`, short lifecycle.
- Reports bucket (private): raw and normalised reports per `jobId`.
- Frontend bucket: S3 website; Terraform writes `config.json` with `apiBaseUrl` and `environment`.
- Bucket names include the account ID. Learner Lab blocks Terraform's `aws_s3_bucket` resource, so `scripts/manage_buckets.sh` creates and deletes the uploads and reports buckets; Terraform looks them up by name and manages their settings.

---

## 10. Observability

- Logs are JSON; keys matching pass/token/secret/authorization/cookie/hash/signature/credential are redacted.
- Every job-related log line carries `jobId` (Lambdas and the scanner wrapper), so one CloudWatch Logs Insights query follows a scan end to end.
- Alarms (to an SNS topic): SQS oldest-message age, DLQ depth > 0, failed ECS tasks.

---

## 11. Terraform and secrets

- State is local per person and git-ignored. An optional S3 backend example exists.
- The JWT secret is created in SSM by `scripts/create_jwt_secret.ts`, never by Terraform, so it never lands in state.
- Variables are validated (no `latest` image tag, no wildcard CORS origin, valid role ARN).
- Each teammate deploys the same code to their own Learner Lab with their own `env/*.tfvars`.

---

## 12. Ownership

| Owner       | Area                                                                                                                                                                                                  |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rushikesh   | Repo setup and shared code, login, authorizer, DynamoDB tables, API Gateway, **dedicated VPC and endpoints**, `jobId` logging convention, JWT secret script, the frontend                             |
| Shreya      | Scan API: targets, S3 buckets, SQS + DLQ, create / start / get / list scans                                                                                                                           |
| Geethanjali | Findings model, fingerprint and diff, report parsers, list-findings, processor, launcher, scanner images, ECS + EventBridge, test app in VPC, reaper, SNS alerts, alarms, contract tests, docs and CI |

---

## 13. Still to verify (do not assume)

- Learner Lab allows creating the S3 gateway endpoint and the `ecr.api`, `ecr.dkr` and `logs` interface endpoints.
- Current hourly price of interface endpoints.
- LabRole permits `iam:PassRole` for ECS RunTask from Lambda.
- Scanners run fully offline inside the private subnets.
