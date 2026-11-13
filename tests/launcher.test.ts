import { ECSClient, RunTaskCommand } from "@aws-sdk/client-ecs";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import type { SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../lambdas/launcher/handler.js";
import {
  launchScan,
  parseMessage,
  readConfig,
  type LaunchableJob,
  type LaunchDeps,
  type LauncherConfig,
} from "../lambdas/launcher/launcher.js";

const JOB = "123e4567-e89b-42d3-a456-426614174000";
const TASK_ARN = "arn:aws:ecs:us-east-1:123456789012:task/c/abc";

const config: LauncherConfig = {
  clusterArn: "arn:aws:ecs:us-east-1:123456789012:cluster/t-scanners",
  containerName: "scanner",
  taskDefinitions: {
    SAST: { family: "t-semgrep", imageTag: "1.183.0-1" },
    DAST: { family: "t-zap", imageTag: "2.17.0-1" },
  },
  subnetIds: ["subnet-a"],
  securityGroupId: "sg-1",
  targetUrls: { "juice-shop": "http://juice.internal:3000" },
};

const job = (over: Partial<LaunchableJob> = {}): LaunchableJob => ({
  scanType: "SAST",
  targetId: null,
  status: "QUEUED",
  ...over,
});

function deps(over: Partial<LaunchDeps> = {}, j: LaunchableJob | null = job()) {
  return {
    getJob: vi.fn<LaunchDeps["getJob"]>(() => Promise.resolve(j ?? undefined)),
    markRunning: vi.fn<LaunchDeps["markRunning"]>(() => Promise.resolve(true)),
    markFailed: vi.fn<LaunchDeps["markFailed"]>(() => Promise.resolve(true)),
    runTask: vi.fn<LaunchDeps["runTask"]>(() => Promise.resolve(TASK_ARN)),
    saveTaskArn: vi.fn<LaunchDeps["saveTaskArn"]>(() => Promise.resolve()),
    now: () => new Date("2026-11-12T10:00:00.000Z"),
    ...over,
  };
}

describe("parseMessage", () => {
  it("reads the job id and ignores everything else", () => {
    expect(parseMessage(JSON.stringify({ jobId: JOB, scanType: "DAST", x: 1 }))).toEqual({
      jobId: JOB,
    });
  });
  it.each(["not json", "null", "[]", "{}", '{"jobId":5}', '{"jobId":"../x"}', ""])(
    "rejects %j",
    (body) => {
      expect(parseMessage(body)).toBeUndefined();
    },
  );
});

describe("launchScan", () => {
  it("SAST: marks RUNNING first, starts the task with only JOB_ID, saves the ARN", async () => {
    const order: string[] = [];
    const d = deps({
      markRunning: vi.fn(() => {
        order.push("markRunning");
        return Promise.resolve(true);
      }),
      runTask: vi.fn(() => {
        order.push("runTask");
        return Promise.resolve(TASK_ARN);
      }),
    });
    expect(await launchScan(JOB, config, d)).toEqual({ outcome: "launched", taskArn: TASK_ARN });
    expect(d.markRunning).toHaveBeenCalledWith(JOB, "2026-11-12T10:00:00.000Z", "1.183.0-1");
    expect(d.runTask).toHaveBeenCalledWith({
      jobId: JOB,
      family: "t-semgrep",
      environment: [{ name: "JOB_ID", value: JOB }],
    });
    expect(d.saveTaskArn).toHaveBeenCalledWith(JOB, TASK_ARN);
    expect(d.markFailed).not.toHaveBeenCalled();
    expect(order).toEqual(["markRunning", "runTask"]);
  });

  it("DAST: adds the real target URL for the job's targetId", async () => {
    const d = deps({}, job({ scanType: "DAST", targetId: "juice-shop" }));
    await launchScan(JOB, config, d);
    expect(d.runTask).toHaveBeenCalledWith({
      jobId: JOB,
      family: "t-zap",
      environment: [
        { name: "JOB_ID", value: JOB },
        { name: "TARGET_URL", value: "http://juice.internal:3000" },
      ],
    });
    expect(d.markRunning).toHaveBeenCalledWith(JOB, expect.any(String), "2.17.0-1");
  });

  it("DAST with a target that has no URL fails the job and starts nothing", async () => {
    const d = deps({}, job({ scanType: "DAST", targetId: "gone" }));
    expect(await launchScan(JOB, config, d)).toEqual({ outcome: "failed" });
    expect(d.markFailed).toHaveBeenCalledWith(
      JOB,
      "Could not start scanner task",
      "2026-11-12T10:00:00.000Z",
    );
    expect(d.runTask).not.toHaveBeenCalled();
  });

  it("a duplicate delivery (not QUEUED any more) is dropped without starting a task", async () => {
    const d = deps({ markRunning: vi.fn(() => Promise.resolve(false)) });
    expect(await launchScan(JOB, config, d)).toEqual({
      outcome: "discarded",
      reason: "not queued",
    });
    expect(d.runTask).not.toHaveBeenCalled();
    expect(d.markFailed).not.toHaveBeenCalled();
  });

  it("an unknown job is dropped", async () => {
    const d = deps({}, null);
    expect(await launchScan(JOB, config, d)).toEqual({
      outcome: "discarded",
      reason: "unknown job",
    });
    expect(d.markRunning).not.toHaveBeenCalled();
  });

  it("a job with a bad scan type is dropped", async () => {
    const d = deps({}, job({ scanType: "XSS" as never }));
    expect(await launchScan(JOB, config, d)).toEqual({
      outcome: "discarded",
      reason: "bad scan type",
    });
    expect(d.markRunning).not.toHaveBeenCalled();
  });

  it("RunTask failing fails the job with the contract message, and is not retried", async () => {
    const d = deps({ runTask: vi.fn(() => Promise.reject(new Error("no capacity"))) });
    expect(await launchScan(JOB, config, d)).toEqual({ outcome: "failed" });
    expect(d.markFailed).toHaveBeenCalledWith(
      JOB,
      "Could not start scanner task",
      "2026-11-12T10:00:00.000Z",
    );
    expect(d.saveTaskArn).not.toHaveBeenCalled();
  });

  it("failing to save the ARN does not fail a task that is running", async () => {
    const d = deps({ saveTaskArn: vi.fn(() => Promise.reject(new Error("throttled"))) });
    expect(await launchScan(JOB, config, d)).toEqual({ outcome: "launched", taskArn: TASK_ARN });
    expect(d.markFailed).not.toHaveBeenCalled();
  });

  it("a database error is thrown, so the message is retried", async () => {
    const d = deps({ markRunning: vi.fn(() => Promise.reject(new Error("boom"))) });
    await expect(launchScan(JOB, config, d)).rejects.toThrow("boom");
    expect(d.runTask).not.toHaveBeenCalled();
  });
});

describe("readConfig", () => {
  const base: Record<string, string> = {
    CLUSTER_ARN: config.clusterArn,
    CONTAINER_NAME: "scanner",
    SUBNET_IDS: "subnet-a,subnet-b",
    SECURITY_GROUP_ID: "sg-1",
    TASK_DEFINITIONS_JSON: JSON.stringify(config.taskDefinitions),
    TARGET_URLS_JSON: JSON.stringify(config.targetUrls),
  };
  const env = (e: Record<string, string>) => (n: string) => {
    const v = e[n];
    if (v === undefined) throw new Error(`Missing environment variable ${n}`);
    return v;
  };

  it("builds the config", () => {
    expect(readConfig(env(base))).toEqual({ ...config, subnetIds: ["subnet-a", "subnet-b"] });
  });
  it("rejects bad JSON and missing scan types", () => {
    expect(() => readConfig(env({ ...base, TARGET_URLS_JSON: "{" }))).toThrow(/not valid JSON/);
    expect(() => readConfig(env({ ...base, TARGET_URLS_JSON: "[]" }))).toThrow(/must be an object/);
    expect(() =>
      readConfig(
        env({
          ...base,
          TASK_DEFINITIONS_JSON: JSON.stringify({ SAST: config.taskDefinitions.SAST }),
        }),
      ),
    ).toThrow(/DAST/);
  });
});

describe("launcher handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const ecs = mockClient(ECSClient);
  const queued = { jobId: JOB, scanType: "SAST", targetId: null, status: "QUEUED" };

  const sqs = (...bodies: string[]): SQSEvent => ({
    Records: bodies.map((body, i) => ({ messageId: `m${String(i)}`, body })) as never,
  });
  const msg = JSON.stringify({ jobId: JOB, scanType: "SAST" });

  beforeEach(() => {
    ddb.reset();
    ecs.reset();
    process.env.JOBS_TABLE = "jobs";
    process.env.CLUSTER_ARN = config.clusterArn;
    process.env.CONTAINER_NAME = "scanner";
    process.env.SUBNET_IDS = "subnet-a,subnet-b";
    process.env.SECURITY_GROUP_ID = "sg-1";
    process.env.TASK_DEFINITIONS_JSON = JSON.stringify(config.taskDefinitions);
    process.env.TARGET_URLS_JSON = JSON.stringify(config.targetUrls);
    ddb.on(GetCommand).resolves({ Item: queued });
    ddb.on(UpdateCommand).resolves({});
    ecs.on(RunTaskCommand).resolves({ tasks: [{ taskArn: TASK_ARN }] });
  });

  it("starts the task exactly as docs/scanners.md describes", async () => {
    expect(await handler(sqs(msg))).toEqual({ batchItemFailures: [] });
    expect(ecs.commandCalls(RunTaskCommand)[0]?.args[0].input).toEqual({
      cluster: config.clusterArn,
      launchType: "FARGATE",
      count: 1,
      taskDefinition: "t-semgrep",
      startedBy: JOB,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: ["subnet-a", "subnet-b"],
          securityGroups: ["sg-1"],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [{ name: "scanner", environment: [{ name: "JOB_ID", value: JOB }] }],
      },
    });
    const updates = ddb.commandCalls(UpdateCommand).map((c) => c.args[0].input);
    expect(updates[0]?.ConditionExpression).toContain("#status IN");
    expect(updates[0]?.ExpressionAttributeValues).toMatchObject({
      ":to": "RUNNING",
      ":f0": "QUEUED",
    });
    expect(updates[1]?.ExpressionAttributeValues).toEqual({ ":t": TASK_ARN });
  });

  it("a duplicate delivery starts nothing and is not reported as a failure", async () => {
    ddb
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    expect(await handler(sqs(msg))).toEqual({ batchItemFailures: [] });
    expect(ecs.commandCalls(RunTaskCommand)).toHaveLength(0);
  });

  it("RunTask returning only failures fails the job, with no retry", async () => {
    ecs.on(RunTaskCommand).resolves({ tasks: [], failures: [{ reason: "RESOURCE:FARGATE" }] });
    expect(await handler(sqs(msg))).toEqual({ batchItemFailures: [] });
    const failed = ddb
      .commandCalls(UpdateCommand)
      .map((c) => c.args[0].input.ExpressionAttributeValues);
    expect(failed.at(-1)).toMatchObject({ ":to": "FAILED", ":a0": "Could not start scanner task" });
  });

  it("a malformed message is dropped, a DynamoDB error is reported for retry", async () => {
    expect(await handler(sqs("not json"))).toEqual({ batchItemFailures: [] });
    ddb.on(GetCommand).rejects(new Error("throttled"));
    expect(await handler(sqs(msg))).toEqual({ batchItemFailures: [{ itemIdentifier: "m0" }] });
  });

  it("one bad message does not stop the others in the batch", async () => {
    ddb.on(GetCommand).rejectsOnce(new Error("throttled")).resolves({ Item: queued });
    const res = await handler(sqs(msg, msg));
    expect(res).toEqual({ batchItemFailures: [{ itemIdentifier: "m0" }] });
    expect(ecs.commandCalls(RunTaskCommand)).toHaveLength(1);
  });
});
