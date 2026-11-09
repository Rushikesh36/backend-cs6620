import { GetObjectCommand, NoSuchKey, type S3Client } from "@aws-sdk/client-s3";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isFinal, transitionJob } from "../../common/dynamo.js";
import { diffFindings, type ScanSummary } from "../../common/findings/diff.js";
import { toScanned, type ParseResult } from "../../common/findings/report.js";
import { parseSemgrep } from "../../common/findings/semgrep.js";
import {
  findingsKey,
  readAllFindings,
  type QueryFindingsPage,
  type WriteFindings,
} from "../../common/findings/table.js";
import { parseZap } from "../../common/findings/zap.js";
import { logger } from "../../common/logger.js";
import { toScanItem } from "../../common/scan-item.js";
import { isValidJobId } from "../../common/validation.js";
import { COULD_NOT_START_MESSAGE } from "../start-scan/start-scan.js";

/** Where the scanner wrapper (Task 21) writes the raw Semgrep or ZAP JSON report. */
export const reportKey = (jobId: string): string => `reports/${jobId}.json`;

/** A larger report is treated as missing instead of being loaded into the Lambda's memory. */
export const MAX_REPORT_BYTES = 25 * 1024 * 1024;

// Failure messages from docs/contract.md, word for word: the dashboard explains each one.
// "Could not start scanner task" is start-scan's COULD_NOT_START_MESSAGE, reused below.
export const NO_REPORT = "No report produced";
export const exitedWith = (code: number): string => `Scanner exited with code ${String(code)}`;

/** The parts of an ECS "Task State Change" event the processor uses. */
export interface EcsTaskDetail {
  // Event JSON from AWS may leave any of these out.
  lastStatus?: string | undefined;
  startedBy?: string | undefined;
  stopCode?: string | undefined;
  stoppedReason?: string | undefined;
  containers?: { name?: string | undefined; exitCode?: number | undefined }[] | undefined;
}

export interface ProcessorDeps {
  getJob: (jobId: string) => Promise<Record<string, unknown> | undefined>;
  /** The report's text, or undefined when it is missing or too large. */
  readReport: (jobId: string) => Promise<string | undefined>;
  queryFindings: QueryFindingsPage;
  writeFindings: WriteFindings;
  complete: (jobId: string, summary: ScanSummary, finishedAt: string) => Promise<boolean>;
  fail: (jobId: string, error: string, finishedAt: string) => Promise<boolean>;
  now?: () => Date;
}

export type Outcome =
  | { result: "ignored"; reason: string }
  | { result: "already-final"; jobId: string }
  | { result: "failed"; jobId: string; error: string }
  | { result: "completed"; jobId: string; projectId: string; summary: ScanSummary };

/**
 * Handles one stopped scanner task (docs/architecture.md 5.5). The job comes from `startedBy`
 * (set by the launcher). Exit code not 0, or none: FAILED. Exit 0 but no usable report: FAILED.
 * Otherwise: parse, fingerprint, diff against the stored findings, write them, COMPLETED.
 *
 * A repeated event is safe: a finished job is skipped, re-writing the same rows changes nothing,
 * and transitionJob refuses a second final state.
 */
export async function processStoppedTask(
  detail: EcsTaskDetail,
  deps: ProcessorDeps,
): Promise<Outcome> {
  const jobId = detail.startedBy ?? "";
  // Tasks we did not start (the test app's service, for example) do not carry a job ID.
  if (detail.lastStatus !== "STOPPED") return ignored("task is not stopped", jobId);
  if (!isValidJobId(jobId)) return ignored("task was not started for a scan job", jobId);

  const record = await deps.getJob(jobId);
  if (!record) return ignored("no such job", jobId);
  let scan;
  try {
    scan = toScanItem(record);
  } catch (err) {
    logger.error("Job record is malformed", { jobId, error: err });
    throw err;
  }
  if (isFinal(scan.status)) {
    logger.info("Job already finished, event skipped", { jobId, status: scan.status });
    return { result: "already-final", jobId };
  }

  const finishedAt = (deps.now?.() ?? new Date()).toISOString();
  const failWith = async (error: string): Promise<Outcome> => {
    const changed = await deps.fail(jobId, error, finishedAt);
    logger.info(changed ? "Job failed" : "Job already finished", { jobId, error });
    return changed ? { result: "failed", jobId, error } : { result: "already-final", jobId };
  };

  const codes = (detail.containers ?? [])
    .map((c) => c.exitCode)
    .filter((c): c is number => typeof c === "number");
  if (codes.length === 0) {
    logger.warn("Scanner task stopped without an exit code", {
      jobId,
      stopCode: detail.stopCode,
      stoppedReason: detail.stoppedReason,
    });
    return failWith(COULD_NOT_START_MESSAGE);
  }
  const bad = codes.find((c) => c !== 0);
  if (bad !== undefined) return failWith(exitedWith(bad));

  const text = await deps.readReport(jobId);
  if (text === undefined) return failWith(NO_REPORT);

  let parsed: ParseResult;
  try {
    const report: unknown = JSON.parse(text);
    parsed = scan.scanType === "SAST" ? parseSemgrep(report) : parseZap(report);
  } catch (err) {
    logger.warn("Scanner report could not be read", { jobId, error: err });
    return failWith(NO_REPORT);
  }
  if (parsed.warnings.length > 0) {
    logger.warn("Report entries skipped or degraded", {
      jobId,
      count: parsed.warnings.length,
      first: parsed.warnings.slice(0, 5),
    });
  }

  const pk = findingsKey(scan.projectId, scan.scanType);
  const previous = await readAllFindings(deps.queryFindings, pk);
  const { changes, summary } = diffFindings(
    previous,
    parsed.findings.map((f) => toScanned(scan.projectId, f)),
    jobId,
  );
  await deps.writeFindings(
    pk,
    changes.map((c) => c.row),
  );

  if (!(await deps.complete(jobId, summary, finishedAt))) {
    logger.info("Job already finished, summary not saved", { jobId });
    return { result: "already-final", jobId };
  }
  logger.info("Job completed", { jobId, projectId: scan.projectId, summary });
  return { result: "completed", jobId, projectId: scan.projectId, summary };
}

function ignored(reason: string, jobId: string): Outcome {
  logger.info("Task event ignored", { reason, startedBy: jobId });
  return { result: "ignored", reason };
}

/** The report from S3, or undefined when there is none or it is too large to load. */
export function readReportFromBucket(
  client: S3Client,
  bucket: string,
): ProcessorDeps["readReport"] {
  return async (jobId) => {
    try {
      const out = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: reportKey(jobId) }),
      );
      if ((out.ContentLength ?? 0) > MAX_REPORT_BYTES) {
        logger.warn("Scanner report is too large", { jobId, bytes: out.ContentLength });
        return undefined;
      }
      return await out.Body?.transformToString("utf-8");
    } catch (err) {
      if (err instanceof NoSuchKey) return undefined;
      throw err;
    }
  };
}

/** COMPLETED with the summary, through transitionJob (refuses if the job is already final). */
export function completeJob(
  client: DynamoDBDocumentClient,
  table: string,
): ProcessorDeps["complete"] {
  return (jobId, summary, finishedAt) =>
    transitionJob(client, table, jobId, "COMPLETED", { summary: { ...summary }, finishedAt });
}

/** FAILED with the contract's message, through transitionJob. */
export function failJob(client: DynamoDBDocumentClient, table: string): ProcessorDeps["fail"] {
  return (jobId, error, finishedAt) =>
    transitionJob(client, table, jobId, "FAILED", { error, finishedAt });
}
