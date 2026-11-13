import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decodeCursor, encodeCursor } from "../common/dynamo.js";
import { handler } from "../lambdas/list-recent-scans/handler.js";
import {
  CURSOR_KEYS,
  listRecentScans,
  type ListRecentScansDeps,
} from "../lambdas/list-recent-scans/list-recent-scans.js";
import { makeEvent } from "./helpers.js";

const row = (n: number, over: Record<string, unknown> = {}) => ({
  jobId: `123e4567-e89b-42d3-a456-42661417400${String(n)}`,
  projectId: n % 2 === 0 ? "demo-app" : "other-app",
  scanType: "SAST",
  targetId: null,
  status: "COMPLETED",
  requestedBy: "rushikesh",
  imageTag: null,
  createdAt: `2026-11-05T10:0${String(n)}:00.000Z`,
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/c/abc",
  scope: "ALL",
  ...over,
});

const keyOf = (r: ReturnType<typeof row>) => ({
  jobId: r.jobId,
  scope: r.scope,
  createdAt: r.createdAt,
});

function deps(
  records: Record<string, unknown>[] = [],
  lastKey?: Record<string, unknown>,
): {
  d: ListRecentScansDeps;
  queryPage: ReturnType<typeof vi.fn<ListRecentScansDeps["queryPage"]>>;
} {
  const queryPage = vi.fn<ListRecentScansDeps["queryPage"]>(() =>
    Promise.resolve({ records, lastKey }),
  );
  return { d: { queryPage }, queryPage };
}

const statusOf = async (p: () => Promise<unknown>): Promise<number> => {
  try {
    await p();
    return 200;
  } catch (e) {
    return (e as { statusCode: number }).statusCode;
  }
};

describe("listRecentScans", () => {
  it("returns contract-shaped items from all projects, with no internal fields", async () => {
    const { d } = deps([row(2), row(1)]);
    const r = await listRecentScans(undefined, undefined, d);
    expect(r.items.map((i) => i.projectId)).toEqual(["demo-app", "other-app"]);
    expect(r.nextCursor).toBeNull();
    expect(JSON.stringify(r)).not.toContain("taskArn");
    expect(r.items[0]).not.toHaveProperty("scope");
  });

  it("no scans gives an empty list", async () => {
    const { d } = deps([]);
    expect(await listRecentScans(undefined, undefined, d)).toEqual({ items: [], nextCursor: null });
  });

  it("uses the default limit of 20 and passes a chosen limit through", async () => {
    const a = deps();
    await listRecentScans(undefined, undefined, a.d);
    expect(a.queryPage).toHaveBeenCalledWith(20, undefined);
    const b = deps();
    await listRecentScans("100", undefined, b.d);
    expect(b.queryPage).toHaveBeenCalledWith(100, undefined);
  });

  it.each(["0", "101", "-1", "abc", "1.5", "", "99999"])("400 for limit=%j", async (limit) => {
    const { d, queryPage } = deps();
    expect(await statusOf(() => listRecentScans(limit, undefined, d))).toBe(400);
    expect(queryPage).not.toHaveBeenCalled();
  });

  it("returns an opaque cursor, and accepts it back for the next page", async () => {
    const last = keyOf(row(1));
    const first = deps([row(2), row(1)], last);
    const page1 = await listRecentScans("2", undefined, first.d);
    expect(decodeCursor(page1.nextCursor as string, CURSOR_KEYS)).toEqual(last);

    const second = deps([row(0)]);
    const page2 = await listRecentScans("2", page1.nextCursor as string, second.d);
    expect(second.queryPage).toHaveBeenCalledWith(2, last);
    expect(page2.nextCursor).toBeNull();
  });

  it.each([
    ["not base64url", "!!!"],
    ["not JSON", Buffer.from("hello").toString("base64url")],
    ["a JSON array", Buffer.from("[]").toString("base64url")],
    ["wrong keys", encodeCursor({ jobId: "x" }) as string],
    ["a byProject cursor", encodeCursor({ jobId: "x", projectId: "p", createdAt: "t" }) as string],
    ["an extra key", encodeCursor({ ...keyOf(row(1)), extra: "x" }) as string],
    ["non-text values", encodeCursor({ jobId: 1, scope: "ALL", createdAt: "x" }) as string],
    ["too long", "a".repeat(3000)],
    ["empty", ""],
  ])("400 for a cursor that is %s", async (_name, cursor) => {
    const { d, queryPage } = deps();
    expect(await statusOf(() => listRecentScans(undefined, cursor, d))).toBe(400);
    expect(queryPage).not.toHaveBeenCalled();
  });

  it("does not hide a database failure", async () => {
    await expect(
      listRecentScans(undefined, undefined, { queryPage: () => Promise.reject(new Error("boom")) }),
    ).rejects.toThrow("boom");
  });

  it("a malformed record is a server error, not a partial list", async () => {
    const { d } = deps([row(1), row(2, { status: "DONE" })]);
    await expect(listRecentScans(undefined, undefined, d)).rejects.toThrow();
  });
});

describe("GET /scans handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    process.env.JOBS_TABLE = "jobs";
    ddb.on(QueryCommand).resolves({ Items: [row(2), row(1)] });
  });

  const get = (query?: Record<string, string>, authorized = true) =>
    handler(
      makeEvent({
        ...(query ? { queryStringParameters: query } : {}),
        requestContext: {
          authorizer: authorized ? { lambda: { username: "rushikesh", role: "user" } } : undefined,
        } as never,
      }),
    );

  it("200 with items and nextCursor null on the last page", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as { items: unknown[]; nextCursor: unknown };
    expect(body.items).toHaveLength(2);
    expect(body.nextCursor).toBeNull();
    expect(res.body).not.toContain("taskArn");
  });

  it("queries byCreated with scope ALL, newest first, and nothing else", async () => {
    await get({ limit: "5" });
    expect(ddb.calls()).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: "jobs",
      IndexName: "byCreated",
      KeyConditionExpression: "scope = :s",
      ExpressionAttributeValues: { ":s": "ALL" },
      ScanIndexForward: false,
      Limit: 5,
    });
  });

  it("a full page returns a cursor, which is sent back as ExclusiveStartKey", async () => {
    const last = keyOf(row(1));
    ddb.on(QueryCommand).resolvesOnce({ Items: [row(2), row(1)], LastEvaluatedKey: last });
    const first = JSON.parse((await get({ limit: "2" })).body as string) as { nextCursor: string };
    expect(first.nextCursor).toEqual(expect.any(String));

    await get({ limit: "2", cursor: first.nextCursor });
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual(last);
  });

  it("200 and an empty list when there are no scans", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ items: [], nextCursor: null });
  });

  it("400 for a bad limit or cursor, with the error shape and no database call", async () => {
    const a = await get({ limit: "500" });
    expect(a.statusCode).toBe(400);
    expect(JSON.parse(a.body as string)).toHaveProperty("error");
    expect((await get({ cursor: "garbage!" })).statusCode).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("401 without a caller from the authorizer", async () => {
    expect((await get(undefined, false)).statusCode).toBe(401);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("generic 500 if a record is malformed", async () => {
    ddb.on(QueryCommand).resolves({ Items: [row(1, { scanType: "XSS" })] });
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("XSS");
  });
});
