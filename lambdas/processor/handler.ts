import { S3Client } from "@aws-sdk/client-s3";
import { SNSClient } from "@aws-sdk/client-sns";
import type { EventBridgeEvent } from "aws-lambda";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { queryFindings, writeFindingsToTable } from "../../common/findings/table.js";
import { getRecordFromTable } from "../get-scan/get-scan.js";
import {
  completeJob,
  failJob,
  processStoppedTask,
  readReportFromBucket,
  type EcsTaskDetail,
  type Outcome,
} from "./processor.js";
import { publishAlert } from "./alert.js";

let s3: S3Client | undefined;
let sns: SNSClient | undefined;

/**
 * Trigger: the EventBridge rule for ECS "Task State Change" with lastStatus STOPPED (Task 22).
 * Not an API route. A thrown error makes Lambda retry the event, which is safe.
 */
export const handler = async (
  event: EventBridgeEvent<"ECS Task State Change", EcsTaskDetail>,
): Promise<Outcome> => {
  const client = getDocClient();
  const jobs = requireEnv("JOBS_TABLE");
  const findings = requireEnv("FINDINGS_TABLE");
  s3 ??= new S3Client({});
  sns ??= new SNSClient({});
  return processStoppedTask(event.detail, {
    getJob: getRecordFromTable(client, jobs),
    readReport: readReportFromBucket(s3, requireEnv("REPORTS_BUCKET")),
    queryFindings: queryFindings(client, findings),
    writeFindings: writeFindingsToTable(client, findings),
    complete: completeJob(client, jobs),
    fail: failJob(client, jobs),
    alert: publishAlert(sns, requireEnv("ALERTS_TOPIC_ARN")),
  });
};
