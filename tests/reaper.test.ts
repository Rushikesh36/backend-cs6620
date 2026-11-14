import { ECSClient, ListTasksCommand, StopTaskCommand } from "@aws-sdk/client-ecs";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handler } from "../lambdas/reaper/handler.js";
import {
  reapStuckJobs,
  STUCK_AFTER_MINUTES,
  TIMED_OUT_MESSAGE,
  type ReaperDeps,
  type StuckStatus,
} from "../lambdas/reaper/reaper.js";

const NOW = new Date("2026-11-12T10:00:00.000Z");
const minutesAgo = (m: number, extraMs = 0): string =>
  new Date(NOW.getTime() - m * 60_000 - extraMs).toISOString();
const JOB_1 = "123e4567-e89b-42d3-a456-426614174001";
const JOB_2 = "123e4567-e89b-42d3-a456-426614174002";
const TASK_ARN = "arn:aws:ecs:us-east-1:123456789012:task/t-scanners/abc";
const CLUSTER = "arn:aws:ecs:us-east-1:123456789012:cluster/t-scanners";

type Row = Record<string, unknown>;
const running = (jobId: string, over: Row = {}): Row => ({
  jobId,
  status: "RUNNING",
  createdAt: minutesAgo(40),
  queuedAt: minutesAgo(39),
  startedAt: minutesAgo(30),
  taskArn: TASK_ARN,
  ...over,
});
const queued = (jobId: string, over: Row = {}): Row => ({
  jobId,
  status: "QUEUED",
  createdAt: minutesAgo(40),
  queuedAt: minutesAgo(30),
  startedAt: null,
  ...over,
});

function setup(rows: Partial<Record<StuckStatus, Row[]>> = {}, over: Partial<ReaperDeps> = {}) {
  const listOlderThan = vi.fn<ReaperDeps["listOlderThan"]>((status) =>
    Promise.resolve(rows[status] ?? []),
  );
  const markFailed = vi.fn<ReaperDeps["markFailed"]>(() => Promise.resolve(true));
  const findTaskArn = vi.fn<ReaperDeps["findTaskArn"]>(() => Promise.resolve(undefined));
  const stopTask = vi.fn<ReaperDeps["stopTask"]>(() => Promise.resolve());
  const deps: ReaperDeps = {
    listOlderThan,
    markFailed,
    findTaskArn,
    stopTask,
    now: () => NOW,
    ...over,
  };
  return { deps, listOlderThan, markFailed, findTaskArn, stopTask };
}

describe("the contract message", () => {
  it("is exactly 'Timed out after 25 minutes'", () => {
    expect(STUCK_AFTER_MINUTES).toBe(25);
    expect(TIMED_OUT_MESSAGE).toBe("Timed out after 25 minutes");
  });
});

