# TASKS: Unified Security Hub backend

Progress: 8 / 27

`[████████░░░░░░░░░░░░░░░░░░░░] 30%`

Statuses: Not started / In progress / In review / Changes requested / Approved / Blocked

| #   | Task                                                                                                                      | Status      | Depends on |
| --- | ------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| 1   | Repo setup and tooling (.gitignore first, package.json, tsc strict, ESLint, Prettier, Vitest, aws-sdk-client-mock)        | Approved    | none       |
| 2   | Shared code `common/` (JSON responses, error helper, validation incl. projectId rule, structured logging)                 | Approved    | 1          |
| 3   | Shared code: JWT helpers (HS256, `exp`/`iat`) and DynamoDB helpers (conditional status transitions, cursor encode/decode) | Approved    | 2          |
| 4   | Terraform skeleton: providers, variables, outputs, `env/*.tfvars.example`, Lambda packaging script                        | Approved    | 1          |
| 5   | Terraform: DynamoDB tables (users, jobs + GSI, findings)                                                                  | Approved    | 4          |
| 6   | `scripts/add_user.ts` (hidden prompt, bcryptjs, `--update` flag) + tests                                                  | Approved    | 3, 5       |
| 7   | Login Lambda + tests (generic 401, dummy-hash timing, 400s, `exp` agrees with `expiresIn`)                                | Approved    | 3, 6       |
| 8   | Authorizer Lambda + tests (expired, forged, wrong role, missing token)                                                    | Approved    | 3          |
| 9   | Terraform: API Gateway HTTP API, CORS, throttling, authorizer, login route, first Lambdas wired                           | In review   | 4, 7, 8    |
| 10  | Targets Lambda + allow-list config + tests                                                                                | Not started | 9          |
| 11  | Terraform: S3 (uploads + reports buckets, lifecycle, CORS), SQS + DLQ                                                     | Not started | 4          |
| 12  | create-scan Lambda (pre-signed PUT, 900 s) + tests                                                                        | Not started | 9, 11      |
| 13  | start-scan Lambda (zip size and magic-byte check, 409, queueing) + tests                                                  | Not started | 12         |
| 14  | get-scan Lambda + tests                                                                                                   | Not started | 9          |
| 15  | list-project-scans Lambda (cursor, limit, empty list) + tests                                                             | Not started | 14         |
| 16  | Findings model + fingerprint + diff engine (pure code) + docs/fingerprints.md, heavy tests                                | In review   | 3          |
| 17  | Report parsers (Semgrep and ZAP to common shape, severity mapping docs) + sample reports + tests                          | Not started | 16         |
| 18  | list-findings Lambda + tests                                                                                              | Not started | 16, 9      |
| 19  | Processor Lambda (read report, diff, store, final-state rules, FAILED messages) + tests                                   | Not started | 13, 17, 18 |
| 20  | Launcher Lambda (SQS to ecs:RunTask, concurrency cap, "Could not start scanner task") + tests                             | Not started | 11, 13     |
| 21  | Scanner images (semgrep and zap Dockerfiles + wrapper scripts, zip-bomb limits, pinned tags)                              | Not started | 17         |
| 22  | Terraform: ECS cluster, task definitions, network/security groups, EventBridge task-state rule                            | Not started | 19, 20, 21 |
| 23  | Reaper Lambda (stuck jobs, stops tasks) + schedule + tests                                                                | Not started | 22         |
| 24  | Alerts (SNS email when newHigh >= 1) + tests                                                                              | Not started | 19         |
| 25  | Frontend bucket website settings + `config.json` object from Terraform                                                    | Not started | 9          |
| 26  | Contract tests (JSON Schemas for every response) + `scripts/smoke.sh`                                                     | Not started | 18, 15     |
| 27  | Docs (contract, architecture, runbook), README, GitHub Actions CI (lint, test, terraform fmt/validate)                    | Not started | all        |

## Decisions log

