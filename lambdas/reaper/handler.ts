import { ECSClient } from "@aws-sdk/client-ecs";
import { getDocClient, requireEnv, transitionJob } from "../../common/dynamo.js";
import {
  findTaskInCluster,
  listFromTable,
  reapStuckJobs,
  stopTaskInCluster,
  type ReapSummary,
} from "./reaper.js";

const ecs = new ECSClient({});

/**
 * Trigger: an EventBridge schedule (reaper.tf). Not an API route, and the event has no input.
 * If any job could not be handled the run fails, so the error shows in the Lambda metrics. The
 * next run tries again, and a job that was already failed is skipped.
 */
export const handler = async (): Promise<ReapSummary> => {
  const client = getDocClient();
  const jobs = requireEnv("JOBS_TABLE");
  const cluster = requireEnv("CLUSTER_ARN");
  const summary = await reapStuckJobs({
    listOlderThan: listFromTable(client, jobs),
    markFailed: (jobId, error, finishedAt) =>
      transitionJob(client, jobs, jobId, "FAILED", { error, finishedAt }),
    findTaskArn: findTaskInCluster(ecs, cluster),
    stopTask: stopTaskInCluster(ecs, cluster),
  });
  if (summary.errors > 0) {
    throw new Error(`Reaper could not handle ${String(summary.errors)} job(s)`);
  }
  return summary;
};
