import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GetObjectCommand, NoSuchKey, S3Client } from "@aws-sdk/client-s3";
import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALLOWED_FROM, type JobStatus } from "../common/dynamo.js";
import type { ScanSummary, StoredFinding } from "../common/findings/diff.js";
import { writeFindingsToTable } from "../common/findings/table.js";
import { handler } from "../lambdas/processor/handler.js";
import {
  exitedWith,
  MAX_REPORT_BYTES,
  NO_REPORT,
  processStoppedTask,
  reportKey,
  type EcsTaskDetail,
  type ProcessorDeps,
} from "../lambdas/processor/processor.js";
import { COULD_NOT_START_MESSAGE } from "../lambdas/start-scan/start-scan.js";
import type { ScanAlert } from "../lambdas/processor/alert.js";

const JOB_1 = "123e4567-e89b-42d3-a456-426614174001";
const JOB_2 = "123e4567-e89b-42d3-a456-426614174002";
const FIXTURES = join(import.meta.dirname, "fixtures");
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture paths
const read = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), "utf8");

/**
 * A Semgrep report the way the scanner wrapper (Task 21) will upload it: free Semgrep writes
 * "requires login" instead of the matched code, so the wrapper fills extra.lines from the source.
 */
function semgrepReport(version: string): string {
  const report = JSON.parse(read("reports", `semgrep-${version}.json`)) as {
    results: {
      path: string;
      start: { line: number };
      end: { line: number };
      extra: { lines: string };
    }[];
  };
  for (const r of report.results) {
    r.extra.lines = read("sample-app", version, r.path)
      .split("\n")
      .slice(r.start.line - 1, r.end.line)
      .join("\n");
  }
  return JSON.stringify(report);
}

const job = (jobId: string, over: Record<string, unknown> = {}) => ({
  jobId,
  projectId: "demo-app",
  scanType: "SAST",
  targetId: null,
  status: "RUNNING",
  requestedBy: "geethanjali",
  imageTag: "semgrep-1.183.0",
  createdAt: "2026-11-08T10:00:00.000Z",
  queuedAt: "2026-11-08T10:00:01.000Z",
  startedAt: "2026-11-08T10:00:05.000Z",
  finishedAt: null,
  summary: null,
  error: null,
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/scans/abc",
  scope: "ALL",
  ...over,
});

const stopped = (
  jobId: string,
  exitCode?: number,
  over: Partial<EcsTaskDetail> = {},
): EcsTaskDetail => ({
  lastStatus: "STOPPED",
  startedBy: jobId,
  stopCode: "EssentialContainerExited",
  containers: [exitCode === undefined ? { name: "scanner" } : { name: "scanner", exitCode }],
  ...over,
});

/** In-memory jobs table, findings table and reports bucket, behaving like the real ones. */
function fakeAws() {
  const jobs = new Map<string, Record<string, unknown>>();
  const findings = new Map<string, Map<string, StoredFinding & { pk: string }>>();
  const reports = new Map<string, string>();
  const alerts: ScanAlert[] = [];
  const transition = (jobId: string, to: JobStatus, extra: Record<string, unknown>) => {
    const record = jobs.get(jobId);
    if (!record || !ALLOWED_FROM[to].includes(record.status as JobStatus)) {
      return Promise.resolve(false);
    }
    jobs.set(jobId, { ...record, status: to, ...extra });
    return Promise.resolve(true);
  };
  const deps: ProcessorDeps = {
    getJob: (jobId) => Promise.resolve(jobs.get(jobId)),
    readReport: (jobId) => Promise.resolve(reports.get(jobId)),
    queryFindings: (pk) =>
      Promise.resolve({
        records: [...(findings.get(pk)?.values() ?? [])].map((r): Record<string, unknown> => ({
          ...r,
        })),
        lastKey: undefined,
      }),
    writeFindings: (pk, rows) => {
      const table = findings.get(pk) ?? new Map<string, StoredFinding & { pk: string }>();
      for (const row of rows) table.set(row.fingerprint, { pk, ...row });
      findings.set(pk, table);
      return Promise.resolve();
    },
    complete: (jobId, summary, finishedAt) =>
      transition(jobId, "COMPLETED", { summary, finishedAt }),
    fail: (jobId, error, finishedAt) => transition(jobId, "FAILED", { error, finishedAt }),
    alert: (alert) => {
      alerts.push(alert);
      return Promise.resolve();
    },
    now: () => new Date("2026-11-08T10:05:00.000Z"),
  };
  return { jobs, findings, reports, alerts, deps };
}

