# Unified Security Hub: backend and infrastructure

Backend and AWS infrastructure for Unified Security Hub (CS6620 Cloud Computing, Northeastern University, Team 6). It holds the Lambda code, the shared helpers they use, and the Terraform that builds everything in an AWS Learner Lab. The dashboard's code lives in the separate frontend repo (`cs6620-frontend`) and is hosted separately.

Progress and decisions are tracked in [TASKS.md](TASKS.md). Design notes are in [docs/](docs/): the tables in [data-model.md](docs/data-model.md), finding fingerprints and the scan diff in [fingerprints.md](docs/fingerprints.md), and the scanner report parsers in [report-parsers.md](docs/report-parsers.md).

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

| Piece                                                                                                                                                        | Where                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| DynamoDB tables: users, jobs (3 indexes), findings                                                                                                           | `terraform/dynamodb.tf`                                    |
| API Gateway HTTP API: CORS, throttling, JWT authorizer                                                                                                       | `terraform/api.tf`                                         |
| Routes `POST /login`, `GET /targets`, `POST /scans`                                                                                                          | `terraform/routes.tf`                                      |
| Lambdas: login, authorizer, targets (DAST allow-list), create-scan (job + pre-signed upload link)                                                            | `lambdas/`, `terraform/lambdas.tf`, `terraform/targets.tf` |
| S3 buckets: uploads (`uploads/<jobId>.zip`, kept 1 day, browser PUT via CORS) and reports (`reports/<jobId>.json`, kept 14 days); both private and encrypted | `terraform/storage.tf`                                     |
| SQS scan queue with a dead-letter queue (3 tries)                                                                                                            | `terraform/queue.tf`                                       |
| Reusable Terraform for a Lambda and for a route                                                                                                              | `terraform/modules/lambda`, `terraform/modules/route`      |
| Shared Lambda code: responses, errors, validation, logging, JWT, secrets                                                                                     | `common/`                                                  |
| Finding fingerprints and the scan diff (new, still open, fixed)                                                                                              | `common/findings/fingerprint.ts`, `diff.ts`                |
| Semgrep and ZAP report parsers                                                                                                                               | `common/findings/semgrep.ts`, `zap.ts`                     |
| `add-user` script to create login users                                                                                                                      | `scripts/add_user.ts`                                      |
| Not yet: start scan, scan status and history, findings endpoint, launcher, Fargate scanners, processor, reaper, SNS alerts                                   | see [TASKS.md](TASKS.md)                                   |

## Repo layout

```
common/      code shared by every Lambda (HTTP responses, JWT, DynamoDB, logging, secrets)
common/findings/  fingerprints, scan diff and scanner report parsers (pure code, no AWS)
docs/        design notes
lambdas/     one folder per Lambda: <name>.ts (logic) and handler.ts (thin AWS wrapper)
scripts/     add_user.ts, package.mjs (bundles Lambdas for Terraform)
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

Fill in your lab's values. These commands print them:

```bash
aws iam get-role --role-name LabRole --query Role.Arn --output text
```

```bash
aws ec2 describe-vpcs --filters Name=isDefault,Values=true --query "Vpcs[0].VpcId" --output text
```

```bash
aws ec2 describe-subnets --filters Name=default-for-az,Values=true --query "Subnets[].SubnetId" --output text
```

- `environment` and `name_prefix`: your name, for example `shreya` and `shreya-sh`. The prefix starts every resource name.
- `frontend_bucket_name`: the S3 bucket the dashboard is hosted in.
- `allowed_origin`: the dashboard's address, `http://<frontend_bucket_name>.s3-website-us-east-1.amazonaws.com`. The API and the uploads bucket allow browser requests from this address only (CORS). To use the dashboard on your laptop instead, set it to `http://localhost:3000`.
- Scanner images, `alert_email` and `juice_shop_url` can stay as placeholders until their tasks are built.

**2. Create the JWT signing secret** (once per lab). Login signs its tokens with a secret kept in SSM Parameter Store, never in Terraform, so it stays out of the state file. The name must match `jwt_secret_ssm_name` (default `/security-hub/jwt-secret`) and the value must be at least 32 characters:

```bash
aws ssm put-parameter --name /security-hub/jwt-secret --type SecureString --value "$(openssl rand -hex 32)"
```

A script for this is still to be written (see open items in [TASKS.md](TASKS.md)).

**3. Bundle the Lambdas.** Terraform zips them from `build/lambdas/`, so this must run before every `plan` or `apply` after a code change:

```bash
npm ci && npm run build
```

**4. Build the AWS resources:**

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

**5. Create a login user:**

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
- **S3 buckets (check before deploying).** In an earlier Learner Lab test (October 2026), Terraform's `aws_s3_bucket` resource failed with `AccessDenied ... explicit deny in a service control policy`, because it reads `s3:GetBucketObjectLockConfiguration` after creating a bucket. `terraform/storage.tf` uses this resource for the uploads and reports buckets. Run `apply` in one lab early; if you see this error, tell the owner of Task 11 before the others deploy.
- **Region** is always `us-east-1`.

## Development commands

```bash
npm ci                  # install dependencies
npm run check           # format check, lint, type check and tests
npm run build           # bundle each lambdas/<name>/handler.ts for Terraform
npm run add-user -- --username <name> --role user --table <users table>
```

## Tearing down

```bash
terraform -chdir=terraform destroy -var-file=env/<yourname>.tfvars
```

This removes what Terraform built, including the uploads and reports buckets and everything in them (`force_destroy`). The JWT secret was made outside Terraform; delete it by hand if you need to:

```bash
aws ssm delete-parameter --name /security-hub/jwt-secret
```

## Troubleshooting

- **`Unable to locate credentials` or `ExpiredToken`.** The lab keys are missing or out of date. Repeat [Connect to your Learner Lab](#connect-to-your-learner-lab).
- **`Unable to parse config file: ~/.aws/credentials`.** The file is not in the right shape. It must start with `[default]`, followed by the three `aws_...=` lines.
- **`Given variables file env/... does not exist`.** Terraform ran in the wrong folder. Use `terraform -chdir=terraform ...` from the repo root, or `cd terraform` first.
- **Terraform cannot find a file in `build/lambdas/`.** The Lambdas are not bundled yet. Run `npm run build`.
- **Login answers 500 and its logs show `ParameterNotFound` or "JWT secret is not set in SSM".** Create the secret (step 2 of the setup).
- **`reading S3 Bucket ... object lock configuration ... AccessDenied`.** See [Learner Lab restrictions](#learner-lab-restrictions).
