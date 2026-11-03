import { S3Client } from "@aws-sdk/client-s3";
import { SQSClient } from "@aws-sdk/client-sqs";
import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv, transitionJob } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { getJobFromTable, inspectUploadInS3, sendScanMessage, startScan } from "./start-scan.js";

const s3 = new S3Client({});
const sqs = new SQSClient({});

/** POST /scans/{jobId}/start */
export const handler = wrap(async (event) => {
  getCaller(event);
  const jobsTable = requireEnv("JOBS_TABLE");
  const client = getDocClient();

  const result = await startScan(event.pathParameters?.jobId ?? "", {
    getJob: (jobId) => getJobFromTable(client, jobsTable, jobId),
    inspectUpload: inspectUploadInS3(s3, requireEnv("UPLOADS_BUCKET")),
    markQueued: (jobId, queuedAt) =>
      transitionJob(client, jobsTable, jobId, "QUEUED", { queuedAt }),
    markFailed: (jobId, error, finishedAt) =>
      transitionJob(client, jobsTable, jobId, "FAILED", { error, finishedAt }),
    sendToQueue: sendScanMessage(sqs, requireEnv("QUEUE_URL")),
  });
  return json(200, result);
});
