import { RunTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { logger } from "../../common/logger.js";
import { isValidJobId, SCAN_TYPES, type ScanType } from "../../common/validation.js";
import { COULD_NOT_START_MESSAGE } from "../start-scan/start-scan.js";

/** What the launcher needs to know about a job to start its scanner. */
export interface LaunchableJob {
  scanType: ScanType;
  targetId: string | null;
  status: string;
}

export interface TaskTypeConfig {
  /** Task definition family. ECS uses its latest revision. */
  family: string;
  /** Saved on the job record as imageTag. */
  imageTag: string;
}

/** Everything that is the same for every job. Built from environment variables (see handler). */
export interface LauncherConfig {
  clusterArn: string;
  containerName: string;
  taskDefinitions: Record<ScanType, TaskTypeConfig>;
  subnetIds: string[];
  securityGroupId: string;
  /** targetId -> real URL. Only the launcher and the scanner ever see these. */
  targetUrls: Record<string, string>;
}

export interface LaunchDeps {
  getJob: (jobId: string) => Promise<LaunchableJob | undefined>;
  /** Conditional QUEUED -> RUNNING. False when the job is not QUEUED (duplicate delivery). */
  markRunning: (jobId: string, startedAt: string, imageTag: string) => Promise<boolean>;
  markFailed: (jobId: string, error: string, finishedAt: string) => Promise<boolean>;
  runTask: (input: RunTaskInput) => Promise<string>;
  saveTaskArn: (jobId: string, taskArn: string) => Promise<void>;
  now?: () => Date;
}

export interface RunTaskInput {
  jobId: string;
  family: string;
  environment: { name: string; value: string }[];
}

/** launched: a task is running. discarded: nothing to do, drop the message. failed: job is FAILED. */
export type LaunchOutcome =
  | { outcome: "launched"; taskArn: string }
  | { outcome: "discarded"; reason: string }
  | { outcome: "failed" };

/** The SQS message body is only { jobId, scanType }. Anything else is dropped, never retried. */
export function parseMessage(body: string): { jobId: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const { jobId } = parsed as Record<string, unknown>;
  return isValidJobId(jobId) ? { jobId } : undefined;
}

export async function launchScan(
  jobId: string,
  config: LauncherConfig,
  deps: LaunchDeps,
): Promise<LaunchOutcome> {
  const now = deps.now ?? (() => new Date());
  const job = await deps.getJob(jobId);
  if (!job) {
    logger.warn("Scan message for an unknown job, dropping it", { jobId });
    return { outcome: "discarded", reason: "unknown job" };
  }
  // The job record, not the message, decides what to run.
  if (!SCAN_TYPES.includes(job.scanType)) {
    logger.error("Job has an unknown scan type", { jobId });
    return { outcome: "discarded", reason: "bad scan type" };
  }
  const type = config.taskDefinitions[job.scanType];

  // The atomic write decides who wins if SQS delivers the message twice.
  if (!(await deps.markRunning(jobId, now().toISOString(), type.imageTag))) {
    logger.info("Job is not QUEUED, dropping the message", { jobId, status: job.status });
    return { outcome: "discarded", reason: "not queued" };
  }

  const environment = [{ name: "JOB_ID", value: jobId }];
  if (job.scanType === "DAST") {
    const url = job.targetId === null ? undefined : config.targetUrls[job.targetId];
    if (url === undefined) {
      logger.error("No URL is configured for the job's target", { jobId, targetId: job.targetId });
      await deps.markFailed(jobId, COULD_NOT_START_MESSAGE, now().toISOString());
      return { outcome: "failed" };
    }
    environment.push({ name: "TARGET_URL", value: url });
  }

  let taskArn: string;
  try {
    taskArn = await deps.runTask({ jobId, family: type.family, environment });
  } catch (err) {
    // Retrying later could start a scan the user gave up on, so the job fails right away.
    logger.error("Could not start scanner task", { jobId, error: err });
    await deps.markFailed(jobId, COULD_NOT_START_MESSAGE, now().toISOString());
    return { outcome: "failed" };
  }

  try {
    await deps.saveTaskArn(jobId, taskArn);
  } catch (err) {
    // The task runs and the processor finds the job through startedBy, so this is not fatal.
    logger.warn("Could not save the task ARN", { jobId, taskArn, error: err });
  }
  logger.info("Scanner task started", { jobId, scanType: job.scanType });
  return { outcome: "launched", taskArn };
}

/** One RunTask per job. ECS reports capacity problems in `failures`, not as an exception. */
export function runFargateTask(client: ECSClient, config: LauncherConfig): LaunchDeps["runTask"] {
  return async ({ jobId, family, environment }) => {
    const out = await client.send(
      new RunTaskCommand({
        cluster: config.clusterArn,
        launchType: "FARGATE",
        count: 1,
        taskDefinition: family,
        startedBy: jobId,
        networkConfiguration: {
          awsvpcConfiguration: {
            subnets: config.subnetIds,
            securityGroups: [config.securityGroupId],
            assignPublicIp: "DISABLED",
          },
        },
        overrides: { containerOverrides: [{ name: config.containerName, environment }] },
      }),
    );
    const taskArn = out.tasks?.[0]?.taskArn;
    if (taskArn === undefined) {
      const reason = out.failures?.map((f) => f.reason ?? "unknown").join(", ") ?? "no task";
      throw new Error(`RunTask returned no task: ${reason}`);
    }
    return taskArn;
  };
}

export function saveTaskArnInTable(
  client: DynamoDBDocumentClient,
  table: string,
): LaunchDeps["saveTaskArn"] {
  return async (jobId, taskArn) => {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: "SET taskArn = :t",
        ConditionExpression: "attribute_exists(jobId)",
        ExpressionAttributeValues: { ":t": taskArn },
      }),
    );
  };
}

function parseJson(name: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${name} is not valid JSON.`);
  }
}

/** Builds the config from environment variables set by Terraform. A deploy mistake throws. */
export function readConfig(env: (name: string) => string): LauncherConfig {
  const defs = parseJson("TASK_DEFINITIONS_JSON", env("TASK_DEFINITIONS_JSON")) as Record<
    string,
    Partial<TaskTypeConfig> | undefined
  >;
  const taskDefinitions = {} as Record<ScanType, TaskTypeConfig>;
  for (const type of SCAN_TYPES) {
    // eslint-disable-next-line security/detect-object-injection -- type is from SCAN_TYPES
    const entry = defs[type];
    if (typeof entry?.family !== "string" || typeof entry.imageTag !== "string") {
      throw new Error(`TASK_DEFINITIONS_JSON needs a family and imageTag for ${type}.`);
    }
    // eslint-disable-next-line security/detect-object-injection -- type is from SCAN_TYPES
    taskDefinitions[type] = { family: entry.family, imageTag: entry.imageTag };
  }
  const targetUrls = parseJson("TARGET_URLS_JSON", env("TARGET_URLS_JSON"));
  if (targetUrls === null || typeof targetUrls !== "object" || Array.isArray(targetUrls)) {
    throw new Error("TARGET_URLS_JSON must be an object.");
  }
  return {
    clusterArn: env("CLUSTER_ARN"),
    containerName: env("CONTAINER_NAME"),
    taskDefinitions,
    subnetIds: env("SUBNET_IDS").split(",").filter(Boolean),
    securityGroupId: env("SECURITY_GROUP_ID"),
    targetUrls: targetUrls as Record<string, string>,
  };
}