describe("processStoppedTask: successful scans", () => {
  it("first SAST scan: findings stored as NEW, job COMPLETED with the summary", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));

    const outcome = await processStoppedTask(stopped(JOB_1, 0), aws.deps);

    const summary: ScanSummary = { new: 6, newHigh: 4, stillOpen: 0, fixed: 0 };
    expect(outcome).toEqual({
      result: "completed",
      jobId: JOB_1,
      projectId: "demo-app",
      scanType: "SAST",
      summary,
      alerted: true,
    });
    expect(aws.jobs.get(JOB_1)).toMatchObject({
      status: "COMPLETED",
      summary,
      finishedAt: "2026-11-08T10:05:00.000Z",
    });
    const rows = [...(aws.findings.get("demo-app#SAST")?.values() ?? [])];
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row).toMatchObject({ pk: "demo-app#SAST", state: "OPEN", firstSeenJobId: JOB_1 });
    }
  });

  it("second SAST scan: moved bugs STILL_OPEN, fixed bug FIXED, new bug NEW", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    await processStoppedTask(stopped(JOB_1, 0), aws.deps);

    aws.jobs.set(JOB_2, job(JOB_2));
    aws.reports.set(JOB_2, semgrepReport("v2"));
    const outcome = await processStoppedTask(stopped(JOB_2, 0), aws.deps);

    expect(outcome).toMatchObject({
      result: "completed",
      summary: { new: 2, newHigh: 1, stillOpen: 5, fixed: 1 },
    });
    const rows = [...(aws.findings.get("demo-app#SAST")?.values() ?? [])];
    expect(rows).toHaveLength(8);
    const md5 = rows.find((r) => r.ruleId.endsWith("insecure-hash-algorithm-md5"));
    expect(md5).toMatchObject({ state: "FIXED", lastSeenJobId: JOB_1 });
    const sql = rows.find((r) => r.ruleId.endsWith("tainted-sql-string"));
    expect(sql).toMatchObject({
      state: "OPEN",
      firstSeenJobId: JOB_1,
      lastSeenJobId: JOB_2,
      location: "app/views.py:17",
    });
  });

  it("DAST scan: uses the ZAP parser and the DAST key", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1, { scanType: "DAST", targetId: "juice-shop" }));
    aws.reports.set(JOB_1, read("reports", "zap-v1.json"));

    const outcome = await processStoppedTask(stopped(JOB_1, 0), aws.deps);

    expect(outcome).toMatchObject({ result: "completed", summary: { newHigh: 6 } });
    expect(aws.findings.get("demo-app#DAST")?.size).toBe(36);
    expect(aws.findings.has("demo-app#SAST")).toBe(false);
  });

  it("accepts a job that is still QUEUED (the stop event can beat the RUNNING update)", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1, { status: "QUEUED" }));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    expect((await processStoppedTask(stopped(JOB_1, 0), aws.deps)).result).toBe("completed");
  });
});

