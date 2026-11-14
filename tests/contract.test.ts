import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyToken } from "../common/jwt.js";
import { hashPassword } from "../common/passwords.js";
import { resetSecretCache } from "../common/secret.js";
import { handler as createScan } from "../lambdas/create-scan/handler.js";
import { handler as getScan } from "../lambdas/get-scan/handler.js";
import { handler as listFindings } from "../lambdas/list-findings/handler.js";
import { handler as listProjectScans } from "../lambdas/list-project-scans/handler.js";
import { handler as listRecentScans } from "../lambdas/list-recent-scans/handler.js";
import { handler as login } from "../lambdas/login/handler.js";
import { exitedWith, NO_REPORT } from "../lambdas/processor/processor.js";
import { TIMED_OUT_MESSAGE } from "../lambdas/reaper/reaper.js";
import { handler as startScan } from "../lambdas/start-scan/handler.js";
import { COULD_NOT_START_MESSAGE } from "../lambdas/start-scan/start-scan.js";
import { handler as targets } from "../lambdas/targets/handler.js";
import { schemaNames, validateAgainst } from "../scripts/lib/contract-schemas.js";
import { makeEvent } from "./helpers.js";

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

const JOB = "123e4567-e89b-42d3-a456-426614174000";
const JOB_2 = "123e4567-e89b-42d3-a456-426614174001";
const SECRET = "contract-test-secret-".padEnd(40, "x");
const PASSWORD = "correct horse battery";
const JUICE = {
  targetId: "juice-shop",
  name: "OWASP Juice Shop",
  description: "Deliberately vulnerable test app",
};
const FP = "a".repeat(64);

/** A row as the jobs table holds it, including internal fields that must never reach a browser. */
const jobRow = (over: Record<string, unknown> = {}) => ({
  jobId: JOB,
  projectId: "demo-app",
  scanType: "SAST",
  targetId: null,
  status: "CREATED",
  requestedBy: "rushikesh",
  imageTag: null,
  createdAt: "2026-11-05T10:00:00.000Z",
  queuedAt: null,
  startedAt: null,
  finishedAt: null,
  summary: null,
  error: null,
  taskArn: "arn:aws:ecs:us-east-1:123456789012:task/c/abc",
  scope: "ALL",
  ...over,
});
const completed = jobRow({
  status: "COMPLETED",
  imageTag: "semgrep-1.4.0-abc1234",
  queuedAt: "2026-11-05T10:01:00.000Z",
  startedAt: "2026-11-05T10:01:30.000Z",
  finishedAt: "2026-11-05T10:04:00.000Z",
  summary: { new: 3, newHigh: 1, stillOpen: 5, fixed: 2 },
});
const findingRow = (over: Record<string, unknown> = {}) => ({
  pk: "demo-app#SAST",
  fingerprint: FP,
  ruleId: "python.lang.security.audit.eval-injection",
  severity: "HIGH",
  location: "app/views.py:42",
  message: "Eval with user input.",
  state: "OPEN",
  firstSeenJobId: JOB,
  lastSeenJobId: JOB_2,
  ...over,
});

const AUTH = { lambda: { username: "rushikesh", role: "user" } };

function event(opts: {
  path?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  auth?: boolean;
}): APIGatewayProxyEventV2 {
  return makeEvent({
    ...(opts.path ? { pathParameters: opts.path } : {}),
    ...(opts.query ? { queryStringParameters: opts.query } : {}),
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    ...(opts.rawBody !== undefined ? { body: opts.rawBody } : {}),
    requestContext: { authorizer: opts.auth === false ? undefined : AUTH } as never,
  });
}

/** Calls the real handler, and checks the parts every response shares: JSON and a body. */
async function call(
  h: Handler,
  opts: Parameters<typeof event>[0],
): Promise<{ status: number; body: unknown; raw: string }> {
  const res = await h(event(opts));
  expect(res.headers?.["Content-Type"]).toBe("application/json");
  const raw = res.body ?? "";
  return { status: res.statusCode ?? -1, body: JSON.parse(raw) as unknown, raw };
}

/** Fails with the plain-words problems (not just "false") when the body breaks the contract. */
function expectShape(schema: string, body: unknown): void {
  expect(validateAgainst(schema, body)).toEqual([]);
}

