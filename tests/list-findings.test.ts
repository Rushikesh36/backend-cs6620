import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { diffFindings } from "../common/findings/diff.js";
import { findingsKey, toFindingItem } from "../common/findings/table.js";
import { handler } from "../lambdas/list-findings/handler.js";
import { listFindings, type ListFindingsDeps } from "../lambdas/list-findings/list-findings.js";
import { makeEvent } from "./helpers.js";

const fp = (n: number) => String(n).padStart(64, "a");

/** A row as the processor (Task 19) will store it: the contract's fields plus the table key. */
const row = (n: number, over: Record<string, unknown> = {}) => ({
  pk: "demo-app#SAST",
  fingerprint: fp(n),
  ruleId: "python.lang.security.audit.eval-injection",
  severity: "HIGH",
  location: `app/views.py:${String(n)}`,
  message: "Eval with user input.",
  state: "OPEN",
  firstSeenJobId: "123e4567-e89b-42d3-a456-426614174001",
  lastSeenJobId: "123e4567-e89b-42d3-a456-426614174002",
  ...over,
});

const CONTRACT_FIELDS = [
  "fingerprint",
  "firstSeenJobId",
  "lastSeenJobId",
  "location",
  "message",
  "ruleId",
  "severity",
  "state",
];

describe("findingsKey", () => {
  it("is projectId#scanType, as in docs/data-model.md", () => {
    expect(findingsKey("demo-app", "SAST")).toBe("demo-app#SAST");
    expect(findingsKey("demo-app", "DAST")).toBe("demo-app#DAST");
  });
});

describe("toFindingItem", () => {
  it("returns exactly the contract fields and drops the table key", () => {
    const item = toFindingItem(row(1));
    expect(Object.keys(item).sort()).toEqual(CONTRACT_FIELDS);
    expect(item).not.toHaveProperty("pk");
  });

  it("reads back exactly what the diff engine (Task 16) produces", () => {
    const { changes } = diffFindings(
      [],
      [{ fingerprint: fp(1), ruleId: "r", severity: "LOW", location: "a.py:1", message: "m" }],
      "job-1",
    );
    const stored = changes.map((c) => ({ pk: "demo-app#SAST", ...c.row }));
    expect(stored.map(toFindingItem)).toEqual(changes.map((c) => c.row));
  });

  it.each(["HIGH", "MEDIUM", "LOW", "INFO"])("accepts severity %s", (severity) => {
    expect(toFindingItem(row(1, { severity })).severity).toBe(severity);
  });

  it("accepts a FIXED finding", () => {
    expect(toFindingItem(row(1, { state: "FIXED" })).state).toBe("FIXED");
  });

  it.each([
    ["an unknown severity", { severity: "CRITICAL" }],
    ["an unknown state", { state: "CLOSED" }],
    ["a missing message", { message: undefined }],
    ["a non-string location", { location: 42 }],
    ["a null fingerprint", { fingerprint: null }],
  ])("rejects %s", (_label, over) => {
    expect(() => toFindingItem(row(1, over))).toThrow();
  });
});

function deps(
  ...pages: { records: Record<string, unknown>[]; lastKey?: Record<string, unknown> }[]
) {
  const calls: { pk: string; startKey: Record<string, unknown> | undefined }[] = [];
  let i = 0;
  const queryPage: ListFindingsDeps["queryPage"] = (pk, startKey) => {
    calls.push({ pk, startKey });
    const page = pages[i++] ?? { records: [] };
    return Promise.resolve({ records: page.records, lastKey: page.lastKey });
  };
  return { deps: { queryPage }, calls };
}

const status = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 200;
  } catch (e) {
    return (e as { statusCode?: number }).statusCode ?? 500;
  }
};

