/* eslint-disable security/detect-non-literal-fs-filename -- files in temporary test folders */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { GetObjectCommand, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deadline,
  EXIT,
  runScanner,
  runToExitCode,
  ScanError,
  type JobConfig,
} from "../scanners/common/job.js";
import { runProcess } from "../scanners/common/run.js";
import { downloadToFile, scannerS3Client, uploadReport } from "../scanners/common/storage.js";

const JOB = "123e4567-e89b-42d3-a456-426614174001";
const s3 = mockClient(S3Client);

/** The exit code a ScanError thrown by fn carries, or undefined if fn did not throw one. */
function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ScanError ? err.exitCode : undefined;
  }
  return undefined;
}

let dir: string;
beforeEach(() => {
  s3.reset();
  dir = mkdtempSync(join(tmpdir(), "scanner-common-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function codeOf(promise: Promise<unknown>): Promise<number | undefined> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof ScanError ? err.exitCode : undefined;
}

describe("downloadToFile", () => {
  const client = new S3Client({});
  const body = (text: string) => Readable.from([Buffer.from(text)]) as never;

  it("writes the object to the file", async () => {
    s3.on(GetObjectCommand, { Bucket: "uploads", Key: "k" }).resolves({
      Body: body("PK zip bytes"),
      ContentLength: 12,
    });
    const file = join(dir, "upload.zip");
    await downloadToFile(client, "uploads", "k", file, 100);
    expect(readFileSync(file, "utf8")).toBe("PK zip bytes");
  });

  it("refuses an object that says it is too large, without reading it", async () => {
    s3.on(GetObjectCommand).resolves({ Body: body("x"), ContentLength: 101 });
    expect(await codeOf(downloadToFile(client, "b", "k", join(dir, "f"), 100))).toBe(EXIT.INPUT);
  });

  it("stops reading when the bytes go past the limit, whatever the size header said", async () => {
    s3.on(GetObjectCommand).resolves({ Body: body("y".repeat(500)), ContentLength: 10 });
    expect(await codeOf(downloadToFile(client, "b", "k", join(dir, "f"), 100))).toBe(EXIT.INPUT);
  });

  it("treats a missing upload as bad input and other S3 errors as storage errors", async () => {
    s3.on(GetObjectCommand).rejects(new NoSuchKey({ message: "gone", $metadata: {} }));
    expect(await codeOf(downloadToFile(client, "b", "k", join(dir, "f"), 100))).toBe(EXIT.INPUT);
    s3.on(GetObjectCommand).rejects(new Error("AccessDenied"));
    expect(await codeOf(downloadToFile(client, "b", "k", join(dir, "f"), 100))).toBe(EXIT.STORAGE);
  });
});

describe("uploadReport", () => {
  const client = new S3Client({});

  it("puts the report as JSON", async () => {
    s3.on(PutObjectCommand).resolves({});
    await uploadReport(client, "reports", `reports/${JOB}.json`, { results: [] });
    const input = s3.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      Bucket: "reports",
      Key: `reports/${JOB}.json`,
      Body: '{"results":[]}',
      ContentType: "application/json",
    });
  });

  it("turns an S3 error into a storage error", async () => {
    s3.on(PutObjectCommand).rejects(new Error("slow down"));
    expect(await codeOf(uploadReport(client, "b", "k", {}))).toBe(EXIT.STORAGE);
  });
});

describe("scannerS3Client", () => {
  it("uses a local S3 stand-in only when S3_ENDPOINT is set", () => {
    expect(scannerS3Client({}).config.forcePathStyle).toBe(false);
    expect(scannerS3Client({ S3_ENDPOINT: "http://s3mock:9090" }).config.forcePathStyle).toBe(true);
  });
});

describe("runProcess", () => {
  it("returns the exit code and passes each output line on", async () => {
    const lines: string[] = [];
    const result = await runProcess(
      process.execPath,
      ["-e", "console.log('one'); console.error('two'); process.exit(3)"],
      { timeoutMs: 10_000, onLine: (stream, line) => lines.push(`${stream}:${line}`) },
    );
    expect(result).toEqual({ exitCode: 3, signal: null, timedOut: false });
    expect(lines.sort()).toEqual(["stderr:two", "stdout:one"]);
  });

  it("kills the whole process group on timeout, including programs it started", async () => {
    const started = Date.now();
    // The shell starts a background sleep that keeps the output pipe open; only a group kill
    // ends it, so this returns quickly only if the grandchild was killed too.
    const result = await runProcess("sh", ["-c", "sleep 30 & sleep 30"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("uses SIGKILL when a program ignores SIGTERM", async () => {
    const result = await runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { timeoutMs: 200 },
    );
    expect(result).toMatchObject({ timedOut: true, signal: "SIGKILL" });
  }, 15_000);

  it("rejects when the program does not exist", async () => {
    await expect(runProcess("no-such-scanner-xyz", [], { timeoutMs: 1000 })).rejects.toThrow();
  });
});

describe("deadline", () => {
  it("gives the time left, then fails with TIMEOUT", () => {
    let now = 1000;
    const timeLeft = deadline(5000, () => now);
    expect(timeLeft()).toBe(5000);
    now = 5500;
    expect(timeLeft()).toBe(500);
    now = 6000;
    expect(exitCodeOf(timeLeft)).toBe(EXIT.TIMEOUT);
  });
});

describe("runToExitCode and runScanner", () => {
  it("maps success, known failures and surprises to exit codes", async () => {
    expect(await runToExitCode(() => Promise.resolve())).toBe(EXIT.OK);
    expect(await runToExitCode(() => Promise.reject(new ScanError("bad zip", EXIT.INPUT)))).toBe(
      EXIT.INPUT,
    );
    expect(await runToExitCode(() => Promise.reject(new Error("bug")))).toBe(EXIT.UNEXPECTED);
  });

  const readConfig = (env: Record<string, string | undefined>): JobConfig => {
    if (env.JOB_ID !== JOB) throw new ScanError("JOB_ID is missing or not a job ID.", EXIT.CONFIG);
    return { jobId: JOB, reportsBucket: "r", timeoutMs: 1000 };
  };

  it("returns CONFIG without scanning when the settings are wrong", async () => {
    let scanned = false;
    const code = await runScanner({}, readConfig, () => {
      scanned = true;
      return Promise.resolve();
    });
    expect(code).toBe(EXIT.CONFIG);
    expect(scanned).toBe(false);
  });

  it("runs the scan with the settings and returns its exit code", async () => {
    let seen: JobConfig | undefined;
    const code = await runScanner({ JOB_ID: JOB }, readConfig, (config) => {
      seen = config;
      return Promise.reject(new ScanError("no report", EXIT.SCANNER));
    });
    expect(seen?.jobId).toBe(JOB);
    expect(code).toBe(EXIT.SCANNER);
  });
});
