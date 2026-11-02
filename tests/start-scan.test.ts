import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../lambdas/start-scan/handler.js";
import {
  ALREADY_STARTED_MESSAGE,
  COULD_NOT_START_MESSAGE,
  MAX_ZIP_BYTES,
  NOT_FOUND_MESSAGE,
  startScan,
  type StartableJob,
  type StartScanDeps,
  type UploadInfo,
} from "../lambdas/start-scan/start-scan.js";
import { makeEvent } from "./helpers.js";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-11-02T10:00:00.000Z");
const PK = Uint8Array.from([0x50, 0x4b]);

const sastJob: StartableJob = {
  jobId: JOB_ID,
  projectId: "demo-app",
  scanType: "SAST",
  targetId: null,
  status: "CREATED",
};
const dastJob: StartableJob = { ...sastJob, scanType: "DAST", targetId: "juice-shop" };

function setup(
  job: StartableJob | undefined,
  upload: UploadInfo | null = { size: 100, firstBytes: PK },
) {
  const markQueued = vi.fn<StartScanDeps["markQueued"]>(() => Promise.resolve(true));
  const markFailed = vi.fn<StartScanDeps["markFailed"]>(() => Promise.resolve(true));
  const sendToQueue = vi.fn<StartScanDeps["sendToQueue"]>(() => Promise.resolve());
  const inspectUpload = vi.fn<StartScanDeps["inspectUpload"]>(() =>
    Promise.resolve(upload ?? undefined),
  );
  const deps: StartScanDeps = {
    getJob: () => Promise.resolve(job),
    inspectUpload,
    markQueued,
    markFailed,
    sendToQueue,
    now: () => NOW,
  };
  return { deps, markQueued, markFailed, sendToQueue, inspectUpload };
}

async function fail(
  jobId: string,
  deps: StartScanDeps,
): Promise<{ statusCode: number; message: string }> {
  try {
    await startScan(jobId, deps);
  } catch (e) {
    const err = e as { statusCode: number; message: string };
    return { statusCode: err.statusCode, message: err.message };
  }
  throw new Error("expected startScan to fail");
}

describe("startScan: success", () => {
  it("SAST: checks the zip, marks QUEUED and sends the message", async () => {
    const { deps, markQueued, sendToQueue, inspectUpload } = setup(sastJob);
    const result = await startScan(JOB_ID, deps);

    expect(result).toEqual({ jobId: JOB_ID, status: "QUEUED" });
    expect(inspectUpload).toHaveBeenCalledWith(`uploads/${JOB_ID}.zip`);
    expect(markQueued).toHaveBeenCalledWith(JOB_ID, "2026-11-02T10:00:00.000Z");
    expect(sendToQueue).toHaveBeenCalledWith({
      jobId: JOB_ID,
      projectId: "demo-app",
      scanType: "SAST",
      targetId: null,
    });
  });

  it("DAST: no zip to check, queued with the targetId only", async () => {
    const { deps, sendToQueue, inspectUpload } = setup(dastJob, null);
    expect(await startScan(JOB_ID, deps)).toEqual({ jobId: JOB_ID, status: "QUEUED" });
    expect(inspectUpload).not.toHaveBeenCalled();
    expect(sendToQueue).toHaveBeenCalledWith({
      jobId: JOB_ID,
      projectId: "demo-app",
      scanType: "DAST",
      targetId: "juice-shop",
    });
  });

  it("accepts a zip of exactly 50 MB", async () => {
    const { deps } = setup(sastJob, { size: MAX_ZIP_BYTES, firstBytes: PK });
    await expect(startScan(JOB_ID, deps)).resolves.toMatchObject({ status: "QUEUED" });
  });
});

describe("startScan: 404 and 409", () => {
  it("404 for a missing job and for a malformed id", async () => {
    const missing = setup(undefined);
    expect(await fail(JOB_ID, missing.deps)).toEqual({
      statusCode: 404,
      message: NOT_FOUND_MESSAGE,
    });
    const malformed = setup(sastJob);
    expect(await fail("not-a-job-id", malformed.deps)).toEqual({
      statusCode: 404,
      message: NOT_FOUND_MESSAGE,
    });
    expect(malformed.sendToQueue).not.toHaveBeenCalled();
  });

  it.each(["QUEUED", "RUNNING", "COMPLETED", "FAILED"])(
    "409 when the job is already %s, and nothing is queued",
    async (status) => {
      const { deps, markQueued, sendToQueue } = setup({ ...sastJob, status });
      expect(await fail(JOB_ID, deps)).toEqual({
        statusCode: 409,
        message: ALREADY_STARTED_MESSAGE,
      });
      expect(markQueued).not.toHaveBeenCalled();
      expect(sendToQueue).not.toHaveBeenCalled();
    },
  );

  it("409 when another request wins the race, and nothing is queued", async () => {
    const { deps, sendToQueue } = setup(sastJob);
    deps.markQueued = () => Promise.resolve(false);
    expect(await fail(JOB_ID, deps)).toEqual({ statusCode: 409, message: ALREADY_STARTED_MESSAGE });
    expect(sendToQueue).not.toHaveBeenCalled();
  });
});

