import { ListTasksCommand, StopTaskCommand, type ECSClient } from "@aws-sdk/client-ecs";
import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { logger } from "../../common/logger.js";
import { isValidJobId } from "../../common/validation.js";

/** A scan that sits in QUEUED or RUNNING for longer than this has been lost (architecture 5.6). */
export const STUCK_AFTER_MINUTES = 25;
/** The contract's exact failure message. It names the limit above, so they change together. */
export const TIMED_OUT_MESSAGE = `Timed out after ${String(STUCK_AFTER_MINUTES)} minutes`;

export const STUCK_STATUSES = ["QUEUED", "RUNNING"] as const;
export type StuckStatus = (typeof STUCK_STATUSES)[number];

export interface ReaperDeps {
  /** Jobs in `status` created at or before `createdBefore` (ISO time), from the byStatus index. */
  listOlderThan: (status: StuckStatus, createdBefore: string) => Promise<Record<string, unknown>[]>;
  /** Through transitionJob. False when the job already left QUEUED/RUNNING (finished or missing). */
  markFailed: (jobId: string, error: string, finishedAt: string) => Promise<boolean>;
  /** The running scanner task for a job, found through `startedBy`. */
  findTaskArn: (jobId: string) => Promise<string | undefined>;
  stopTask: (taskArn: string, reason: string) => Promise<void>;
  now?: () => Date;
}

export interface ReapSummary {
  /** Jobs older than the limit that the index returned. */
  checked: number;
  /** Jobs this run marked FAILED. */
  failed: number;
  /** Scanner tasks this run stopped. */
  stopped: number;
  /** Jobs that were not stuck after all, or finished while the reaper looked at them. */
  skipped: number;
  /** Jobs the reaper could not handle. The next run tries them again. */
  errors: number;
}

function timeOf(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : t;
}

/**
 * How long a job has been in its current state. The index is sorted by createdAt, which is never
 * later than queuedAt or startedAt, so the index query finds every candidate and this decides.
 */
function sinceOf(status: StuckStatus, record: Record<string, unknown>): number | undefined {
  const entered = timeOf(status === "RUNNING" ? record.startedAt : record.queuedAt);
  return entered ?? timeOf(record.createdAt);
}

/**
 * Fails every job stuck in QUEUED or RUNNING and stops its scanner task (architecture 5.6).
 * The job is marked FAILED first. The task-stopped event that follows reaches the processor, which
 * sees a final job and leaves it alone, so the message here is the one the user sees.
 * Safe to run twice: transitionJob refuses a job that is already final.
 */
export async function reapStuckJobs(deps: ReaperDeps): Promise<ReapSummary> {
  const now = (deps.now ?? (() => new Date()))();
  const cutoff = now.getTime() - STUCK_AFTER_MINUTES * 60_000;
  const summary: ReapSummary = { checked: 0, failed: 0, stopped: 0, skipped: 0, errors: 0 };

  for (const status of STUCK_STATUSES) {
    const records = await deps.listOlderThan(status, new Date(cutoff).toISOString());
    for (const record of records) {
      summary.checked += 1;
      const jobId = record.jobId;
      if (!isValidJobId(jobId)) {
        logger.error("Job record has no valid jobId, skipping it", { status });
        summary.errors += 1;
        continue;
      }
      const since = sinceOf(status, record);
      if (since === undefined) {
        logger.error("Job has no usable timestamp, skipping it", { jobId, status });
        summary.errors += 1;
        continue;
      }
      // Not older than the limit yet (it was created long ago but started recently).
      if (since >= cutoff) {
        summary.skipped += 1;
        continue;
      }
      try {
        await reapOne(jobId, status, record, now, deps, summary);
      } catch (err) {
        // One bad job must not stop the others. The next run tries this one again.
        logger.error("Could not reap job", { jobId, status, error: err });
        summary.errors += 1;
      }
    }
  }
  logger.info("Reaper run finished", { ...summary });
  return summary;
}

async function reapOne(
  jobId: string,
  status: StuckStatus,
  record: Record<string, unknown>,
  now: Date,
  deps: ReaperDeps,
  summary: ReapSummary,
): Promise<void> {
  if (!(await deps.markFailed(jobId, TIMED_OUT_MESSAGE, now.toISOString()))) {
    logger.info("Job already finished, leaving it", { jobId, status });
    summary.skipped += 1;
    return;
  }
  summary.failed += 1;
  logger.warn("Stuck job failed", { jobId, status });

  // A QUEUED job has no task yet: the launcher starts it only after moving the job to RUNNING.
  if (status === "QUEUED") return;

  // The job is already FAILED, so a task that cannot be stopped does not undo it.
  try {
    const known = typeof record.taskArn === "string" ? record.taskArn : undefined;
    const taskArn = known ?? (await deps.findTaskArn(jobId));
    if (taskArn === undefined) {
      logger.info("No running task to stop", { jobId });
      return;
    }
    await deps.stopTask(taskArn, TIMED_OUT_MESSAGE);
    summary.stopped += 1;
    logger.info("Scanner task stopped", { jobId });
  } catch (err) {
    logger.warn("Could not stop the scanner task", { jobId, error: err });
  }
}

/** Reads the byStatus index, oldest-created first, following every page. */
export function listFromTable(
  client: DynamoDBDocumentClient,
  table: string,
): ReaperDeps["listOlderThan"] {
  return async (status, createdBefore) => {
    const items: Record<string, unknown>[] = [];
    let startKey: Record<string, unknown> | undefined;
    do {
      const out = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: "byStatus",
          KeyConditionExpression: "#status = :s AND createdAt <= :c",
          ExpressionAttributeNames: { "#status": "status" },
          ExpressionAttributeValues: { ":s": status, ":c": createdBefore },
          ...(startKey ? { ExclusiveStartKey: startKey } : {}),
        }),
      );
      items.push(...(out.Items ?? []));
      startKey = out.LastEvaluatedKey;
    } while (startKey);
    return items;
  };
}

export function findTaskInCluster(
  client: ECSClient,
  clusterArn: string,
): ReaperDeps["findTaskArn"] {
  return async (jobId) => {
    // The launcher sets startedBy to the job ID (docs/architecture.md 5.3).
    const out = await client.send(new ListTasksCommand({ cluster: clusterArn, startedBy: jobId }));
    return out.taskArns?.[0];
  };
}

export function stopTaskInCluster(client: ECSClient, clusterArn: string): ReaperDeps["stopTask"] {
  return async (taskArn, reason) => {
    await client.send(new StopTaskCommand({ cluster: clusterArn, task: taskArn, reason }));
  };
}