describe("the schemas themselves", () => {
  it("has a schema for every response in contract.md", () => {
    expect(schemaNames()).toEqual([
      "create-scan-dast-response",
      "create-scan-sast-response",
      "error",
      "findings-response",
      "login-response",
      "scan-item",
      "scan-list-response",
      "start-scan-response",
      "targets-response",
    ]);
  });

  /** The scan as the browser should see it: the job row without its internal fields. */
  const scan = (over: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(
      Object.entries(jobRow()).filter(([key]) => key !== "taskArn" && key !== "scope"),
    ),
    ...over,
  });

  it("accepts a valid scan in every state", () => {
    expect(validateAgainst("scan-item", scan())).toEqual([]);
    expect(
      validateAgainst("scan-item", scan({ status: "QUEUED", queuedAt: "2026-11-05T10:01:00Z" })),
    ).toEqual([]);
    expect(validateAgainst("scan-item", scan({ status: "RUNNING" }))).toEqual([]);
    expect(
      validateAgainst(
        "scan-item",
        scan({ status: "COMPLETED", summary: { new: 0, newHigh: 0, stillOpen: 0, fixed: 0 } }),
      ),
    ).toEqual([]);
    for (const error of [
      "Scanner exited with code 2",
      "No report produced",
      "Timed out after 25 minutes",
      "Could not start scanner task",
    ]) {
      expect(validateAgainst("scan-item", scan({ status: "FAILED", error }))).toEqual([]);
    }
  });

  it.each([
    ["an internal field (taskArn) leaking", { taskArn: "arn:aws:ecs:x" }],
    ["an internal field (scope) leaking", { scope: "ALL" }],
    ["a missing field", { requestedBy: undefined }],
    ["an unknown status", { status: "DONE" }],
    ["an unknown scan type", { scanType: "XSS" }],
    ["a time that is not ISO-8601", { createdAt: "yesterday" }],
    [
      "a summary before COMPLETED",
      { status: "RUNNING", summary: { new: 1, newHigh: 0, stillOpen: 0, fixed: 0 } },
    ],
    ["COMPLETED without a summary", { status: "COMPLETED", summary: null }],
    ["a summary with a missing count", { status: "COMPLETED", summary: { new: 1 } }],
    [
      "a summary with text counts",
      { status: "COMPLETED", summary: { new: "1", newHigh: 0, stillOpen: 0, fixed: 0 } },
    ],
    ["a FAILED scan with a made-up message", { status: "FAILED", error: "Something broke" }],
    ["a FAILED scan with no message", { status: "FAILED", error: null }],
    ["a jobId that is not a UUID", { jobId: "../x" }],
  ])("rejects a scan with %s", (_name, change) => {
    expect(validateAgainst("scan-item", scan(change)).length).toBeGreaterThan(0);
  });

  it("rejects the other responses when they drift from the contract", () => {
    const bad: [string, unknown][] = [
      ["error", { message: "Unauthorized" }],
      ["error", { error: "x", detail: "y" }],
      [
        "login-response",
        { token: "a.b.c", expiresIn: "3600", user: { username: "u", role: "user" } },
      ],
      [
        "login-response",
        { token: "a.b.c", expiresIn: 3600, user: { username: "u", role: "admin" } },
      ],
      ["targets-response", { targets: [{ ...JUICE, url: "http://10.0.0.5:3000" }] }],
      ["create-scan-sast-response", { jobId: JOB, status: "CREATED", upload: null }],
      ["create-scan-sast-response", { jobId: JOB, status: "CREATED" }],
      [
        "create-scan-sast-response",
        {
          jobId: JOB,
          status: "CREATED",
          upload: {
            url: "https://s3/x",
            method: "PUT",
            headers: { "Content-Type": "application/zip" },
            expiresIn: 600,
          },
        },
      ],
      ["create-scan-dast-response", { jobId: JOB, status: "CREATED", upload: null }],
      ["start-scan-response", { jobId: JOB, status: "RUNNING" }],
      ["scan-list-response", { items: [] }],
      ["scan-list-response", { items: [], nextCursor: "" }],
      ["findings-response", { items: [findingRow()] }],
      ["findings-response", { items: [{ ...findingRow(), pk: undefined, fingerprint: "short" }] }],
      ["findings-response", { items: [{ ...findingRow(), pk: undefined, severity: "CRITICAL" }] }],
    ];
    for (const [schema, body] of bad) {
      expect(validateAgainst(schema, body).length, JSON.stringify([schema, body])).toBeGreaterThan(
        0,
      );
    }
  });

  it("uses the contract's failure messages that the code really writes", () => {
    for (const error of [
      exitedWith(1),
      exitedWith(124),
      NO_REPORT,
      TIMED_OUT_MESSAGE,
      COULD_NOT_START_MESSAGE,
    ]) {
      expect(validateAgainst("scan-item", scan({ status: "FAILED", error })), error).toEqual([]);
    }
  });
});

