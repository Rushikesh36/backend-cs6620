import { randomUUID } from "node:crypto";
import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { badRequest } from "../../common/errors.js";
import { logger } from "../../common/logger.js";
import { requireKnownTarget, type Target } from "../../common/targets.js";
import {
  requireProjectId,
  requireScanType,
  requireTargetId,
  type ScanType,
} from "../../common/validation.js";

/** How long the pre-signed upload link works. The response reports this same number. */
export const UPLOAD_EXPIRES_SECONDS = 900;

/** The browser must send exactly this header. It is part of the signature, so nothing else works. */
export const UPLOAD_CONTENT_TYPE = "application/zip";

export interface Job {
  jobId: string;
  projectId: string;
  scanType: ScanType;
  requestedBy: string;
  targetId: string | null;
  status: "CREATED";
  imageTag: null;
  createdAt: string;
  queuedAt: null;
  startedAt: null;
  finishedAt: null;
  summary: null;
  error: null;
  scope: "ALL";
}

export interface CreateScanDeps {
  targets: readonly Target[];
  putJob: (job: Job) => Promise<void>;
  /** Returns a pre-signed PUT URL for this S3 key. */
  presign: (key: string, expiresInSeconds: number) => Promise<string>;
  newId?: () => string;
  now?: () => Date;
}

export interface UploadInstructions {
  url: string;
  method: "PUT";
  headers: { "Content-Type": string };
  expiresIn: number;
}

/** SAST has `upload`. DAST has no `upload` key at all (the contract says so). */
export interface CreateScanResult {
  jobId: string;
  status: "CREATED";
  upload?: UploadInstructions;
}

/** Where a SAST zip lives. start-scan checks this exact key. */
export const uploadKey = (jobId: string): string => `uploads/${jobId}.zip`;

export async function createScan(
  body: Record<string, unknown>,
  username: string,
  deps: CreateScanDeps,
): Promise<CreateScanResult> {
  const projectId = requireProjectId(body.projectId);
  const scanType = requireScanType(body.scanType);

  let targetId: string | null = null;
  if (scanType === "DAST") {
    // Users never send a URL, only an id from the allow-list.
    targetId = requireTargetId(body.targetId);
    requireKnownTarget(deps.targets, targetId);
  } else if (body.targetId !== undefined && body.targetId !== null) {
    throw badRequest("targetId is only for DAST scans.");
  }

  const jobId = (deps.newId ?? randomUUID)();
  const createdAt = (deps.now?.() ?? new Date()).toISOString();

  await deps.putJob({
    jobId,
    projectId,
    scanType,
    requestedBy: username,
    targetId,
    status: "CREATED",
    imageTag: null,
    createdAt,
    queuedAt: null,
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    scope: "ALL",
  });

  logger.info("Scan created", { jobId, projectId, scanType, requestedBy: username });

  // DAST has nothing to upload. SAST gets a link the browser can PUT the zip to.
  if (scanType === "DAST") return { jobId, status: "CREATED" };
  return {
    jobId,
    status: "CREATED",
    upload: {
      url: await deps.presign(uploadKey(jobId), UPLOAD_EXPIRES_SECONDS),
      method: "PUT",
      headers: { "Content-Type": UPLOAD_CONTENT_TYPE },
      expiresIn: UPLOAD_EXPIRES_SECONDS,
    },
  };
}

/** Saves a new job. Fails if the id somehow already exists. */
export async function putJobInTable(
  client: DynamoDBDocumentClient,
  table: string,
  job: Job,
): Promise<void> {
  await client.send(
    new PutCommand({
      TableName: table,
      Item: job,
      ConditionExpression: "attribute_not_exists(jobId)",
    }),
  );
}

/** Pre-signed PUT link for one object. Signed locally, no network call to S3. */
export function presignPut(
  client: S3Client,
  bucket: string,
): (key: string, expiresInSeconds: number) => Promise<string> {
  return (key, expiresInSeconds) =>
    getSignedUrl(
      client,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: UPLOAD_CONTENT_TYPE }),
      {
        expiresIn: expiresInSeconds,
        // Sign the content type, so S3 only accepts the exact header the browser was told to send.
        signableHeaders: new Set(["content-type"]),
      },
    );
}
