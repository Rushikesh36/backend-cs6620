import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireKnownTarget, parseTargets } from "../common/targets.js";
import { handler } from "../lambdas/create-scan/handler.js";
import {
  createScan,
  UPLOAD_EXPIRES_SECONDS,
  type CreateScanDeps,
  type Job,
} from "../lambdas/create-scan/create-scan.js";
import { makeEvent } from "./helpers.js";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const NOW = new Date("2026-10-29T12:00:00.000Z");
const TARGETS = [
  { targetId: "juice-shop", name: "OWASP Juice Shop", description: "Deliberately vulnerable" },
];

function setup(over: Partial<CreateScanDeps> = {}) {
  const saved: Job[] = [];
  const presign = vi.fn<CreateScanDeps["presign"]>((key) =>
    Promise.resolve(`https://s3.example/${key}?sig=x`),
  );
  const deps: CreateScanDeps = {
    targets: TARGETS,
    putJob: (job) => {
      saved.push(job);
      return Promise.resolve();
    },
    presign,
    newId: () => JOB_ID,
    now: () => NOW,
    ...over,
  };
  return { deps, saved, presign };
}

async function statusOf(body: Record<string, unknown>, deps: CreateScanDeps): Promise<number> {
  try {
    await createScan(body, "rushikesh", deps);
    return 200;
  } catch (e) {
    return (e as { statusCode: number }).statusCode;
  }
}

describe("createScan: SAST", () => {
  it("saves the job and returns a pre-signed upload link", async () => {
    const { deps, saved, presign } = setup();
    const result = await createScan({ projectId: "demo-app", scanType: "SAST" }, "rushikesh", deps);

    expect(result).toEqual({
      jobId: JOB_ID,
      status: "CREATED",
      upload: {
        url: `https://s3.example/uploads/${JOB_ID}.zip?sig=x`,
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        expiresIn: 900,
      },
    });
    expect(presign).toHaveBeenCalledWith(`uploads/${JOB_ID}.zip`, 900);
    expect(saved).toEqual([
      {
        jobId: JOB_ID,
        projectId: "demo-app",
        scanType: "SAST",
        requestedBy: "rushikesh",
        targetId: null,
        status: "CREATED",
        imageTag: null,
        createdAt: "2026-10-29T12:00:00.000Z",
        queuedAt: null,
        startedAt: null,
        finishedAt: null,
        summary: null,
        error: null,
        scope: "ALL",
      },
    ]);
  });

  it("expiresIn is 900 and is the same number given to the signer", async () => {
    const { deps, presign } = setup();
    const r = await createScan({ projectId: "demo-app", scanType: "SAST" }, "u", deps);
    expect(UPLOAD_EXPIRES_SECONDS).toBe(900);
    expect(r.upload?.expiresIn).toBe(presign.mock.calls[0]?.[1]);
  });

  it("accepts targetId null, rejects any other targetId with 400", async () => {
    const { deps } = setup();
    expect(await statusOf({ projectId: "demo-app", scanType: "SAST", targetId: null }, deps)).toBe(
      200,
    );
    expect(
      await statusOf({ projectId: "demo-app", scanType: "SAST", targetId: "juice-shop" }, deps),
    ).toBe(400);
  });
});

describe("createScan: DAST", () => {
  it("accepts an allow-listed target and returns no upload link", async () => {
    const { deps, saved, presign } = setup();
    const r = await createScan(
      { projectId: "demo-app", scanType: "DAST", targetId: "juice-shop" },
      "rushikesh",
      deps,
    );
    expect(r).toEqual({ jobId: JOB_ID, status: "CREATED" });
    expect(r).not.toHaveProperty("upload");
    expect(presign).not.toHaveBeenCalled();
    expect(saved[0]).toMatchObject({ scanType: "DAST", targetId: "juice-shop" });
  });

  it("400 when the target is missing, malformed or not on the allow-list", async () => {
    const { deps, saved } = setup();
    const base = { projectId: "demo-app", scanType: "DAST" };
    expect(await statusOf(base, deps)).toBe(400);
    expect(await statusOf({ ...base, targetId: "http://evil.example" }, deps)).toBe(400);
    expect(await statusOf({ ...base, targetId: "other-app" }, deps)).toBe(400);
    expect(saved).toHaveLength(0);
  });
});