describe("every handler answers in the contract's shape", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const s3 = mockClient(S3Client);
  const sqs = mockClient(SQSClient);
  const ssm = mockClient(SSMClient);
  let hash: string;

  beforeAll(async () => {
    hash = await hashPassword(PASSWORD);
  });

  beforeEach(() => {
    ddb.reset();
    s3.reset();
    sqs.reset();
    ssm.reset();
    resetSecretCache();
    Object.assign(process.env, {
      JOBS_TABLE: "jobs",
      USERS_TABLE: "users",
      FINDINGS_TABLE: "findings",
      UPLOADS_BUCKET: "uploads-bucket",
      QUEUE_URL: "https://sqs.example/queue",
      TARGETS_JSON: JSON.stringify([JUICE]),
      TOKEN_LIFETIME_SECONDS: "3600",
      JWT_SECRET_SSM_NAME: "/security-hub/jwt-secret",
    });
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
    ddb.on(GetCommand, { TableName: "users" }).resolves({
      Item: { username: "rushikesh", role: "user", disabled: false, passwordHash: hash },
    });
    ddb.on(GetCommand, { TableName: "jobs" }).resolves({ Item: jobRow() });
    ddb.on(PutCommand).resolves({});
    ddb.on(UpdateCommand).resolves({});
    ddb.on(QueryCommand, { TableName: "jobs" }).resolves({ Items: [completed, jobRow()] });
    ddb.on(QueryCommand, { TableName: "findings" }).resolves({
      Items: [findingRow(), findingRow({ fingerprint: "b".repeat(64), state: "FIXED" })],
    });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 1234 });
    s3.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from([0x50, 0x4b])) } as never,
    });
    sqs.on(SendMessageCommand).resolves({});
  });

  describe("success responses", () => {
    it("POST /login", async () => {
      const r = await call(login, {
        body: { username: "rushikesh", password: PASSWORD },
        auth: false,
      });
      expect(r.status).toBe(200);
      expectShape("login-response", r.body);
      const { token, expiresIn } = r.body as { token: string; expiresIn: number };
      const claims = verifyToken(token, SECRET);
      expect(Object.keys(claims).sort()).toEqual(["exp", "iat", "role", "sub"]);
      expect(Number.isInteger(claims.exp)).toBe(true);
      expect(claims.exp - claims.iat).toBe(expiresIn);
    });

    it("GET /targets", async () => {
      const r = await call(targets, {});
      expect(r.status).toBe(200);
      expectShape("targets-response", r.body);
    });

    it("GET /targets, even if the configuration holds a URL", async () => {
      process.env.TARGETS_JSON = JSON.stringify([{ ...JUICE, url: "http://10.0.0.5:3000" }]);
      const r = await call(targets, {});
      expectShape("targets-response", r.body);
      expect(r.raw).not.toContain("10.0.0.5");
    });

    it("POST /scans (SAST): with the upload", async () => {
      const r = await call(createScan, { body: { projectId: "demo-app", scanType: "SAST" } });
      expect(r.status).toBe(200);
      expectShape("create-scan-sast-response", r.body);
    });

    it("POST /scans (DAST): without any upload key", async () => {
      const r = await call(createScan, {
        body: { projectId: "demo-app", scanType: "DAST", targetId: "juice-shop" },
      });
      expect(r.status).toBe(200);
      expectShape("create-scan-dast-response", r.body);
    });

    it("POST /scans/{jobId}/start (SAST and DAST)", async () => {
      const sast = await call(startScan, { path: { jobId: JOB } });
      expect(sast.status).toBe(200);
      expectShape("start-scan-response", sast.body);

      ddb.on(GetCommand, { TableName: "jobs" }).resolves({
        Item: jobRow({ scanType: "DAST", targetId: "juice-shop" }),
      });
      const dast = await call(startScan, { path: { jobId: JOB } });
      expect(dast.status).toBe(200);
      expectShape("start-scan-response", dast.body);
    });

    it.each([
      ["CREATED", jobRow()],
      ["QUEUED", jobRow({ status: "QUEUED", queuedAt: "2026-11-05T10:01:00.000Z" })],
      [
        "RUNNING",
        jobRow({
          status: "RUNNING",
          queuedAt: "2026-11-05T10:01:00.000Z",
          startedAt: "2026-11-05T10:01:30.000Z",
          imageTag: "semgrep-1.4.0-abc1234",
        }),
      ],
      ["COMPLETED", completed],
      [
        "FAILED (timed out)",
        jobRow({
          status: "FAILED",
          error: TIMED_OUT_MESSAGE,
          finishedAt: "2026-11-05T10:30:00.000Z",
        }),
      ],
      [
        "FAILED (scanner exit code)",
        jobRow({ status: "FAILED", error: exitedWith(2), finishedAt: "2026-11-05T10:30:00.000Z" }),
      ],
      ["a DAST scan", jobRow({ scanType: "DAST", targetId: "juice-shop" })],
    ])("GET /scans/{jobId}: %s", async (_name, item) => {
      ddb.on(GetCommand, { TableName: "jobs" }).resolves({ Item: item });
      const r = await call(getScan, { path: { jobId: JOB } });
      expect(r.status).toBe(200);
      expectShape("scan-item", r.body);
      expect(r.raw).not.toContain("taskArn");
      expect(r.raw).not.toContain("scope");
    });

    it("GET /projects/{projectId}/scans: items, then an empty list", async () => {
      const full = await call(listProjectScans, { path: { projectId: "demo-app" } });
      expect(full.status).toBe(200);
      expectShape("scan-list-response", full.body);

      ddb.on(QueryCommand, { TableName: "jobs" }).resolves({ Items: [] });
      const empty = await call(listProjectScans, { path: { projectId: "new-project" } });
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ items: [], nextCursor: null });
      expectShape("scan-list-response", empty.body);
    });

    it("GET /projects/{projectId}/scans: a page with a cursor, and the cursor is accepted back", async () => {
      ddb
        .on(QueryCommand, { TableName: "jobs" })
        .resolvesOnce({
          Items: [completed],
          LastEvaluatedKey: { jobId: JOB, projectId: "demo-app", createdAt: completed.createdAt },
        })
        .resolves({ Items: [] });
      const first = await call(listProjectScans, {
        path: { projectId: "demo-app" },
        query: { limit: "1" },
      });
      expectShape("scan-list-response", first.body);
      const { nextCursor } = first.body as { nextCursor: string };
      expect(typeof nextCursor).toBe("string");

      const second = await call(listProjectScans, {
        path: { projectId: "demo-app" },
        query: { limit: "1", cursor: nextCursor },
      });
      expect(second.status).toBe(200);
      expectShape("scan-list-response", second.body);
    });

    it("GET /scans (approved extra)", async () => {
      const r = await call(listRecentScans, {});
      expect(r.status).toBe(200);
      expectShape("scan-list-response", r.body);
    });

    it("GET /projects/{projectId}/findings: OPEN and FIXED, then an empty list", async () => {
      const r = await call(listFindings, {
        path: { projectId: "demo-app" },
        query: { scanType: "SAST" },
      });
      expect(r.status).toBe(200);
      expectShape("findings-response", r.body);
      expect(r.raw).not.toContain("demo-app#SAST");

      ddb.on(QueryCommand, { TableName: "findings" }).resolves({ Items: [] });
      const empty = await call(listFindings, {
        path: { projectId: "nobody-here" },
        query: { scanType: "DAST" },
      });
      expect(empty.status).toBe(200);
      expect(empty.body).toEqual({ items: [] });
    });
  });

  describe("error responses are always { error }", () => {
    const expectError = (r: { status: number; body: unknown }, status: number): void => {
      expect(r.status).toBe(status);
      expectShape("error", r.body);
    };

    it("400 for bad input on every endpoint that takes any", async () => {
      expectError(await call(login, { rawBody: "not json", auth: false }), 400);
      expectError(await call(login, { body: { username: "u" }, auth: false }), 400);
      expectError(
        await call(createScan, { body: { projectId: "Bad ID!", scanType: "SAST" } }),
        400,
      );
      expectError(
        await call(createScan, {
          body: { projectId: "demo-app", scanType: "DAST", targetId: "http://evil.example" },
        }),
        400,
      );
      expectError(await call(createScan, { rawBody: "not json" }), 400);
      expectError(
        await call(listProjectScans, { path: { projectId: "demo-app" }, query: { limit: "500" } }),
        400,
      );
      expectError(
        await call(listProjectScans, {
          path: { projectId: "demo-app" },
          query: { cursor: "garbage!" },
        }),
        400,
      );
      expectError(await call(listRecentScans, { query: { cursor: "garbage!" } }), 400);
      expectError(await call(listFindings, { path: { projectId: "demo-app" } }), 400);
      expectError(
        await call(listFindings, { path: { projectId: "demo-app" }, query: { scanType: "XSS" } }),
        400,
      );
    });

    it("400 with a plain message when the zip was not uploaded", async () => {
      s3.on(HeadObjectCommand).rejects(Object.assign(new Error("nope"), { name: "NotFound" }));
      expectError(await call(startScan, { path: { jobId: JOB } }), 400);
    });

    it("401 for a wrong password, with one generic message", async () => {
      const wrong = await call(login, {
        body: { username: "rushikesh", password: "wrong password!!" },
        auth: false,
      });
      expectError(wrong, 401);
      ddb.on(GetCommand, { TableName: "users" }).resolves({});
      const unknown = await call(login, {
        body: { username: "nobody", password: PASSWORD },
        auth: false,
      });
      expectError(unknown, 401);
      expect(unknown.body).toEqual(wrong.body);
    });

    it("401 on every protected endpoint when the authorizer sent no caller", async () => {
      const routes: [Handler, Parameters<typeof event>[0]][] = [
        [targets, {}],
        [createScan, { body: { projectId: "demo-app", scanType: "SAST" } }],
        [startScan, { path: { jobId: JOB } }],
        [getScan, { path: { jobId: JOB } }],
        [listProjectScans, { path: { projectId: "demo-app" } }],
        [listRecentScans, {}],
        [listFindings, { path: { projectId: "demo-app" }, query: { scanType: "SAST" } }],
      ];
      for (const [h, opts] of routes) expectError(await call(h, { ...opts, auth: false }), 401);
    });

    it("404 { error: 'Scan not found.' } for an unknown or malformed scan", async () => {
      ddb.on(GetCommand, { TableName: "jobs" }).resolves({});
      const missing = await call(getScan, { path: { jobId: JOB } });
      expectError(missing, 404);
      expect(missing.body).toEqual({ error: "Scan not found." });
      expectError(await call(getScan, { path: { jobId: "nope" } }), 404);
      expectError(await call(startScan, { path: { jobId: JOB } }), 404);
    });

    it("409 { error: 'This scan was already started.' } for a second start", async () => {
      ddb.on(GetCommand, { TableName: "jobs" }).resolves({ Item: jobRow({ status: "QUEUED" }) });
      const r = await call(startScan, { path: { jobId: JOB } });
      expectError(r, 409);
      expect(r.body).toEqual({ error: "This scan was already started." });
    });

    it("500 is generic: bad data or a failing database is never shown to the caller", async () => {
      ddb.on(GetCommand, { TableName: "jobs" }).resolves({ Item: jobRow({ status: "DONE" }) });
      const bad = await call(getScan, { path: { jobId: JOB } });
      expectError(bad, 500);

      ddb.on(QueryCommand, { TableName: "jobs" }).rejects(new Error("secret table name jobs-prod"));
      const down = await call(listRecentScans, {});
      expectError(down, 500);
      expect(down.raw).not.toContain("jobs-prod");
      expect(bad.raw).not.toContain("DONE");
    });
  });
});
