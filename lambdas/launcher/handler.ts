import { ECSClient } from "@aws-sdk/client-ecs";
import type { SQSBatchResponse, SQSEvent } from "aws-lambda";
import { getDocClient, requireEnv, transitionJob } from "../../common/dynamo.js";
import { logger } from "../../common/logger.js";
import { getRecordFromTable } from "../get-scan/get-scan.js";
import {
  launchScan,
  parseMessage,
  readConfig,
  runFargateTask,
  saveTaskArnInTable,
  type LaunchableJob,
} from "./launcher.js";

const ecs = new ECSClient({});

/**
 * Trigger: the SQS scan queue, through an event source mapping (queue.tf). Not an API route.
 * A record that fails is reported back so only that message is tried again (then the DLQ).
 */
export const handler = async (event: SQSEvent): Promise<SQSBatchResponse> => {
  const client = getDocClient();
  const jobs = requireEnv("JOBS_TABLE");
  const config = readConfig(requireEnv);
  const getRecord = getRecordFromTable(client, jobs);
  const deps = {
    getJob: async (jobId: string): Promise<LaunchableJob | undefined> => {
      const r = await getRecord(jobId);
      if (!r) return undefined;
      const { scanType, targetId, status } = r;
      return {
        scanType: scanType as LaunchableJob["scanType"],
        targetId: typeof targetId === "string" ? targetId : null,
        status: typeof status === "string" ? status : "",
      };
    },
    markRunning: (jobId: string, startedAt: string, imageTag: string) =>
      transitionJob(client, jobs, jobId, "RUNNING", { startedAt, imageTag }),
    markFailed: (jobId: string, error: string, finishedAt: string) =>
      transitionJob(client, jobs, jobId, "FAILED", { error, finishedAt }),
    runTask: runFargateTask(ecs, config),
    saveTaskArn: saveTaskArnInTable(client, jobs),
  };

  const batchItemFailures: SQSBatchResponse["batchItemFailures"] = [];
  for (const record of event.Records) {
    const message = parseMessage(record.body);
    if (!message) {
      // A bad message will never get better, so it is dropped, not retried.
      logger.error("Dropping a malformed scan message", { messageId: record.messageId });
      continue;
    }
    try {
      await launchScan(message.jobId, config, deps);
    } catch (err) {
      logger.error("Launcher error, the message will be retried", {
        jobId: message.jobId,
        error: err,
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  return { batchItemFailures };
};