describe("reapStuckJobs", () => {
  it("asks the index for both statuses, using a cutoff 25 minutes ago", async () => {
    const { deps, listOlderThan } = setup();
    await reapStuckJobs(deps);
    expect(listOlderThan.mock.calls).toEqual([
      ["QUEUED", minutesAgo(25)],
      ["RUNNING", minutesAgo(25)],
    ]);
  });

  it("fails a stuck RUNNING job with the contract message, then stops its task", async () => {
    const { deps, markFailed, stopTask, findTaskArn } = setup({ RUNNING: [running(JOB_1)] });
    const summary = await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledWith(JOB_1, "Timed out after 25 minutes", NOW.toISOString());
    expect(stopTask).toHaveBeenCalledWith(TASK_ARN, "Timed out after 25 minutes");
    expect(findTaskArn).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, failed: 1, stopped: 1, skipped: 0, errors: 0 });
  });

  it("marks the job FAILED before it stops the task", async () => {
    const order: string[] = [];
    const { deps } = setup(
      { RUNNING: [running(JOB_1)] },
      {
        markFailed: () => {
          order.push("failed");
          return Promise.resolve(true);
        },
        stopTask: () => {
          order.push("stop");
          return Promise.resolve();
        },
      },
    );
    await reapStuckJobs(deps);
    expect(order).toEqual(["failed", "stop"]);
  });

  it("fails a stuck QUEUED job and looks for no task, because none exists yet", async () => {
    const { deps, markFailed, stopTask, findTaskArn } = setup({ QUEUED: [queued(JOB_1)] });
    const summary = await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledWith(JOB_1, TIMED_OUT_MESSAGE, NOW.toISOString());
    expect(findTaskArn).not.toHaveBeenCalled();
    expect(stopTask).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, failed: 1, stopped: 0, skipped: 0, errors: 0 });
  });

  it("measures RUNNING from startedAt, not createdAt", async () => {
    const { deps, markFailed } = setup({
      RUNNING: [running(JOB_1, { startedAt: minutesAgo(10) })],
    });
    const summary = await reapStuckJobs(deps);
    expect(markFailed).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ checked: 1, failed: 0, skipped: 1 });
  });

  it("measures QUEUED from queuedAt, not createdAt", async () => {
    const { deps, markFailed } = setup({ QUEUED: [queued(JOB_1, { queuedAt: minutesAgo(5) })] });
    await reapStuckJobs(deps);
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("exactly 25 minutes is not stuck yet, one millisecond more is", async () => {
    const edge = setup({ RUNNING: [running(JOB_1, { startedAt: minutesAgo(25) })] });
    await reapStuckJobs(edge.deps);
    expect(edge.markFailed).not.toHaveBeenCalled();

    const over = setup({ RUNNING: [running(JOB_1, { startedAt: minutesAgo(25, 1) })] });
    await reapStuckJobs(over.deps);
    expect(over.markFailed).toHaveBeenCalledTimes(1);
  });

  it("falls back to createdAt when the entered-state time is missing", async () => {
    const { deps, markFailed } = setup({
      RUNNING: [running(JOB_1, { startedAt: null, createdAt: minutesAgo(60) })],
    });
    await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledTimes(1);
  });

  it("finds the task through startedBy when the job has no taskArn", async () => {
    const findTaskArn = vi.fn<ReaperDeps["findTaskArn"]>(() => Promise.resolve(TASK_ARN));
    const { deps, stopTask } = setup(
      { RUNNING: [running(JOB_1, { taskArn: undefined })] },
      { findTaskArn },
    );
    const summary = await reapStuckJobs(deps);
    expect(findTaskArn).toHaveBeenCalledWith(JOB_1);
    expect(stopTask).toHaveBeenCalledWith(TASK_ARN, TIMED_OUT_MESSAGE);
    expect(summary.stopped).toBe(1);
  });

  it("still fails the job when no running task is found", async () => {
    const { deps, markFailed, findTaskArn, stopTask } = setup({
      RUNNING: [running(JOB_1, { taskArn: undefined })],
    });
    const summary = await reapStuckJobs(deps);
    expect(findTaskArn).toHaveBeenCalledWith(JOB_1);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(stopTask).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ failed: 1, stopped: 0, errors: 0 });
  });

  it("leaves a job alone, and stops no task, when it finished while the reaper looked", async () => {
    const { deps, stopTask } = setup(
      { RUNNING: [running(JOB_1)] },
      { markFailed: () => Promise.resolve(false) },
    );
    const summary = await reapStuckJobs(deps);
    expect(stopTask).not.toHaveBeenCalled();
    expect(summary).toEqual({ checked: 1, failed: 0, stopped: 0, skipped: 1, errors: 0 });
  });

  it("keeps the FAILED job when the task cannot be stopped (not an error)", async () => {
    const { deps, markFailed } = setup(
      { RUNNING: [running(JOB_1)] },
      { stopTask: () => Promise.reject(new Error("task already stopped")) },
    );
    const summary = await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(summary).toEqual({ checked: 1, failed: 1, stopped: 0, skipped: 0, errors: 0 });
  });

  it("one job that errors does not stop the others", async () => {
    const markFailed = vi.fn<ReaperDeps["markFailed"]>((jobId) =>
      jobId === JOB_1 ? Promise.reject(new Error("boom")) : Promise.resolve(true),
    );
    const { deps } = setup({ RUNNING: [running(JOB_1), running(JOB_2)] }, { markFailed });
    const summary = await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledTimes(2);
    expect(summary).toEqual({ checked: 2, failed: 1, stopped: 1, skipped: 0, errors: 1 });
  });

  it("counts a record with a bad jobId or no usable time as an error and moves on", async () => {
    const { deps, markFailed } = setup({
      RUNNING: [
        running("../x"),
        running(JOB_1, { startedAt: "garbage", createdAt: "garbage" }),
        running(JOB_2),
      ],
    });
    const summary = await reapStuckJobs(deps);
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith(JOB_2, TIMED_OUT_MESSAGE, NOW.toISOString());
    expect(summary).toMatchObject({ checked: 3, failed: 1, errors: 2 });
  });

  it("does nothing when nothing is stuck", async () => {
    const { deps, markFailed } = setup();
    expect(await reapStuckJobs(deps)).toEqual({
      checked: 0,
      failed: 0,
      stopped: 0,
      skipped: 0,
      errors: 0,
    });
    expect(markFailed).not.toHaveBeenCalled();
  });

  it("a failing index query stops the run, so the error is not hidden", async () => {
    const { deps } = setup({}, { listOlderThan: () => Promise.reject(new Error("db down")) });
    await expect(reapStuckJobs(deps)).rejects.toThrow("db down");
  });
});