describe("startScan: zip checks (400)", () => {
  const cases: [string, UploadInfo | null][] = [
    ["not uploaded yet", null],
    ["larger than 50 MB", { size: MAX_ZIP_BYTES + 1, firstBytes: new Uint8Array() }],
    ["not a zip (wrong first bytes)", { size: 100, firstBytes: Uint8Array.from([0x4d, 0x5a]) }],
    ["an empty file", { size: 0, firstBytes: new Uint8Array() }],
    ["a one-byte file", { size: 1, firstBytes: Uint8Array.from([0x50]) }],
  ];

  it.each(cases)("400 when the upload is %s, and the job is not touched", async (_name, upload) => {
    const { deps, markQueued, sendToQueue } = setup(sastJob, upload);
    const err = await fail(JOB_ID, deps);
    expect(err.statusCode).toBe(400);
    expect(err.message.length).toBeGreaterThan(10);
    expect(markQueued).not.toHaveBeenCalled();
    expect(sendToQueue).not.toHaveBeenCalled();
  });
});

describe("startScan: queue failure", () => {
  it("fails the job with the contract message and still reports an error", async () => {
    const { deps, markFailed } = setup(sastJob);
    deps.sendToQueue = () => Promise.reject(new Error("sqs down"));
    await expect(startScan(JOB_ID, deps)).rejects.toThrow("sqs down");
    expect(markFailed).toHaveBeenCalledWith(
      JOB_ID,
      COULD_NOT_START_MESSAGE,
      "2026-11-02T10:00:00.000Z",
    );
    expect(COULD_NOT_START_MESSAGE).toBe("Could not start scanner task");
  });
});

describe("POST /scans/{jobId}/start handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const s3 = mockClient(S3Client);
  const sqs = mockClient(SQSClient);

  beforeEach(() => {
    ddb.reset();
    s3.reset();
    sqs.reset();
    process.env.JOBS_TABLE = "jobs";
    process.env.UPLOADS_BUCKET = "uploads-bucket";
    process.env.QUEUE_URL = "https://sqs.example/queue";
    ddb.on(GetCommand).resolves({ Item: { ...sastJob } });
    ddb.on(UpdateCommand).resolves({});
    s3.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
    s3.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: () => Promise.resolve(PK) } as never,
    });
    sqs.on(SendMessageCommand).resolves({});
  });

  const start = (jobId: string | null = JOB_ID, authorized = true) =>
    handler(
      makeEvent({
        ...(jobId === null ? {} : { pathParameters: { jobId } }),
        requestContext: {
          authorizer: authorized ? { lambda: { username: "rushikesh", role: "user" } } : undefined,
        } as never,
      }),
    );

  it("200: reads only the first two bytes, queues atomically and sends the message", async () => {
    const res = await start();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ jobId: JOB_ID, status: "QUEUED" });

    expect(s3.commandCalls(HeadObjectCommand)[0]?.args[0].input).toMatchObject({
      Bucket: "uploads-bucket",
      Key: `uploads/${JOB_ID}.zip`,
    });
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input.Range).toBe("bytes=0-1");

    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ jobId: JOB_ID });
    expect(update?.ConditionExpression).toContain("attribute_exists(jobId)");
    expect(Object.values(update?.ExpressionAttributeValues ?? {})).toContain("QUEUED");
    expect(Object.values(update?.ExpressionAttributeValues ?? {})).toContain("CREATED");

    const sent = sqs.commandCalls(SendMessageCommand)[0]?.args[0].input;
    expect(sent?.QueueUrl).toBe("https://sqs.example/queue");
    expect(JSON.parse(sent?.MessageBody ?? "")).toEqual({
      jobId: JOB_ID,
      projectId: "demo-app",
      scanType: "SAST",
      targetId: null,
    });
  });

  it("does not download anything when the file is already too big", async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: MAX_ZIP_BYTES + 1 });
    const res = await start();
    expect(res.statusCode).toBe(400);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("400 when S3 says the object does not exist", async () => {
    s3.on(HeadObjectCommand).rejects(
      Object.assign(new Error("Not Found"), {
        name: "NotFound",
        $metadata: { httpStatusCode: 404 },
      }),
    );
    const res = await start();
    expect(res.statusCode).toBe(400);
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("400 when the file is not a zip", async () => {
    s3.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([1, 2])) } as never,
    });
    expect((await start()).statusCode).toBe(400);
  });

  it("404 for a missing job and for a bad id in the path", async () => {
    ddb.on(GetCommand).resolves({});
    expect((await start()).statusCode).toBe(404);
    expect((await start("nope")).statusCode).toBe(404);
    expect((await start(null)).statusCode).toBe(404);
  });

  it("409 when the conditional write fails, and nothing is queued", async () => {
    ddb
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    const res = await start();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body as string)).toEqual({ error: ALREADY_STARTED_MESSAGE });
    expect(sqs.commandCalls(SendMessageCommand)).toHaveLength(0);
  });

  it("401 without a caller from the authorizer", async () => {
    expect((await start(JOB_ID, false)).statusCode).toBe(401);
    expect(ddb.commandCalls(GetCommand)).toHaveLength(0);
  });

  it("generic 500 and a FAILED job when SQS is down", async () => {
    sqs.on(SendMessageCommand).rejects(new Error("secret internal detail"));
    const res = await start();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("secret internal detail");

    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates).toHaveLength(2);
    expect(Object.values(updates[1]?.ExpressionAttributeValues ?? {})).toContain(
      COULD_NOT_START_MESSAGE,
    );
    expect(Object.values(updates[1]?.ExpressionAttributeValues ?? {})).toContain("FAILED");
  });

  it("500 (generic) if the job record in the table is malformed", async () => {
    ddb.on(GetCommand).resolves({ Item: { jobId: JOB_ID, scanType: "XSS" } });
    const res = await start();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("malformed");
  });
});