describe("processStoppedTask: failures use the contract's messages", () => {
  it.each([
    [1, "Scanner exited with code 1"],
    [137, "Scanner exited with code 137"],
  ])("exit code %i: FAILED %s", async (code, message) => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    expect(await processStoppedTask(stopped(JOB_1, code), aws.deps)).toEqual({
      result: "failed",
      jobId: JOB_1,
      error: message,
    });
    expect(aws.jobs.get(JOB_1)).toMatchObject({ status: "FAILED", error: message });
    expect(aws.findings.size).toBe(0);
    expect(exitedWith(code)).toBe(message);
  });

  it("any non-zero container fails the scan", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    const detail = stopped(JOB_1, 0, {
      containers: [
        { name: "scanner", exitCode: 0 },
        { name: "sidecar", exitCode: 2 },
      ],
    });
    expect(await processStoppedTask(detail, aws.deps)).toMatchObject({ error: exitedWith(2) });
  });

  it("no exit code at all (the task never started): Could not start scanner task", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1, { status: "QUEUED" }));
    const detail = stopped(JOB_1, undefined, {
      stopCode: "TaskFailedToStart",
      stoppedReason: "CannotPullContainerError",
    });
    expect(await processStoppedTask(detail, aws.deps)).toMatchObject({
      result: "failed",
      error: COULD_NOT_START_MESSAGE,
    });
  });

  it("exit 0 but no report: No report produced", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    expect(await processStoppedTask(stopped(JOB_1, 0), aws.deps)).toMatchObject({
      error: NO_REPORT,
    });
    expect(aws.jobs.get(JOB_1)).toMatchObject({ status: "FAILED", error: NO_REPORT });
  });

  it.each([
    ["not JSON", "<html>oops</html>"],
    ["JSON of the wrong shape", '{"hello":"world"}'],
  ])("exit 0 but the report is %s: No report produced", async (_label, text) => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, text);
    expect(await processStoppedTask(stopped(JOB_1, 0), aws.deps)).toMatchObject({
      error: NO_REPORT,
    });
    expect(aws.findings.size).toBe(0);
  });
});

describe("processStoppedTask: events it must leave alone", () => {
  it.each([
    ["a task that is not stopped", { lastStatus: "RUNNING" }],
    ["a task without startedBy", { startedBy: undefined }],
    ["a service task (the test app)", { startedBy: "ecs-svc/1234567890" }],
  ])("ignores %s", async (_label, over) => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    const outcome = await processStoppedTask(stopped(JOB_1, 0, over), aws.deps);
    expect(outcome.result).toBe("ignored");
    expect(aws.jobs.get(JOB_1)?.status).toBe("RUNNING");
  });

  it("ignores an unknown job", async () => {
    const aws = fakeAws();
    expect((await processStoppedTask(stopped(JOB_1, 0), aws.deps)).result).toBe("ignored");
  });

  it.each(["COMPLETED", "FAILED"])("skips a job that is already %s", async (status) => {
    const aws = fakeAws();
    aws.jobs.set(
      JOB_1,
      job(JOB_1, { status, error: status === "FAILED" ? "Timed out after 25 minutes" : null }),
    );
    aws.reports.set(JOB_1, semgrepReport("v1"));
    expect(await processStoppedTask(stopped(JOB_1, 0), aws.deps)).toEqual({
      result: "already-final",
      jobId: JOB_1,
    });
    expect(aws.findings.size).toBe(0);
    expect(aws.jobs.get(JOB_1)?.status).toBe(status);
  });

  it("a repeated event changes nothing the second time", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    await processStoppedTask(stopped(JOB_1, 0), aws.deps);
    const after = structuredClone([...(aws.findings.get("demo-app#SAST")?.values() ?? [])]);
    const job1 = structuredClone(aws.jobs.get(JOB_1));

    expect((await processStoppedTask(stopped(JOB_1, 0), aws.deps)).result).toBe("already-final");
    expect([...(aws.findings.get("demo-app#SAST")?.values() ?? [])]).toEqual(after);
    expect(aws.jobs.get(JOB_1)).toEqual(job1);
  });

  it("if another event finished the job first, the summary is not overwritten", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    const deps = { ...aws.deps, complete: () => Promise.resolve(false) };
    expect((await processStoppedTask(stopped(JOB_1, 0), deps)).result).toBe("already-final");
  });

  it("throws (so Lambda retries) on a malformed job record", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1, { status: "DONE" }));
    await expect(processStoppedTask(stopped(JOB_1, 0), aws.deps)).rejects.toThrow();
  });
});

