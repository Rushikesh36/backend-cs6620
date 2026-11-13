# Unified Security Hub: backend and infrastructure

Backend and AWS infrastructure for Unified Security Hub (CS6620 Cloud Computing, Northeastern University, Team 6). It holds the Lambda code, the shared helpers they use, and the Terraform that builds everything in an AWS Learner Lab. The dashboard's code lives in the separate frontend repo (`cs6620-frontend`) and is hosted separately.

Progress, owners and decisions are tracked in [TASKS.md](TASKS.md) (each task has an Owner column). Design notes are in [docs/](docs/): the tables in [data-model.md](docs/data-model.md), finding fingerprints and the scan diff in [fingerprints.md](docs/fingerprints.md), the scanner report parsers in [report-parsers.md](docs/report-parsers.md), and the scanner images in [scanners.md](docs/scanners.md).

## Contents

- [What is built so far](#what-is-built-so-far)
- [Repo layout](#repo-layout)
- [What you need](#what-you-need)
- [Connect to your Learner Lab](#connect-to-your-learner-lab)
- [Set up your lab (first time)](#set-up-your-lab-first-time)
- [Day to day](#day-to-day)
- [How the three labs share one setup](#how-the-three-labs-share-one-setup)
- [Learner Lab restrictions](#learner-lab-restrictions)
- [Development commands](#development-commands)
- [Tearing down](#tearing-down)
- [Troubleshooting](#troubleshooting)

## What is built so far

| Piece                                                                                                                                                        | Where                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| DynamoDB tables: users, jobs (3 indexes), findings                                                                                                           | `terraform/dynamodb.tf`                                                 |
| API Gateway HTTP API: CORS, throttling, JWT authorizer                                                                                                       | `terraform/api.tf`                                                      |
| Routes `POST /login`, `GET /targets`, `POST /scans`                                                                                                          | `terraform/routes.tf`                                                   |
| Lambdas: login, authorizer, targets (DAST allow-list), create-scan (job + pre-signed upload link)                                                            | `lambdas/`, `terraform/lambdas.tf`, `terraform/targets.tf`              |
| S3 buckets: uploads (`uploads/<jobId>.zip`, kept 1 day, browser PUT via CORS) and reports (`reports/<jobId>.json`, kept 14 days); both private and encrypted | `terraform/storage.tf`                                                  |
| SQS scan queue with a dead-letter queue (3 tries)                                                                                                            | `terraform/queue.tf`                                                    |
| Reusable Terraform for a Lambda and for a route                                                                                                              | `terraform/modules/lambda`, `terraform/modules/route`                   |
| Shared Lambda code: responses, errors, validation, logging, JWT, secrets                                                                                     | `common/`                                                               |
| Finding fingerprints and the scan diff (new, still open, fixed)                                                                                              | `common/findings/fingerprint.ts`, `diff.ts`                             |
| Semgrep and ZAP report parsers                                                                                                                               | `common/findings/semgrep.ts`, `zap.ts`                                  |
| ECS cluster, Semgrep and ZAP task definitions, EventBridge rule that sends stopped tasks to the processor                                                    | `terraform/ecs.tf`, [docs/scanners.md](docs/scanners.md#on-ecs-task-22) |
| Scanner images: Semgrep (SAST) and ZAP (DAST), offline, with zip-bomb limits and pinned versions                                                             | `scanners/`, [docs/scanners.md](docs/scanners.md)                       |
| `add-user` script to create login users                                                                                                                      | `scripts/add_user.ts`                                                   |
| Route `GET /scans`: the most recent scans across all projects, newest first, paged (Task 30, Rushikesh)                                                      | `lambdas/list-recent-scans`, `terraform/routes.tf`                      |
| Launcher Lambda: reads the scan queue (SQS trigger, `launcher_max_concurrency`) and starts one Fargate scanner task per job (Task 20, Rushikesh)             | `lambdas/launcher`, `terraform/lambdas.tf`, `terraform/queue.tf`        |
| Dashboard bucket: website settings, public read and `config.json` with the API address (Task 25, Rushikesh)                                                  | `terraform/frontend.tf`                                                 |
| GitHub Actions CI: format, lint, typecheck, tests, `terraform fmt` and `validate`                                                                            | `.github/workflows/ci.yml`                                              |
| Not yet: reaper, SNS alerts, test app in the VPC, alarms                                                                                                     | see [TASKS.md](TASKS.md)                                                |

## Repo layout

```
common/      code shared by every Lambda (HTTP responses, JWT, DynamoDB, logging, secrets)
common/findings/  fingerprints, scan diff and scanner report parsers (pure code, no AWS)
docs/        design notes
lambdas/     one folder per Lambda: <name>.ts (logic) and handler.ts (thin AWS wrapper)
scanners/    the Semgrep and ZAP images: Dockerfile and wrapper per scanner, versions.env
scripts/     add_user.ts, package.mjs (bundles Lambdas for Terraform), build_scanner_images.sh
terraform/   all AWS resources; modules/ for reusable pieces, env/ for each lab's settings
tests/       Vitest unit tests; fixtures/ holds real scanner reports and sample code
```

## What you need

- **Node 22 or newer** and npm
- **Terraform 1.5 or newer** and the **AWS CLI**: `brew install terraform awscli`
- An **AWS Academy Learner Lab** (region `us-east-1`)

## Connect to your Learner Lab

Learner Lab gives you temporary keys. They change every time you start the lab and run out after about 4 hours, so repeat this each session.

1. In Learner Lab, click **Start Lab** and wait for the green dot.
2. Click **AWS Details**, then **Show** next to "AWS CLI", and copy the whole block (it starts with `[default]`).
3. Save it as `~/.aws/credentials`. The most reliable way, in the macOS Terminal app:

   ```bash
   cat > ~/.aws/credentials
   ```

   Paste with Cmd+V, press Enter, then Ctrl+D. (Or open the file with `open -e ~/.aws/credentials`, paste, and save.)

4. Once only, set the region:

   ```bash
   printf '[default]\nregion = us-east-1\n' > ~/.aws/config
   ```

5. Check it works. It should print your account number and a `voclabs` ARN:

   ```bash
   aws sts get-caller-identity
   ```

Never commit, paste or share these keys. If they leak, click **End Lab** and **Start Lab** to get new ones.

## Set up your lab (first time)

Run everything from the repo root.

**1. Make your settings file.** Copy the example and name it after yourself. It is git-ignored.

```bash
cp terraform/env/example.tfvars.example terraform/env/<yourname>.tfvars
```

Fill in your lab's values. This command prints your LabRole ARN:

```bash
aws iam get-role --role-name LabRole --query Role.Arn --output text
```

- `environment` and `name_prefix`: your name, for example `shreya` and `shreya-sh`. The prefix starts every resource name.
- `frontend_bucket_name`: the S3 bucket the dashboard is hosted in. It must already exist (the frontend team creates it). Terraform turns on website hosting, makes it publicly readable and writes `config.json` (`apiBaseUrl`, `environment`) into it. The output `frontend_website_url` is the dashboard's address and must equal `allowed_origin`.
- `allowed_origin`: the dashboard's address, `http://<frontend_bucket_name>.s3-website-us-east-1.amazonaws.com`. The API and the uploads bucket allow browser requests from this address only (CORS). To use the dashboard on your laptop instead, set it to `http://localhost:3000`.
- There is no VPC to look up: Terraform creates a dedicated one (`network.tf`). `vpc_cidr` and `az_count` have defaults and can be left out.
- Scanner images, `alert_email` and `juice_shop_url` can stay as placeholders until their tasks are built.

**2. Create the JWT signing secret** (once per lab). Login signs its tokens with a secret kept in SSM Parameter Store, never in Terraform, so it stays out of the state file. The name must match `jwt_secret_ssm_name` (default `/security-hub/jwt-secret`). The script generates a random 48-byte secret and stores it straight in SSM. It is never printed. It refuses to replace an existing secret unless you pass `--rotate` (which signs every user out):

```bash
npm run create-jwt-secret
```

**3. Create the S3 buckets** (once per lab). Terraform cannot create them in Learner Lab (see [Learner Lab restrictions](#learner-lab-restrictions)), so this script does. Use the same `name_prefix` as in your tfvars file. It is safe to run again:

```bash
scripts/manage_buckets.sh create <name_prefix>
```

**4. Bundle the Lambdas.** Terraform zips them from `build/lambdas/`, so this must run before every `plan` or `apply` after a code change:

```bash
npm ci && npm run build
```

**5. Build the AWS resources:**

```bash
terraform -chdir=terraform init
```

```bash
terraform -chdir=terraform apply -var-file=env/<yourname>.tfvars
```

Check the list and type `yes`. Useful outputs (`terraform -chdir=terraform output`):

- `api_base_url`: the API's address. It goes into the dashboard's `config.json` as `apiBaseUrl`.
- `uploads_bucket`, `reports_bucket`, `scan_queue_url`: the names the Lambdas get as `UPLOADS_BUCKET`, `REPORTS_BUCKET` and `QUEUE_URL`.
- `table_names`: the DynamoDB tables (the users table is needed for `add-user`).
- `network` and `scanners`: the private subnets, the scanner security group, the ECS cluster and the task definitions, which the launcher uses to start scans.

**6. Create a login user:**

```bash
npm run add-user -- --username <name> --role user --table <users table>
```

The users table name is in `terraform -chdir=terraform output table_names`. It asks for the password with a hidden prompt.

## Day to day

- Start the lab and refresh `~/.aws/credentials` (see above).
- `git pull`, `npm run build`, then `terraform -chdir=terraform plan -var-file=env/<yourname>.tfvars` to see what a teammate's change would do in your lab, and `apply` to build it.

## How the three labs share one setup

Each of us has a separate AWS account. The code is shared; three small things are personal.

| File                                            | Shared in git | Notes                                                         |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------- |
| `terraform/`, `lambdas/`, `common/`, `scripts/` | Yes           | Everyone runs the same code. Change it with a pull request.   |
| `terraform/env/<yourname>.tfvars`               | No            | Your lab's IDs and names. Git-ignored.                        |
| `terraform/terraform.tfstate`                   | No            | Terraform's record of what it built in your lab. Git-ignored. |
| `~/.aws/credentials`                            | No            | Your lab keys. Never in the repo.                             |

**Keep your state file.** If `terraform.tfstate` is lost, Terraform forgets what it built and tries to create it again. To keep it in S3 instead of on your laptop, see `terraform/backend.s3.tf.example`.

## Learner Lab restrictions

These shape the code. Please keep them in mind when adding resources.

- **No new IAM roles.** Every Lambda and Fargate task uses the existing `LabRole` (`lab_role_arn`).
- **S3 buckets are created by a script, not Terraform.** Terraform's `aws_s3_bucket` resource reads `s3:GetBucketObjectLockConfiguration` after creating a bucket, and Learner Lab denies it (`AccessDenied ... explicit deny in a service control policy`). The bucket gets created but every later plan, apply and destroy fails. So `scripts/manage_buckets.sh create <name_prefix>` makes the uploads and reports buckets, and `terraform/storage.tf` looks them up by name (`data "aws_s3_bucket"`) and still manages their settings (public access block, encryption, lifecycle, CORS). Do not switch them back to the `aws_s3_bucket` resource.
- **Region** is always `us-east-1`.

## Development commands

```bash
npm ci                  # install dependencies
npm run check           # format check, lint, type check and tests
npm run build           # bundle each lambdas/<name>/handler.ts for Terraform
npm run add-user -- --username <name> --role user --table <users table>
scripts/manage_buckets.sh create <prefix>        # create the uploads and reports buckets (delete: same, with `delete`)
scripts/build_scanner_images.sh                  # build the scanner images to test locally
scripts/build_scanner_images.sh --push <prefix>  # build for Fargate and push to ECR in your lab
```

The scanner images, how to test them on a laptop with no AWS, and the settings the launcher passes them are in [docs/scanners.md](docs/scanners.md).

## Tearing down

```bash
terraform -chdir=terraform destroy -var-file=env/<yourname>.tfvars
```

This removes what Terraform built. The two S3 buckets were made by a script, so delete them after the destroy (this also deletes everything inside them):

```bash
scripts/manage_buckets.sh delete <name_prefix>
```

The JWT secret was made outside Terraform; delete it by hand if you need to:

```bash
aws ssm delete-parameter --name /security-hub/jwt-secret
```

The scanner images' ECR repositories (`<prefix>-semgrep`, `<prefix>-zap`) were made by the push script, not Terraform; see [docs/scanners.md](docs/scanners.md#building-and-pushing) to delete them.

## Troubleshooting

- **`Unable to locate credentials` or `ExpiredToken`.** The lab keys are missing or out of date. Repeat [Connect to your Learner Lab](#connect-to-your-learner-lab).
- **`Unable to parse config file: ~/.aws/credentials`.** The file is not in the right shape. It must start with `[default]`, followed by the three `aws_...=` lines.
- **`Given variables file env/... does not exist`.** Terraform ran in the wrong folder. Use `terraform -chdir=terraform ...` from the repo root, or `cd terraform` first.
- **Terraform cannot find a file in `build/lambdas/`.** The Lambdas are not bundled yet. Run `npm run build`.
- **Login answers 500 and its logs show `ParameterNotFound` or "JWT secret is not set in SSM".** Create the secret (step 2 of the setup).
- **`reading S3 Bucket ... object lock configuration ... AccessDenied`.** The bucket is being created by Terraform. Buckets come from `scripts/manage_buckets.sh`; see [Learner Lab restrictions](#learner-lab-restrictions).
- **`Error: reading S3 Bucket (...): ... NotFound` or `no matching S3 Bucket found`.** The buckets do not exist yet. Run `scripts/manage_buckets.sh create <name_prefix>` with the same prefix as your tfvars file, in the same lab account.
