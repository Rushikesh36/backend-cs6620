# Scanner images

The two images that do the scanning (Task 21): **Semgrep** for SAST (it reads the uploaded code) and **ZAP** for DAST (it attacks the running test app). Each scan runs in a new Fargate task with one of these images. The task is stateless: it gets its input, scans, uploads the report to S3 and exits. The processor (Task 19) then reads the report and the task's exit code ([architecture](architecture.md) 5.3 to 5.5).

Code: `scanners/common/` (shared), `scanners/semgrep/`, `scanners/zap/`. Each image has a small TypeScript wrapper (`main.ts`, bundled with esbuild) that runs the scanner. Tests: `tests/scanner-*.test.ts`.

## What one scan does

**SAST (Semgrep image)**

1. Downloads `uploads/<jobId>.zip` from the uploads bucket (at most 50 MB, the same limit as start-scan).
2. Unpacks it safely (see [Zip limits](#zip-limits)). If the zip holds one top-level folder (`myapp/...`), it scans inside that folder, so paths and fingerprints stay the same whether the user zipped the folder or its contents, whatever the folder is called.
3. Runs `semgrep scan` offline from inside the source folder, so paths in the report are relative (`app/views.py`).
4. Fixes the report for the processor:
   - Puts the matched code back where free Semgrep wrote `requires login` (lines `start` to `end` of the file, capped at 4,000 characters). The fingerprint needs the code, and the processor only has the report.
   - Removes the rules folder from rule IDs (`opt.semgrep-rules.python...` becomes `python...`), so they match the Semgrep registry.
5. Parses the report with the Task 17 parser as a check, then uploads it to `reports/<jobId>.json`.

**DAST (ZAP image)**

1. Runs `zap-full-scan.py` against `TARGET_URL`: spider, active scan (the attack), passive scan, then the traditional JSON report.
2. Checks that ZAP reached the target. When the test app is down, ZAP still exits 0, with an empty report; uploading that would mark every open finding FIXED. A report with no HTTP answers at all (no `insight.code.*` statistics) and no alerts fails the scan with exit code 6.
3. Parses the report with the Task 17 parser as a check, then uploads it to `reports/<jobId>.json`.

Only the raw report is uploaded. The architecture mentions a normalised report too, but the processor normalises the raw report itself, so a second copy would never be read.

## Settings (container environment)

The task definitions (Task 22, `terraform/ecs.tf`) already set the ones that are the same for every job. The launcher (Task 20) adds only the per-job ones as container overrides: `JOB_ID`, and `TARGET_URL` for DAST.

| Variable               | Image   | Required | Meaning                                                                      |
| ---------------------- | ------- | -------- | ---------------------------------------------------------------------------- |
| `JOB_ID`               | both    | yes      | The job's ID (a UUID). Every log line carries it. **Launcher override.**     |
| `REPORTS_BUCKET`       | both    | yes      | Bucket for `reports/<jobId>.json`. Set in the task definition.               |
| `UPLOADS_BUCKET`       | Semgrep | yes      | Bucket holding `uploads/<jobId>.zip`. Set in the task definition.            |
| `TARGET_URL`           | ZAP     | yes      | The test app's real URL from the allow-list. **Launcher override.**          |
| `SCAN_TIMEOUT_SECONDS` | both    | no       | Hard timeout, 60 to 1,380 (23 minutes). Default: 600 (Semgrep), 1,320 (ZAP). |
| `AWS_REGION`           | both    | no       | Set in the task definition, so the AWS SDK never has to guess.               |
| `S3_ENDPOINT`          | both    | no       | Local testing only: a local S3 stand-in. Never set it in AWS.                |

The S3 keys come from `JOB_ID` (`uploads/<jobId>.zip`, `reports/<jobId>.json`), the same as in create-scan and the processor (a test checks they agree), so the launcher never passes a key.

## Exit codes

The processor turns any non-zero code into `FAILED` "Scanner exited with code N". The log line before exit says what happened, with the jobId.

| Code | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | The report is in S3                                                              |
| 1    | Unexpected error in the wrapper (a bug)                                          |
| 2    | Bad settings: a missing or wrong environment variable                            |
| 3    | Bad input: the upload is missing, too large, not a zip, unsafe, or has no files  |
| 4    | The scanner failed: bad exit code, no report, or a report the parser cannot read |
| 5    | S3 error while downloading the upload or uploading the report                    |
| 6    | ZAP got no answer from the target: the test app is not running or not reachable  |
| 124  | The scan hit its hard timeout (the same code the `timeout` command uses)         |

Semgrep counts as failed on any exit code but 0 (we do not pass `--error`, so findings do not change it). `zap-full-scan.py` exits 0, 1 or 2 when the scan ran (we pass `-I`, so warnings do not fail it) and 3 when ZAP or the scan failed; 3 is always a failure, even if a report file exists.

## Time limits

The reaper (Task 23) fails a job that is `RUNNING` for 25 minutes, so a scan always gives up first.

- The wrapper has a hard timeout (`SCAN_TIMEOUT_SECONDS`, at most 23 minutes). Every step gets only the time left. On timeout the whole process group (ZAP's Python script starts Java) gets SIGTERM, then SIGKILL 5 seconds later, and the container exits with 124.
- ZAP's own limits fit inside its 22-minute default: start 3, spider 5, active scan 10, passive scan 3 minutes (21 in the worst case).
- When ECS stops the task (SIGTERM), the wrapper stops the scanner too.

## Zip limits

A "zip bomb" is a small zip that unpacks to something huge. The wrapper counts the bytes it really writes; it never trusts the sizes a zip claims.

| Rule                                                          | What happens     |
| ------------------------------------------------------------- | ---------------- |
| More than 20,000 entries                                      | Refused (exit 3) |
| Unpacks to more than 200 MB in total                          | Refused (exit 3) |
| A file's real size differs from the size in the zip           | Refused (exit 3) |
| A path with `..`, an absolute path, or a Windows drive or `\` | Refused (exit 3) |
| The same file listed twice                                    | Refused (exit 3) |
| A file over 5 MB (Semgrep skips files over 1 MB anyway)       | Skipped          |
| Symbolic links and encrypted files                            | Skipped          |
| `.git/` folders and the `__MACOSX/` folder macOS Finder adds  | Left out         |

## Offline

The scanners run in private subnets with no internet (architecture section 4), so nothing may be downloaded at scan time.

- **Semgrep:** the rule packs `p/default`, `p/python`, `p/javascript` and `p/secrets` (about 1,350 rules) are downloaded from the Semgrep registry when the image is built and kept in `/opt/semgrep-rules`. Metrics and the version check are off (`--metrics off`, `--disable-version-check`, and the same in environment variables).
- **ZAP:** runs with `-silent`, which stops update checks, add-on downloads and telemetry. `zap-full-scan.py` would download the beta scan rules at start-up without `-silent`, so the image installs them when it is built.

Tested on a Docker network with no internet access (see [Testing on a laptop](#testing-on-a-laptop)).

## Pinned versions

`scanners/versions.env` is the one place versions are set: Node.js, Semgrep, ZAP, the rule packs and `IMAGE_REVISION` (our own changes). Image tags are `<scanner version>-<revision>`, for example `1.183.0-1` and `2.17.0-1`. Terraform rejects `:latest`, and the ECR repositories have immutable tags, so a pushed tag never changes. The rule packs and ZAP's beta rules are whatever the registry served on the day of the build; the image tag pins that result. To change anything, edit `versions.env`, raise `IMAGE_REVISION`, rebuild and push, and put the new URIs in your tfvars.

## Building and pushing

```bash
scripts/build_scanner_images.sh
```

builds both images for this computer (for local tests): `security-hub-semgrep:<tag>` and `security-hub-zap:<tag>`.

```bash
scripts/build_scanner_images.sh --push <name_prefix>
```

builds both for Fargate (`linux/amd64`) and pushes them to ECR in your lab, as `<name_prefix>-semgrep` and `<name_prefix>-zap`, creating the repositories if needed. It uses your own lab credentials (LabRole can only read ECR) and prints the two `*_image_uri` lines for your tfvars. On an Apple silicon Mac the `linux/amd64` build runs under emulation and is slower.

The images are large because the scanners are: about 1.8 GB (Semgrep) and 4.1 GB (ZAP) unpacked. The ZAP base image includes a browser and other tools we do not use.

**Teardown:** Terraform did not create these repositories, so `terraform destroy` leaves them. Delete them by hand if you need to:

```bash
aws ecr delete-repository --repository-name <name_prefix>-semgrep --force
```

```bash
aws ecr delete-repository --repository-name <name_prefix>-zap --force
```

## On ECS (Task 22)

`terraform/ecs.tf` builds:

| Name (with your prefix, for example `geetha-sh`) | What it is                                                                                |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `<prefix>-scanners`                              | The ECS cluster. Container Insights off (it costs extra).                                 |
| `<prefix>-semgrep`                               | SAST task definition: 1 vCPU, 2 GB, image `semgrep_image_uri`                             |
| `<prefix>-zap`                                   | DAST task definition: 2 vCPU, 8 GB, image `zap_image_uri`                                 |
| `scanner`                                        | The container name in both task definitions, so the launcher's override is the same       |
| `/ecs/<prefix>-semgrep`, `/ecs/<prefix>-zap`     | Log groups (stream `scan/scanner/<taskId>`), kept `log_retention_days` like the Lambdas'  |
| `<prefix>-scanner-task-stopped`                  | EventBridge rule: ECS "Task State Change", `lastStatus` STOPPED, this cluster → processor |

The task definitions reuse what already exists: LabRole as both the execution role and the task role, and the buckets from `storage.tf`. On Fargate the network is not part of a task definition: the launcher passes the private subnets and the scanner security group from `network.tf` with each `RunTask`. The task definitions run `X86_64` (what the push script builds), stop with a 30-second `stopTimeout` so the wrapper can stop the scanner, and keep a writable root file system (Semgrep unpacks into `/tmp`, ZAP writes to `/zap/wrk`). ZAP gets 8 GB because its DOM XSS rule starts headless Firefox browsers: scanning Juice Shop on a laptop took the container to about 6.4 GB. Semgrep used well under 1 GB on the sample app.

The processor tolerates repeated events, so the rule's target retries (up to 10 times, for at most an hour). A job whose event never arrives is left to the reaper (Task 23).

## For the launcher (Task 20)

Everything the launcher needs is in one Terraform output, `scanners`, so its Lambda's environment can be filled from it instead of repeating names:

```
scanners = {
  cluster_arn    = "arn:aws:ecs:us-east-1:<account>:cluster/<prefix>-scanners"
  cluster_name   = "<prefix>-scanners"
  container_name = "scanner"
  task_definitions = {
    SAST = { family = "<prefix>-semgrep", arn = "...", image_tag = "1.183.0-1", log_group = "/ecs/<prefix>-semgrep" }
    DAST = { family = "<prefix>-zap",     arn = "...", image_tag = "2.17.0-1",  log_group = "/ecs/<prefix>-zap" }
  }
}
```

The network comes from the existing `network` output: `private_subnet_ids` and `scanner_security_group`. In Terraform, the same values are `aws_ecs_cluster.scanners.arn`, `aws_ecs_task_definition.scanner["SAST"]` / `["DAST"]`, `local.scanner_container_name`, `aws_subnet.private[*].id` and `aws_security_group.scanner.id`.

One `RunTask` per job, keyed by the job's `scanType`:

- `cluster`: the cluster ARN; `launchType`: `FARGATE`; `count`: 1
- `taskDefinition`: the family (`<prefix>-semgrep` or `<prefix>-zap`); ECS uses its latest revision
- `startedBy`: the job ID (the processor and the reaper find the job through it)
- `networkConfiguration.awsvpcConfiguration`: the private subnets, the scanner security group, `assignPublicIp: DISABLED`
- `overrides.containerOverrides`: `[{ name: "scanner", environment: [{ name: "JOB_ID", value: <jobId> }] }]`, plus `TARGET_URL` (the real URL for the job's `targetId`) for DAST
- The job record's `imageTag`: `image_tag` for the scan type

The launcher Lambda needs `ecs:RunTask` and `iam:PassRole` on LabRole (to be confirmed in a lab, see TASKS.md).

## Testing on a laptop

The tests in `tests/scanner-*.test.ts` cover the wrapper logic with fake S3 and fake scanners. To run the real images with no AWS, use a Docker network without internet and a local S3 stand-in ([S3Mock](https://github.com/adobe/S3Mock)):

```bash
docker network create --internal scan-net
```

```bash
docker run -d --name s3mock -p 9090:9090 -e COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=uploads,reports adobe/s3mock:4.7.0
```

```bash
docker network connect scan-net s3mock
```

Upload a zip to `s3://uploads/uploads/<jobId>.zip` with `aws --endpoint-url http://localhost:9090 s3 cp ...` (any fake keys work), then run the scanner on the offline network:

```bash
docker run --rm --network scan-net -e JOB_ID=<jobId> -e UPLOADS_BUCKET=uploads -e REPORTS_BUCKET=reports -e S3_ENDPOINT=http://s3mock:9090 -e AWS_REGION=us-east-1 -e AWS_ACCESS_KEY_ID=test -e AWS_SECRET_ACCESS_KEY=test security-hub-semgrep:1.183.0-1
```

For ZAP, start the test app on the same network (`docker run -d --name juiceshop --network scan-net bkimminich/juice-shop:v19.0.0`) and run `security-hub-zap:2.17.0-1` with `TARGET_URL=http://juiceshop:3000` instead of `UPLOADS_BUCKET`.