describe("processStoppedTask: new-HIGH alert (Task 24)", () => {
  it("sends one alert when the scan has new HIGH findings", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));

    await processStoppedTask(stopped(JOB_1, 0), aws.deps);

    expect(aws.alerts).toEqual([
      {
        jobId: JOB_1,
        projectId: "demo-app",
        scanType: "SAST",
        summary: { new: 6, newHigh: 4, stillOpen: 0, fixed: 0 },
      },
    ]);
  });

  it("sends nothing when nothing new is HIGH", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.jobs.set(JOB_2, job(JOB_2));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    aws.reports.set(JOB_2, semgrepReport("v1"));
    await processStoppedTask(stopped(JOB_1, 0), aws.deps);
    aws.alerts.length = 0;

    // The same code again: everything is STILL_OPEN, newHigh is 0.
    const outcome = await processStoppedTask(stopped(JOB_2, 0), aws.deps);

    expect(outcome).toMatchObject({ result: "completed", summary: { newHigh: 0 }, alerted: false });
    expect(aws.alerts).toEqual([]);
  });

  it("sends nothing for a failed scan or a repeated event", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.jobs.set(JOB_2, job(JOB_2));
    aws.reports.set(JOB_2, semgrepReport("v1"));

    await processStoppedTask(stopped(JOB_1, 1), aws.deps);
    await processStoppedTask(stopped(JOB_2, 0), aws.deps);
    await processStoppedTask(stopped(JOB_2, 0), aws.deps);

    expect(aws.alerts.map((a) => a.jobId)).toEqual([JOB_2]);
  });

  it("an alert that cannot be sent is logged, and the job stays COMPLETED", async () => {
    const aws = fakeAws();
    aws.jobs.set(JOB_1, job(JOB_1));
    aws.reports.set(JOB_1, semgrepReport("v1"));
    aws.deps.alert = () => Promise.reject(new Error("SNS is down"));

    const outcome = await processStoppedTask(stopped(JOB_1, 0), aws.deps);

    expect(outcome).toMatchObject({ result: "completed", alerted: false });
    expect(aws.jobs.get(JOB_1)).toMatchObject({ status: "COMPLETED" });
    expect(aws.findings.get("demo-app#SAST")?.size).toBe(6);
  });
});

describe("writeFindingsToTable", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  beforeEach(() => ddb.reset());
  const rows = (n: number): StoredFinding[] =>
    Array.from({ length: n }, (_, i) => ({
      fingerprint: String(i).padStart(64, "0"),
      ruleId: "r",
      severity: "LOW",
      location: "a.py:1",
      message: "m",
      state: "OPEN",
      firstSeenJobId: JOB_1,
      lastSeenJobId: JOB_1,
    }));
  const noSleep = () => Promise.resolve();

  it("writes 25 at a time, each with the table key", async () => {
    ddb.on(BatchWriteCommand).resolves({});
    await writeFindingsToTable(ddb as never, "findings", noSleep)("demo-app#SAST", rows(60));
    const calls = ddb.commandCalls(BatchWriteCommand);
    expect(calls.map((c) => c.args[0].input.RequestItems?.findings?.length)).toEqual([25, 25, 10]);
    expect(calls[0]?.args[0].input.RequestItems?.findings?.[0]).toMatchObject({
      PutRequest: { Item: { pk: "demo-app#SAST", ruleId: "r" } },
    });
  });

  it("retries items DynamoDB left unprocessed", async () => {
    const leftover = [{ PutRequest: { Item: { pk: "p", fingerprint: "x" } } }];
    ddb
      .on(BatchWriteCommand)
      .resolvesOnce({ UnprocessedItems: { findings: leftover } })
      .resolves({});
    await writeFindingsToTable(ddb as never, "findings", noSleep)("p", rows(3));
    const calls = ddb.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.args[0].input.RequestItems?.findings).toEqual(leftover);
  });

  it("gives up after 5 attempts instead of looping forever", async () => {
    ddb.on(BatchWriteCommand).resolves({
      UnprocessedItems: { findings: [{ PutRequest: { Item: { pk: "p" } } }] },
    });
    await expect(
      writeFindingsToTable(ddb as never, "findings", noSleep)("p", rows(1)),
    ).rejects.toThrow("throttled");
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(5);
  });

  it("writes nothing for no rows", async () => {
    await writeFindingsToTable(ddb as never, "findings", noSleep)("p", []);
    expect(ddb.calls()).toHaveLength(0);
  });
});

