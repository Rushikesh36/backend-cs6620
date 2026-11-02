import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, HeadObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import { badRequest, conflict, notFound } from "../../common/errors.js";
import { logger } from "../../common/logger.js";
import { isValidJobId, type ScanType } from "../../common/validation.js";
import { uploadKey } from "../create-scan/create-scan.js";

export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** Every zip file starts with these two bytes ("PK"). */
const ZIP_MAGIC = [0x50, 0x4b];

export const NOT_FOUND_MESSAGE = "Scan not found.";
export const ALREADY_STARTED_MESSAGE = "This scan was already started.";
/** The exact failure text the contract lists for a scan that could not be handed to the launcher. */
export const COULD_NOT_START_MESSAGE = "Could not start scanner task";

export interface StartableJob {
  jobId: string;
  projectId: string;
  scanType: ScanType;
  targetId: string | null;
  status: string;
}

/** What we know about the uploaded object. `firstBytes` is only read when the size is sane. */
export interface UploadInfo {
  size: number;
  firstBytes: Uint8Array;
}

/**
 * The message the launcher reads. It never contains a URL: the launcher looks up the real
 * target address itself from the targetId.
 */
export interface ScanMessage {
  jobId: string;
  projectId: string;
  scanType: ScanType;
  targetId: string | null;
}

export interface StartScanDeps {
  getJob: (jobId: string) => Promise<StartableJob | undefined>;
  /** Undefined when nothing was uploaded under this key. */
  inspectUpload: (key: string) => Promise<UploadInfo | undefined>;
  /** CREATED to QUEUED in one atomic write. False if the job is no longer CREATED. */
  markQueued: (jobId: string, queuedAt: string) => Promise<boolean>;
  markFailed: (jobId: string, error: string, finishedAt: string) => Promise<boolean>;
  sendToQueue: (message: ScanMessage) => Promise<void>;
  now?: () => Date;
}

export interface StartScanResult {
  jobId: string;
  status: "QUEUED";
}

function checkUpload(info: UploadInfo | undefined): void {
  if (!info) throw badRequest("The zip file was not uploaded yet. Upload it before starting.");
  if (info.size > MAX_ZIP_BYTES) throw badRequest("The zip file is larger than 50 MB.");
  const isZip =
    info.size >= ZIP_MAGIC.length && ZIP_MAGIC.every((byte, i) => info.firstBytes.at(i) === byte);
  if (!isZip) throw badRequest("The uploaded file is not a zip file.");
}

export async function startScan(jobId: string, deps: StartScanDeps): Promise<StartScanResult> {
  // A malformed id cannot exist, so it is "not found", not a validation error.
  if (!isValidJobId(jobId)) throw notFound(NOT_FOUND_MESSAGE);
  const job = await deps.getJob(jobId);
  if (!job) throw notFound(NOT_FOUND_MESSAGE);
  if (job.status !== "CREATED") throw conflict(ALREADY_STARTED_MESSAGE);

  // Only SAST has a zip. A pre-signed PUT cannot limit size, so the limit is enforced here.
  if (job.scanType === "SAST") checkUpload(await deps.inspectUpload(uploadKey(jobId)));

  const now = deps.now ?? (() => new Date());
  // The atomic write decides who wins if two requests start the same scan at once.
  if (!(await deps.markQueued(jobId, now().toISOString()))) {
    throw conflict(ALREADY_STARTED_MESSAGE);
  }

  try {
    await deps.sendToQueue({
      jobId,
      projectId: job.projectId,
      scanType: job.scanType,
      targetId: job.targetId,
    });
  } catch (err) {
    // The job is QUEUED but nothing will ever pick it up. Fail it now, so it does not sit
    // there until the reaper finds it. The caller still gets a retryable 5xx.
    logger.error("Could not queue scan", { jobId, error: err });
    await deps.markFailed(jobId, COULD_NOT_START_MESSAGE, now().toISOString());
    throw err;
  }

  logger.info("Scan queued", { jobId, scanType: job.scanType });
  return { jobId, status: "QUEUED" };
}

/** Reads one job from the jobs table. Bad data in the table is a server error, not a 404. */
export async function getJobFromTable(
  client: DynamoDBDocumentClient,
  table: string,
  jobId: string,
): Promise<StartableJob | undefined> {
  const out = await client.send(new GetCommand({ TableName: table, Key: { jobId } }));
  const item = out.Item;
  if (!item) return undefined;
  const { projectId, scanType, targetId, status } = item as Record<string, unknown>;
  if (
    typeof projectId !== "string" ||
    (scanType !== "SAST" && scanType !== "DAST") ||
    typeof status !== "string"
  ) {
    throw new Error(`Job record ${jobId} is malformed.`);
  }
  return {
    jobId,
    projectId,
    scanType,
    targetId: typeof targetId === "string" ? targetId : null,
    status,
  };
}

const isMissingObject = (err: unknown): boolean =>
  typeof err === "object" &&
  err !== null &&
  ((err as { name?: string }).name === "NotFound" ||
    (err as { name?: string }).name === "NoSuchKey" ||
    (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404);

/** Size from a HEAD request, then the first two bytes (only if the size is plausible). */
export function inspectUploadInS3(
  client: S3Client,
  bucket: string,
): (key: string) => Promise<UploadInfo | undefined> {
  return async (key) => {
    let size: number;
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      size = head.ContentLength ?? 0;
    } catch (err) {
      if (isMissingObject(err)) return undefined;
      throw err;
    }
    // Do not download anything from a file that is empty or already too big.
    if (size < ZIP_MAGIC.length || size > MAX_ZIP_BYTES)
      return { size, firstBytes: new Uint8Array() };
    const part = await client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: `bytes=0-${String(ZIP_MAGIC.length - 1)}`,
      }),
    );
    return { size, firstBytes: (await part.Body?.transformToByteArray()) ?? new Uint8Array() };
  };
}

export function sendScanMessage(
  client: SQSClient,
  queueUrl: string,
): (message: ScanMessage) => Promise<void> {
  return async (message) => {
    await client.send(
      new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: JSON.stringify(message) }),
    );
  };
}