describe("listFindings", () => {
  it("returns every finding for the project and scan type", async () => {
    const { deps: d, calls } = deps({ records: [row(1), row(2, { state: "FIXED" })] });
    const result = await listFindings("demo-app", "SAST", d);
    expect(result.items).toHaveLength(2);
    expect(result.items[1]?.state).toBe("FIXED");
    expect(calls).toEqual([{ pk: "demo-app#SAST", startKey: undefined }]);
  });

  it("follows DynamoDB pages until the end, in order", async () => {
    const k1 = { pk: "demo-app#SAST", fingerprint: fp(2) };
    const k2 = { pk: "demo-app#SAST", fingerprint: fp(3) };
    const { deps: d, calls } = deps(
      { records: [row(1), row(2)], lastKey: k1 },
      { records: [row(3)], lastKey: k2 },
      { records: [row(4)] },
    );
    const result = await listFindings("demo-app", "SAST", d);
    expect(result.items.map((f) => f.fingerprint)).toEqual([fp(1), fp(2), fp(3), fp(4)]);
    expect(calls.map((c) => c.startKey)).toEqual([undefined, k1, k2]);
  });

  it("returns an empty list for a project with no findings", async () => {
    const { deps: d } = deps();
    expect(await listFindings("new-project", "DAST", d)).toEqual({ items: [] });
  });

  it("400 for a missing or unknown scan type, without a database call", async () => {
    for (const scanType of [undefined, "", "sast", "BOTH"]) {
      const { deps: d, calls } = deps();
      expect(await status(listFindings("demo-app", scanType, d))).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it("400 for a malformed project ID, without a database call", async () => {
    for (const projectId of ["", "A", "Bad_Project", "demo#SAST"]) {
      const { deps: d, calls } = deps();
      expect(await status(listFindings(projectId, "SAST", d))).toBe(400);
      expect(calls).toHaveLength(0);
    }
  });

  it("does not hide a malformed row", async () => {
    const { deps: d } = deps({ records: [row(1), row(2, { severity: "BAD" })] });
    await expect(listFindings("demo-app", "SAST", d)).rejects.toThrow("severity");
  });
});

describe("GET /projects/{projectId}/findings handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    process.env.FINDINGS_TABLE = "findings";
    ddb.on(QueryCommand).resolves({ Items: [row(1), row(2)] });
  });

  const get = (
    projectId: string | null = "demo-app",
    query: Record<string, string> | null = { scanType: "SAST" },
    authorized = true,
  ) =>
    handler(
      makeEvent({
        ...(projectId === null ? {} : { pathParameters: { projectId } }),
        ...(query === null ? {} : { queryStringParameters: query }),
        requestContext: {
          authorizer: authorized
            ? { lambda: { username: "geethanjali", role: "user" } }
            : undefined,
        } as never,
      }),
    );

  it("200 with { items } in the contract shape, and no table key", async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as { items: Record<string, unknown>[] };
    expect(Object.keys(body)).toEqual(["items"]);
    expect(body.items).toHaveLength(2);
    for (const item of body.items) expect(Object.keys(item).sort()).toEqual(CONTRACT_FIELDS);
    expect(res.body).not.toContain('"pk"');
  });

  it("is one strongly consistent Query on projectId#scanType, and nothing else", async () => {
    await get("demo-app", { scanType: "DAST" });
    expect(ddb.calls()).toHaveLength(1);
    expect(ddb.commandCalls(QueryCommand)[0]?.args[0].input).toEqual({
      TableName: "findings",
      KeyConditionExpression: "pk = :pk",
      ExpressionAttributeValues: { ":pk": "demo-app#DAST" },
      ConsistentRead: true,
    });
  });

  it("follows LastEvaluatedKey with ExclusiveStartKey and returns everything", async () => {
    const last = { pk: "demo-app#SAST", fingerprint: fp(2) };
    ddb
      .on(QueryCommand)
      .resolvesOnce({ Items: [row(1), row(2)], LastEvaluatedKey: last })
      .resolvesOnce({ Items: [row(3)] });
    const body = JSON.parse((await get()).body as string) as { items: unknown[] };
    expect(body.items).toHaveLength(3);
    expect(ddb.commandCalls(QueryCommand)[1]?.args[0].input.ExclusiveStartKey).toEqual(last);
  });

  it("200 and an empty list for an unknown project", async () => {
    ddb.on(QueryCommand).resolves({ Items: [] });
    const res = await get("new-project");
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ items: [] });
  });

  it("400 with the error shape for a missing or bad scanType, with no database call", async () => {
    for (const query of [null, {}, { scanType: "ALL" }]) {
      const res = await get("demo-app", query);
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body as string)).toEqual({ error: "Scan type must be SAST or DAST." });
    }
    expect(ddb.calls()).toHaveLength(0);
  });

  it("400 for a malformed or missing project ID, with no database call", async () => {
    expect((await get("Bad_ID")).statusCode).toBe(400);
    expect((await get(null)).statusCode).toBe(400);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("401 without a caller from the authorizer", async () => {
    expect((await get("demo-app", { scanType: "SAST" }, false)).statusCode).toBe(401);
    expect(ddb.calls()).toHaveLength(0);
  });

  it("generic 500 if a finding row is malformed, without leaking it", async () => {
    ddb.on(QueryCommand).resolves({ Items: [row(1, { state: "CLOSED" })] });
    const res = await get();
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("CLOSED");
    expect(res.body).not.toContain("state");
  });

  it("logs a malformed row with the project and scan type", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    ddb.on(QueryCommand).resolves({ Items: [row(1, { state: "CLOSED" })] });
    await get();
    const logs = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    vi.unstubAllEnvs();
    expect(logs).toContain("Finding record is malformed");
    expect(logs).toContain("demo-app");
    expect(logs).toContain("SAST");
  });
});