describe("reaper handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const ecs = mockClient(ECSClient);

  beforeEach(() => {
    ddb.reset();
    ecs.reset();
    process.env.JOBS_TABLE = "jobs";
    process.env.CLUSTER_ARN = CLUSTER;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ":s": "RUNNING" } as never }).resolves({
      Items: [running(JOB_1)],
    });
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ":s": "QUEUED" } as never }).resolves({
      Items: [],
    });
    ddb.on(UpdateCommand).resolves({});
    ecs.on(StopTaskCommand).resolves({});
    return () => {
      vi.useRealTimers();
    };
  });

  it("queries the byStatus index with a status and a createdAt cutoff", async () => {
    await handler();
    const queries = ddb.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      TableName: "jobs",
      IndexName: "byStatus",
      KeyConditionExpression: "#status = :s AND createdAt <= :c",
      ExpressionAttributeValues: { ":s": "QUEUED", ":c": minutesAgo(25) },
    });
  });

  it("marks the job FAILED in one conditional write, then stops its task", async () => {
    const summary = await handler();
    const update = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(update?.Key).toEqual({ jobId: JOB_1 });
    expect(update?.ConditionExpression).toContain("#status IN");
    expect(update?.ExpressionAttributeValues).toMatchObject({
      ":to": "FAILED",
      ":a0": "Timed out after 25 minutes",
    });
    expect(ecs.commandCalls(StopTaskCommand)[0]?.args[0].input).toEqual({
      cluster: CLUSTER,
      task: TASK_ARN,
      reason: "Timed out after 25 minutes",
    });
    expect(summary).toMatchObject({ failed: 1, stopped: 1, errors: 0 });
  });

  it("looks the task up by startedBy when the job has no taskArn", async () => {
    ddb.on(QueryCommand, { ExpressionAttributeValues: { ":s": "RUNNING" } as never }).resolves({
      Items: [running(JOB_1, { taskArn: undefined })],
    });
    ecs.on(ListTasksCommand).resolves({ taskArns: [TASK_ARN] });
    await handler();
    expect(ecs.commandCalls(ListTasksCommand)[0]?.args[0].input).toEqual({
      cluster: CLUSTER,
      startedBy: JOB_1,
    });
    expect(ecs.commandCalls(StopTaskCommand)).toHaveLength(1);
  });

  it("stops no task for a job that already finished (the conditional write refuses)", async () => {
    ddb
      .on(UpdateCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    const summary = await handler();
    expect(ecs.commandCalls(StopTaskCommand)).toHaveLength(0);
    expect(summary).toMatchObject({ failed: 0, skipped: 1, errors: 0 });
  });

  it("follows every page of the index", async () => {
    ddb
      .on(QueryCommand, { ExpressionAttributeValues: { ":s": "RUNNING" } as never })
      .resolvesOnce({ Items: [running(JOB_1)], LastEvaluatedKey: { jobId: JOB_1 } })
      .resolvesOnce({ Items: [running(JOB_2)] });
    const summary = await handler();
    expect(summary.checked).toBe(2);
    const second = ddb.commandCalls(QueryCommand)[2]?.args[0].input;
    expect(second?.ExclusiveStartKey).toEqual({ jobId: JOB_1 });
  });

  it("fails the run when a job could not be handled, so the error shows up", async () => {
    ddb.on(UpdateCommand).rejects(new Error("throttled"));
    await expect(handler()).rejects.toThrow("Reaper could not handle 1 job(s)");
  });
});
