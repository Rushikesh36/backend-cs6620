import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ALLOWED_FROM,
  decodeCursor,
  encodeCursor,
  isFinal,
  transitionJob,
  type JobStatus,
} from "../common/dynamo.js";
import { HttpError } from "../common/errors.js";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());
const client = () => ddb as unknown as DynamoDBDocumentClient;
const failedCondition = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });

describe("status rules", () => {
  it("final states can never be left", () => {
    const all: JobStatus[] = ["CREATED", "QUEUED", "RUNNING", "COMPLETED", "FAILED"];
    for (const to of all) {
      for (const from of ALLOWED_FROM[to]) expect(isFinal(from)).toBe(false);
    }
  });

  it("follows CREATED -> QUEUED -> RUNNING -> final", () => {
    expect(ALLOWED_FROM.QUEUED).toEqual(["CREATED"]);
    expect(ALLOWED_FROM.RUNNING).toEqual(["QUEUED"]);
    expect([...ALLOWED_FROM.COMPLETED].sort()).toEqual(["QUEUED", "RUNNING"]);
    expect([...ALLOWED_FROM.FAILED].sort()).toEqual(["QUEUED", "RUNNING"]);
  });
});

describe("transitionJob", () => {
  it("sends one conditional update and returns true", async () => {
    ddb.on(UpdateCommand).resolves({});
    const ok = await transitionJob(client(), "jobs", "j1", "QUEUED", { queuedAt: "t" });
    expect(ok).toBe(true);

    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.Key).toEqual({ jobId: "j1" });
    expect(input?.ConditionExpression).toBe("attribute_exists(jobId) AND #status IN (:f0)");
    expect(input?.UpdateExpression).toBe("SET #status = :to, #a0 = :a0");
    expect(input?.ExpressionAttributeValues).toMatchObject({
      ":to": "QUEUED",
      ":f0": "CREATED",
      ":a0": "t",
    });
  });

  it("allows both QUEUED and RUNNING before a final state", async () => {
    ddb.on(UpdateCommand).resolves({});
    await transitionJob(client(), "jobs", "j1", "FAILED", { error: "x" });
    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toContain("#status IN (:f0, :f1)");
  });

  it("returns false when the condition fails (missing job or wrong state)", async () => {
    ddb.on(UpdateCommand).rejects(failedCondition());
    expect(await transitionJob(client(), "jobs", "j1", "RUNNING")).toBe(false);
  });

  it("rethrows other errors", async () => {
    ddb.on(UpdateCommand).rejects(new Error("throttled"));
    await expect(transitionJob(client(), "jobs", "j1", "RUNNING")).rejects.toThrow("throttled");
  });

  it("refuses to move to CREATED", async () => {
    await expect(transitionJob(client(), "jobs", "j1", "CREATED")).rejects.toThrow();
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("cursors", () => {
  const keys = ["projectId", "createdAt", "jobId"];
  const key = { projectId: "demo", createdAt: "2026-01-01T00:00:00.000Z", jobId: "j1" };

  it("round-trips and is URL safe", () => {
    const cursor = encodeCursor(key);
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(cursor ?? "", keys)).toEqual(key);
  });

  it("returns null when there is no more data", () => {
    expect(encodeCursor(undefined)).toBeNull();
  });

  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  it.each([
    ["empty", ""],
    ["not base64url", "%%%"],
    ["not json", Buffer.from("nope").toString("base64url")],
    ["an array", b64([1])],
    ["null", b64(null)],
    ["missing key", b64({ projectId: "demo", createdAt: "x" })],
    ["extra key", b64({ ...key, extra: "x" })],
    ["wrong key name", b64({ projectId: "demo", createdAt: "x", other: "y" })],
    ["non-string value", b64({ ...key, jobId: { S: "j1" } })],
    ["too long", "A".repeat(3000)],
  ])("rejects a cursor that is %s with a 400", (_n, cursor) => {
    try {
      decodeCursor(cursor, keys);
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(400);
      return;
    }
    throw new Error("expected a 400");
  });
});