describe("processor handler with the AWS SDK", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const s3 = mockClient(S3Client);
  const sns = mockClient(SNSClient);
  const event = (detail: EcsTaskDetail) =>
    ({ "detail-type": "ECS Task State Change", detail }) as never;

  beforeEach(() => {
    ddb.reset();
    s3.reset();
    sns.reset();
    sns.on(PublishCommand).resolves({ MessageId: "m-1" });
    process.env.ALERTS_TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:demo-alerts";
    process.env.JOBS_TABLE = "jobs";
    process.env.FINDINGS_TABLE = "findings";
    process.env.REPORTS_BUCKET = "reports-bucket";
    ddb.on(GetCommand).resolves({ Item: job(JOB_1) });
    ddb.on(QueryCommand).resolves({ Items: [] });
    ddb.on(BatchWriteCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
  });

  const body = (text: string) => ({ transformToString: () => Promise.resolve(text) }) as never;

  it("reads reports/<jobId>.json, writes findings and moves the job to COMPLETED", async () => {
    const text = semgrepReport("v1");
    s3.on(GetObjectCommand).resolves({ Body: body(text), ContentLength: text.length });

    const outcome = await handler(event(stopped(JOB_1, 0)));

    expect(outcome.result).toBe("completed");
    expect(s3.commandCalls(GetObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: "reports-bucket",
      Key: reportKey(JOB_1),
    });
    expect(ddb.commandCalls(GetCommand)[0]?.args[0].input).toMatchObject({
      TableName: "jobs",
      Key: { jobId: JOB_1 },
    });
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toMatchObject({
      TableName: "findings",
      ExpressionAttributeValues: { ":pk": "demo-app#SAST" },
    });
    expect(ddb.commandCalls(BatchWriteCommand)).toHaveLength(1);
    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ":to": "COMPLETED",
      ":a0": { new: 6, newHigh: 4, stillOpen: 0, fixed: 0 },
    });
    expect(update?.ConditionExpression).toContain("attribute_exists(jobId)");
  });

  it("a missing report object: FAILED No report produced", async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "nope", $metadata: {} }));
    expect(await handler(event(stopped(JOB_1, 0)))).toMatchObject({ error: NO_REPORT });
    expect(
      ddb.commandCalls(UpdateCommand)[0]?.args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ":to": "FAILED",
      ":a0": NO_REPORT,
    });
  });

  it("a report over the size limit is not loaded: FAILED No report produced", async () => {
    const transformToString = vi.fn();
    s3.on(GetObjectCommand).resolves({
      Body: { transformToString } as never,
      ContentLength: MAX_REPORT_BYTES + 1,
    });
    expect(await handler(event(stopped(JOB_1, 0)))).toMatchObject({ error: NO_REPORT });
    expect(transformToString).not.toHaveBeenCalled();
  });

  it("a duplicate event that loses the race leaves the job alone", async () => {
    const text = semgrepReport("v1");
    s3.on(GetObjectCommand).resolves({ Body: body(text), ContentLength: text.length });
    ddb
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "no", $metadata: {} }));
    expect((await handler(event(stopped(JOB_1, 0)))).result).toBe("already-final");
  });

  it("a DynamoDB outage throws, so Lambda retries the event", async () => {
    ddb.on(GetCommand).rejects(new Error("Service unavailable"));
    await expect(handler(event(stopped(JOB_1, 0)))).rejects.toThrow("Service unavailable");
  });

  it("publishes the alert to ALERTS_TOPIC_ARN", async () => {
    const text = semgrepReport("v1");
    s3.on(GetObjectCommand).resolves({ Body: body(text), ContentLength: text.length });

    expect(await handler(event(stopped(JOB_1, 0)))).toMatchObject({ alerted: true });

    const input = sns.commandCalls(PublishCommand)[0]?.args[0].input;
    expect(input?.TopicArn).toBe("arn:aws:sns:us-east-1:123456789012:demo-alerts");
    expect(input?.Subject).toBe("Security Hub: 4 new HIGH findings in demo-app (SAST)");
    expect(input?.Message).toContain(JOB_1);
  });
});
