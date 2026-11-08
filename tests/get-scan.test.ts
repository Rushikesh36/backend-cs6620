import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toScanItem } from "../common/scan-item.js";
import { handler } from "../lambdas/get-scan/handler.js";
import { getScan, NOT_FOUND_MESSAGE } from "../lambdas/get-scan/get-scan.js";
import { makeEvent } from "./helpers.js";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

/** A full row as the jobs table holds it, including internal fields the browser must not see. */
const completedRow = {
  jobId: JOB_ID,
  projectId: "demo-app",
  scanType: "SAST",
  targetId: null,
  status: "COMPLETED",
  requestedBy: "rushikesh",
  imageTag: "semgrep-1.4.0-abc1234",
  createdAt: "2026-11-05T10:00:00.000Z",
  queuedAt: "2026-11-05T10:01:00.000Z",
  startedAt: "2026-11-05T10:01:30.000Z",
  finishedAt: "2026-11-05T10:04:00.000Z",
  summary: { new: 3, newHigh: 1, stillOpen: 5, fixed: 2 },
  error: null,
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/cluster/abc",
  scope: "ALL",
};

describe("toScanItem", () => {
  it("returns exactly the contract fields and hides internal ones", () => {
    const item = toScanItem(completedRow);
    expect(Object.keys(item).sort()).toEqual(
      [
        "jobId",
        "projectId",
        "scanType",
        "targetId",
        "status",
        "requestedBy",
        "imageTag",
        "createdAt",
        "queuedAt",
        "startedAt",
        "finishedAt",
        "summary",
        "error",
      ].sort(),
    );
    expect(item).not.toHaveProperty("taskArn");
    expect(item).not.toHaveProperty("scope");
    expect(item.summary).toEqual({ new: 3, newHigh: 1, stillOpen: 5, fixed: 2 });
  });

  it("turns missing attributes into null, so a new job has the full shape", () => {
    const item = toScanItem({
      jobId: JOB_ID,
      projectId: "demo-app",
      scanType: "DAST",
      status: "CREATED",
      requestedBy: "rushikesh",
      createdAt: "2026-11-05T10:00:00.000Z",
      targetId: "juice-shop",
    });
    expect(item).toEqual({
      jobId: JOB_ID,
      projectId: "demo-app",
      scanType: "DAST",
      targetId: "juice-shop",
      status: "CREATED",
      requestedBy: "rushikesh",
      imageTag: null,
      createdAt: "2026-11-05T10:00:00.000Z",
      queuedAt: null,
      startedAt: null,
      finishedAt: null,
      summary: null,
      error: null,
    });
  });

  it("keeps the failure message for a FAILED scan", () => {
    const item = toScanItem({
      ...completedRow,
      status: "FAILED",
      summary: null,
      error: "No report produced",
    });
    expect(item.error).toBe("No report produced");
    expect(item.summary).toBeNull();
  });

  it.each([
    ["an unknown status", { status: "DONE" }],
    ["an unknown scan type", { scanType: "XSS" }],
    ["a missing projectId", { projectId: undefined }],
    ["a missing createdAt", { createdAt: undefined }],
    ["a non-text imageTag", { imageTag: 5 }],
    [
      "a summary that is not numbers",
      { summary: { new: "3", newHigh: 1, stillOpen: 0, fixed: 0 } },
    ],
    ["a summary with a missing count", { summary: { new: 3, newHigh: 1, stillOpen: 0 } }],
    ["a summary that is not an object", { summary: "none" }],
  ])("throws for %s (bad data is a server error)", (_name, change) => {
    expect(() => toScanItem({ ...completedRow, ...change })).toThrow();
  });
});

describe("getScan", () => {
  it("returns the scan for a known job", async () => {
    const getRecord = vi.fn(() => Promise.resolve(completedRow));
    const item = await getScan(JOB_ID, { getRecord });
    expect(item.status).toBe("COMPLETED");
    expect(getRecord).toHaveBeenCalledWith(JOB_ID);
  });

  it("404 for a job that does not exist", async () => {
    await expect(
      getScan(JOB_ID, { getRecord: () => Promise.resolve(undefined) }),
    ).rejects.toMatchObject({
      statusCode: 404,
      message: NOT_FOUND_MESSAGE,
    });
  });

  it("404 for a malformed id, without any database call", async () => {
    const getRecord = vi.fn(() => Promise.resolve(completedRow));
    await expect(getScan("not-a-job-id", { getRecord })).rejects.toMatchObject({
      statusCode: 404,
      message: "Scan not found.",
    });
    expect(getRecord).not.toHaveBeenCalled();
  });

  it("does not hide a database failure", async () => {
    await expect(
      getScan(JOB_ID, { getRecord: () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
  });
});

describe("GET /scans/{jobId} handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    process.env.JOBS_TABLE = "jobs";
    ddb.on(GetCommand).resolves({ Item: { ...completedRow } });
  });

  const get = (jobId: string | null = JOB_ID, authorized = true) =>
    handler(
      makeEvent({
        ...(jobId === null ? {} : { pathParameters: { jobId } }),
        requestContext: {
          authorizer: authorized ? { lambda: { username: "rushikesh", role: "user" } } : undefined,
        } as never,
      }),
    );

  it("200 with the contract shape, and no internal fields", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as Record<string, unknown>;
    expect(body).toEqual(toScanItem(completedRow));
    expect(res.body).not.toContain("taskArn");
    expect(res.body).not.toContain("arn:aws");
  });

  it("is one strongly consistent GetItem by jobId, and nothing else", async () => {
    await get();
    expect(ddb.calls()).toHaveLength(1);
    const input = ddb.commandCalls(GetCommand)[0]?.args[0].input;
    expect(input).toEqual({ TableName: "jobs", Key: { jobId: JOB_ID }, ConsistentRead: true });
  });

  it("404 with the exact contract message when the job does not exist", async () => {
    ddb.on(GetCommand).resolves({});
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body as string)).toEqual({ error: "Scan not found." });
  });

  it("404 for a malformed id or a missing path parameter, with no database call", async () => {
    expect((await get("nope")).statusCode).toBe(404);
    expect((await get(null)).statusCode).toBe(404);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("401 without a caller from the authorizer", async () => {
    expect((await get(JOB_ID, false)).statusCode).toBe(401);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("generic 500 if the job record is malformed", async () => {
    ddb.on(GetCommand).resolves({ Item: { ...completedRow, status: "DONE" } });
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("status");
  });

  it("logs a malformed record with the job id", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ddb.on(GetCommand).resolves({ Item: { ...completedRow, status: "DONE" } });
    await get();
    const logs = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    vi.unstubAllEnvs();
    expect(logs).toContain(JOB_ID);
    expect(logs).toContain("Job record is malformed");
  });
});