- Language: Node 22 + TypeScript (strict). Chosen by you. Matches the Lambda `nodejs22.x` runtime.
- Tooling: ESLint (no-console, security plugin), Prettier, tsc strict, Vitest, aws-sdk-client-mock (replaces moto, which is Python-only), esbuild to bundle each Lambda.
- Passwords: `bcryptjs` (pure JS) planned, so no native-binary packaging problem for Lambda.
- No Cognito (you said so). Own login with JWT.
- Accepted defaults ("rest all yes"): SNS email alerts, 3600 s tokens, 409 when a scan is started twice, a FIXED finding that returns counts as NEW, JWT secret in SSM created outside Terraform, GET /scans (3.8) will be built.
- Task 1 approved implicitly when you said you'd give details later.
- Logger redacts any key matching pass/token/secret/authorization/cookie/hash/signature/credential. CORS headers are left to API Gateway, so Lambdas only set Content-Type.
- JWT: hand-rolled HS256 on node:crypto (no library); header must be exactly HS256; all verify failures give the same 401.
- Job status rules live in one table (ALLOWED_FROM). QUEUED may jump straight to COMPLETED/FAILED because the task-stopped event can beat the RUNNING update.
- Cursors only accept the exact expected string keys, so tampering gives 400.
- Packaging: `npm run build` bundles each lambdas/<name>/handler.ts with esbuild into build/lambdas/<name>/index.mjs; Terraform zips them with archive_file. AWS SDK v3 is left external (provided by nodejs22.x runtime).
- JWT secret SSM name is a variable (default /security-hub/jwt-secret); the parameter is created by a script, never by Terraform.
- Terraform outputs api_base_url, bucket names and website URL are added with their resources (from Task 9), not as empty placeholders.
- Jobs table has 3 GSIs: byProject (history), byStatus (reaper), byCreated (GET /scans, constant partition key scope="ALL"). All project ALL attributes; items are small.
- Tables are PAY_PER_REQUEST, no point-in-time recovery (cost), so teardown is clean.
- bcrypt cost 10 (bcryptjs), shared constant in common/passwords.ts; login must use the same cost for its dummy hash. New passwords: 12 to 72 bytes (bcrypt ignores bytes past 72). Login (Task 7) must also reject passwords over 72 bytes with 400.
- add_user is TypeScript run with tsx (`npm run add-user`); password only via hidden prompt or --password-stdin, never argv; `--update` does not touch the `disabled` flag.
- Login: one bcrypt compare on every path (dummy hash for unknown users); wrong user, wrong password and disabled user give the identical 401 "Incorrect username or password."; username max 64 chars, password max 72 bytes (400 beyond that). Failure reason goes to logs only.
- JWT secret is read from SSM (WithDecryption) and cached 5 minutes per Lambda container; shared helper common/secret.ts (reused by the authorizer).
- Tests silence the logger with LOG_LEVEL=silent; tests that check log output switch it back on.
- Authorizer: HTTP API Lambda authorizer, payload 2.0, simple response. Bad token = deny (401); failure reading the secret = thrown error (5xx, retryable, no logout). Result cache (60 s) is set in Terraform in Task 9. Handlers read the caller with common/auth.ts (getCaller, requireRole).
- Terraform structure: modules/lambda (zip + log group + function) and modules/route (integration + route + invoke permission). Each endpoint adds one lambda module and one route module in routes.tf, so teammates rarely touch the same lines.
- API: $default stage (URL has no stage name), CORS = one origin, GET/POST/OPTIONS, Authorization + Content-Type, no credentials, max-age 600. Throttle 50/s burst 100 overall, 2/s burst 5 on POST /login (limits are per route, not per user). No access logs (API Gateway log delivery may be blocked in Learner Lab).
- Login Lambda gets 512 MB (bcrypt is CPU heavy); authorizer 256 MB.
- Known: `npm audit` shows 6 dev-only advisories (vitest/vite/esbuild dev servers); 0 in runtime deps. Upgrading vitest hit a peer-dependency conflict; revisit later.
- Learner Lab's service control policy denies `s3:GetBucketObjectLockConfiguration`, which `aws_s3_bucket` reads on every create and refresh (provider 5.100 and 6.70 both fail). Buckets are created by `scripts/create-buckets.sh` (every `*_bucket_name` in the tfvars except `frontend_bucket_name`) and looked up in Terraform with `data "aws_s3_bucket"`; CORS, lifecycle, policies and objects stay Terraform resources. Tested in one lab (script, then website settings, policy, public access block and an object through Terraform; a second plan showed no changes). Applies to Task 11's buckets.
- Team decision (Geethanjali): the dashboard is hosted by hand in its own S3 bucket, outside this repo's Terraform, so Task 25 is not done here. Its row is left for Rushikesh to update or remove. `frontend_bucket_name` and `allowed_origin` stay, because CORS on the API and upload bucket needs the dashboard's address.
- README added with lab setup, the shared vs personal files, and the Learner Lab restrictions. Task 27 still owns the full docs.
- Task 16 (Geethanjali): pure code in `common/findings/` (`fingerprint.ts`, `diff.ts`), reasoning in `docs/fingerprints.md`. Two changes from the handoff proposal: the parts are hashed as a JSON array instead of a `|` join (scanner text can contain `|`), and SAST code drops all whitespace instead of collapsing it (a formatter turning `f(a,b)` into `f(a, b)` must not create a new finding). DAST ignores the host so each lab's Juice Shop address gives the same fingerprint. A fingerprint reported twice in one scan counts once. Task 19 must check the job is not final before diffing, because a second diff of the same job gives a different summary.

## Open questions

0. **Needs your decision (Task 9):** an API Gateway HTTP API answers an authorizer denial (and a missing Authorization header) with its own body `{"message":"Unauthorized"}`, not `{"error":"..."}`. HTTP APIs cannot change this. The status is still 401. Does the frontend only look at the status code for 401, or also at the body? If it needs `{error}`, the alternative is to check the token inside every Lambda instead of using a gateway authorizer.

1. LabRole ARN, VPC ID and subnet IDs for each of the three accounts? (needed by Task 4)
2. Where does Juice Shop run and what is its URL? (needed by Task 22)
3. Is ECR available and can we push images? (needed by Task 21)
4. Who are the first users, and what roles? (needed by Task 6)
