# Unified Security Hub: backend and infrastructure

Backend and AWS infrastructure for Unified Security Hub (CS6620 Cloud Computing, Northeastern University, Team 6). It holds the Lambda code, the shared helpers they use, and the Terraform that builds everything in an AWS Learner Lab. The dashboard's code lives in the separate frontend repo (`cs6620-frontend`) and is hosted by hand in its own S3 bucket, outside this repo's Terraform.

Progress and decisions are tracked in [TASKS.md](TASKS.md). The table design is in [docs/data-model.md](docs/data-model.md).

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

| Piece                                                            | Where                       |
| ---------------------------------------------------------------- | --------------------------- |
| DynamoDB tables: users, jobs (3 indexes), findings               | `terraform/dynamodb.tf`     |
| Shared Lambda code: responses, errors, validation, logging, JWT  | `common/`                   |
| `add-user` script to create login users                          | `scripts/add_user.ts`       |
| Script that creates S3 buckets (Learner Lab workaround)          | `scripts/create-buckets.sh` |
| Not yet: API Gateway, Lambdas, SQS, Fargate scanners, SNS alerts | see [TASKS.md](TASKS.md)    |

## Repo layout

```
common/      code shared by every Lambda (HTTP responses, JWT, DynamoDB, logging)
docs/        design notes (data-model.md)
scripts/     add_user.ts, create-buckets.sh, package.mjs (bundles Lambdas for Terraform)
terraform/   all AWS resources; env/ holds each lab's settings
tests/       Vitest unit tests
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
- `frontend_bucket_name`: the bucket your dashboard is hosted in. You set that bucket up by hand (see the frontend repo); this repo only needs its name.
- `allowed_origin`: the dashboard's address, `http://<frontend_bucket_name>.s3-website-us-east-1.amazonaws.com`. The API and the upload bucket allow browser requests from this address only (CORS).
- Scanner images, `alert_email` and `juice_shop_url` can stay as placeholders until their tasks are built.

**2. Create the S3 buckets.** Terraform cannot do this in Learner Lab (see [restrictions](#learner-lab-restrictions)):

```bash
scripts/create-buckets.sh terraform/env/<yourname>.tfvars
```

It creates every `*_bucket_name` in your tfvars except `frontend_bucket_name`. Until the upload and report buckets are added (Task 11), it prints "Nothing to create".

**3. Build everything else:**

```bash
terraform -chdir=terraform init
```

```bash
terraform -chdir=terraform apply -var-file=env/<yourname>.tfvars
```

Check the list and type `yes`.

## Day to day

- Start the lab and refresh `~/.aws/credentials` (see above).
- `git pull`, then run `terraform -chdir=terraform plan -var-file=env/<yourname>.tfvars` to see what a teammate's change would do in your lab, and `apply` to build it.
- If someone adds a new `*_bucket_name` to the tfvars example, add it to your tfvars and run `scripts/create-buckets.sh` again. It skips buckets that already exist.

## How the three labs share one setup

Each of us has a separate AWS account. The code is shared; three small things are personal.

| File                                    | Shared in git | Notes                                                         |
| --------------------------------------- | ------------- | ------------------------------------------------------------- |
| `terraform/*.tf`, `scripts/`, `common/` | Yes           | Everyone runs the same code. Change it with a pull request.   |
| `terraform/env/<yourname>.tfvars`       | No            | Your lab's IDs and names. Git-ignored.                        |
| `terraform/terraform.tfstate`           | No            | Terraform's record of what it built in your lab. Git-ignored. |
| `~/.aws/credentials`                    | No            | Your lab keys. Never in the repo.                             |

**Keep your state file.** If `terraform.tfstate` is lost, Terraform forgets what it built and tries to create it again. To keep it in S3 instead of on your laptop, see `terraform/backend.s3.tf.example`.

## Learner Lab restrictions

These shape the code. Please keep them in mind when adding resources.

- **No new IAM roles.** Every Lambda and Fargate task uses the existing `LabRole` (`lab_role_arn`).
- **Terraform cannot manage S3 buckets.** AWS Academy's service control policy denies `s3:GetBucketObjectLockConfiguration`, and Terraform's `aws_s3_bucket` resource reads it after every create and refresh (checked with AWS provider 5.100 and 6.70), so the apply fails with `AccessDenied ... explicit deny in a service control policy`. No setting in the lab can change this. So:
  - Create buckets with `scripts/create-buckets.sh`. Add a new bucket as a `<something>_bucket_name` variable and the script picks it up.
  - In Terraform, look the bucket up by name and attach everything else to it (CORS, lifecycle rules, policies, notifications, objects). These do not need the blocked permission:

    ```hcl
    data "aws_s3_bucket" "uploads" {
      bucket = var.uploads_bucket_name
    }

    resource "aws_s3_bucket_cors_configuration" "uploads" {
      bucket = data.aws_s3_bucket.uploads.id
      # ...
    }
    ```

  - Do **not** add `resource "aws_s3_bucket"` blocks.
  - This was tested in a Learner Lab: creating the bucket with the script, then website settings, a bucket policy, a public access block and an object on it through Terraform all applied, and a second `plan` showed no changes.
- **Region** is always `us-east-1`.

## Development commands

```bash
npm ci                  # install dependencies
npm run check           # format check, lint, type check and tests
npm run build           # bundle each lambdas/<name>/handler.ts for Terraform
npm run add-user -- --username <name> --role user --table <users table>
```

The users table name is in `terraform -chdir=terraform output table_names`. `add-user` asks for the password with a hidden prompt.

## Tearing down

```bash
terraform -chdir=terraform destroy -var-file=env/<yourname>.tfvars
```

This removes what Terraform built but not the buckets, because the script made them. Delete those by hand if you need to (this deletes their contents too):

```bash
aws s3 rb s3://<bucket-name> --force
```

## Troubleshooting

- **`Unable to locate credentials` or `ExpiredToken`.** The lab keys are missing or out of date. Repeat [Connect to your Learner Lab](#connect-to-your-learner-lab).
- **`Unable to parse config file: ~/.aws/credentials`.** The file is not in the right shape. It must start with `[default]`, followed by the three `aws_...=` lines.
- **`Given variables file env/... does not exist`.** Terraform ran in the wrong folder. Use `terraform -chdir=terraform ...` from the repo root, or `cd terraform` first.
- **`reading S3 Bucket ... object lock configuration ... AccessDenied`.** Something uses `resource "aws_s3_bucket"`. Switch it to the script plus a `data "aws_s3_bucket"` lookup (see [restrictions](#learner-lab-restrictions)).
- **`reading S3 Bucket (...): couldn't find resource`.** The bucket has not been created in this lab yet. Run `scripts/create-buckets.sh`.
- **`Bucket name ... is taken by another AWS account`.** Bucket names are global. Pick another `*_bucket_name` in your tfvars.