describe("createScan: validation", () => {
  it("400 for a bad projectId or scan type, and saves nothing", async () => {
    const { deps, saved } = setup();
    expect(await statusOf({ scanType: "SAST" }, deps)).toBe(400);
    expect(await statusOf({ projectId: "Bad ID!", scanType: "SAST" }, deps)).toBe(400);
    expect(await statusOf({ projectId: "demo-app" }, deps)).toBe(400);
    expect(await statusOf({ projectId: "demo-app", scanType: "XSS" }, deps)).toBe(400);
    expect(saved).toHaveLength(0);
  });

  it("does not hide a database failure", async () => {
    const { deps } = setup({ putJob: () => Promise.reject(new Error("boom")) });
    await expect(
      createScan({ projectId: "demo-app", scanType: "SAST" }, "u", deps),
    ).rejects.toThrow("boom");
  });
});

describe("targets helper", () => {
  it("parses a good list and rejects bad data as a server error", () => {
    expect(parseTargets(JSON.stringify(TARGETS))).toEqual(TARGETS);
    expect(() => parseTargets("nope")).toThrow();
    expect(() => parseTargets("{}")).toThrow();
    expect(() => parseTargets('[{"targetId":1}]')).toThrow();
  });

  it("requireKnownTarget gives a 400 that does not list the targets", () => {
    expect(() => {
      requireKnownTarget(TARGETS, "juice-shop");
    }).not.toThrow();
    expect(() => {
      requireKnownTarget(TARGETS, "nope");
    }).toThrow("Unknown target.");
  });
});

describe("POST /scans handler", () => {
  const ddb = mockClient(DynamoDBDocumentClient);

  beforeEach(() => {
    ddb.reset();
    ddb.on(PutCommand).resolves({});
    process.env.JOBS_TABLE = "jobs";
    process.env.UPLOADS_BUCKET = "uploads-bucket";
    process.env.TARGETS_JSON = JSON.stringify(TARGETS);
  });

  const post = (body: unknown, role: string | null = "user") =>
    handler(
      makeEvent({
        body: JSON.stringify(body),
        requestContext: {
          authorizer: role ? { lambda: { username: "rushikesh", role } } : undefined,
        } as never,
      }),
    );

  it("200 with a real pre-signed PUT link for uploads/<jobId>.zip that lasts 900 seconds", async () => {
    const res = await post({ projectId: "demo-app", scanType: "SAST" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body as string) as {
      jobId: string;
      status: string;
      upload: {
        url: string;
        method: string;
        headers: Record<string, string>;
        expiresIn: number;
      };
    };
    expect(body.status).toBe("CREATED");
    expect(body.upload.expiresIn).toBe(900);
    expect(body.upload.method).toBe("PUT");
    expect(body.upload.headers).toEqual({ "Content-Type": "application/zip" });

    const url = new URL(body.upload.url);
    expect(url.hostname).toContain("uploads-bucket");
    expect(url.pathname).toBe(`/uploads/${body.jobId}.zip`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    // The content type is signed, so S3 only accepts the exact header the browser is told to send.
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toContain("content-type");
    // No checksum of an empty body in the link, or S3 would reject the real zip.
    expect(
      [...url.searchParams.keys()].filter((k) => k.toLowerCase().includes("checksum")),
    ).toEqual([]);

    const put = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(put?.TableName).toBe("jobs");
    expect(put?.ConditionExpression).toBe("attribute_not_exists(jobId)");
    expect(put?.Item).toMatchObject({ jobId: body.jobId, requestedBy: "rushikesh", scope: "ALL" });
  });

  it("401 without a caller from the authorizer, and nothing is saved", async () => {
    const res = await post({ projectId: "demo-app", scanType: "SAST" }, null);
    expect(res.statusCode).toBe(401);
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("400 for a body that is not JSON", async () => {
    const res = await handler(
      makeEvent({
        body: "not json",
        requestContext: { authorizer: { lambda: { username: "u", role: "user" } } } as never,
      }),
    );
    expect(res.statusCode).toBe(400);
  });

  it("generic 500 if the job id already exists", async () => {
    ddb
      .on(PutCommand)
      .rejects(new ConditionalCheckFailedException({ message: "x", $metadata: {} }));
    const res = await post({ projectId: "demo-app", scanType: "SAST" });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("Conditional");
  });
});
