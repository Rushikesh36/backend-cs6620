# Scanner tasks on ECS Fargate (Task 22, docs/architecture.md 5.3 to 5.5, docs/scanners.md).
# One cluster, one task definition per scanner. The launcher (Task 20) starts a task per job with
# RunTask; when the task stops, EventBridge sends the event to the processor (Task 19).
# Every task uses LabRole (Learner Lab cannot create roles) and runs in the private subnets.

locals {
  # The names the launcher needs (Task 20). Both task definitions call their container "scanner",
  # so the launcher's container override is the same for SAST and DAST.
  scanner_container_name = "scanner"

  # Per scan type: the image and its size. The tag is saved on the job record by the launcher.
  # ZAP gets 8 GB: its DOM XSS rule starts headless Firefox browsers (about 6.4 GB on Juice Shop).
  scanner_tasks = {
    SAST = {
      family    = "${local.prefix}-semgrep"
      image_uri = var.semgrep_image_uri
      cpu       = 1024
      memory    = 2048
    }
    DAST = {
      family    = "${local.prefix}-zap"
      image_uri = var.zap_image_uri
      cpu       = 2048
      memory    = 8192
    }
  }

  # Settings that are the same for every job. The launcher only adds JOB_ID (and TARGET_URL for
  # DAST) as container overrides; see docs/scanners.md.
  scanner_environment = {
    SAST = {
      AWS_REGION     = var.region
      REPORTS_BUCKET = aws_s3_bucket.reports.bucket
      UPLOADS_BUCKET = aws_s3_bucket.uploads.bucket
    }
    DAST = {
      AWS_REGION     = var.region
      REPORTS_BUCKET = aws_s3_bucket.reports.bucket
    }
  }
}

resource "aws_ecs_cluster" "scanners" {
  name = "${local.prefix}-scanners"

  # Container Insights costs extra; the wrappers' JSON logs are enough for this project.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_cloudwatch_log_group" "scanner" {
  for_each = local.scanner_tasks

  name              = "/ecs/${each.value.family}"
  retention_in_days = var.log_retention_days
}

resource "aws_ecs_task_definition" "scanner" {
  for_each = local.scanner_tasks

  family                   = each.value.family
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  # LabRole both pulls the image and writes logs (execution role) and reads/writes S3 (task role).
  execution_role_arn = var.lab_role_arn
  task_role_arn      = var.lab_role_arn

  # The push script builds linux/amd64 images (scripts/build_scanner_images.sh).
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name      = local.scanner_container_name
      image     = each.value.image_uri
      essential = true
      # Time between SIGTERM and SIGKILL when the task is stopped, so the wrapper can stop the
      # scanner. The root file system stays writable: Semgrep unpacks into /tmp, ZAP uses /zap/wrk.
      stopTimeout = 30
      environment = [
        for name, value in local.scanner_environment[each.key] : { name = name, value = value }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.scanner[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "scan"
        }
      }
    }
  ])

  tags = { Name = each.value.family }
}

# ---------- Task stopped -> processor ----------
# The processor's only trigger (architecture 5.5). It reads the job ID from startedBy and ignores
# tasks that no launcher started (for example the test app's service in Task 31).

resource "aws_cloudwatch_event_rule" "scanner_task_stopped" {
  name        = "${local.prefix}-scanner-task-stopped"
  description = "A task in the scanner cluster stopped: let the processor finish its job"

  event_pattern = jsonencode({
    source      = ["aws.ecs"]
    detail-type = ["ECS Task State Change"]
    detail = {
      clusterArn = [aws_ecs_cluster.scanners.arn]
      lastStatus = ["STOPPED"]
    }
  })
}

resource "aws_cloudwatch_event_target" "processor" {
  rule = aws_cloudwatch_event_rule.scanner_task_stopped.name
  arn  = module.processor.arn

  # The processor is safe to run twice for one event, so retrying is fine. A stuck job is the
  # reaper's to fail (Task 23), so an event older than an hour is no longer useful.
  retry_policy {
    maximum_event_age_in_seconds = 3600
    maximum_retry_attempts       = 10
  }
}

resource "aws_lambda_permission" "processor_from_eventbridge" {
  statement_id  = "AllowEventBridgeTaskStopped"
  action        = "lambda:InvokeFunction"
  function_name = module.processor.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.scanner_task_stopped.arn
}
