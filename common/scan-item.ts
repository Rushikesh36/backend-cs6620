import type { JobStatus } from "./dynamo.js";
import type { ScanType } from "./validation.js";

export interface Summary {
  new: number;
  newHigh: number;
  stillOpen: number;
  fixed: number;
}

/** One scan exactly as the contract returns it (GET /scans/{jobId} and the scan lists). */
export interface ScanItem {
  jobId: string;
  projectId: string;
  scanType: ScanType;
  targetId: string | null;
  status: JobStatus;
  requestedBy: string;
  imageTag: string | null;
  createdAt: string;
  queuedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: Summary | null;
  error: string | null;
}

const STATUSES: readonly string[] = ["CREATED", "QUEUED", "RUNNING", "COMPLETED", "FAILED"];

const isStatus = (v: unknown): v is JobStatus => typeof v === "string" && STATUSES.includes(v);

/** A string, or null when the attribute is missing or null. Any other type is bad data. */
function nullableString(record: Record<string, unknown>, field: string): string | null {
  const value: unknown = Reflect.get(record, field);
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error(`Job field ${field} is not a string.`);
  return value;
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = nullableString(record, field);
  if (value === null) throw new Error(`Job field ${field} is missing.`);
  return value;
}

function readSummary(value: unknown): Summary | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object") throw new Error("Job summary is not an object.");
  const { new: added, newHigh, stillOpen, fixed } = value as Record<string, unknown>;
  const counts = [added, newHigh, stillOpen, fixed];
  if (!counts.every((n) => typeof n === "number" && Number.isInteger(n))) {
    throw new Error("Job summary must hold four whole numbers.");
  }
  return {
    new: added as number,
    newHigh: newHigh as number,
    stillOpen: stillOpen as number,
    fixed: fixed as number,
  };
}

/**
 * Turns a row of the jobs table into the contract's shape. It copies only the contract's
 * fields, so internal ones (taskArn, scope) can never reach the browser. Bad data in the
 * table is a server error (the caller sees a generic 500), not a 404.
 */
export function toScanItem(record: Record<string, unknown>): ScanItem {
  const scanType: unknown = Reflect.get(record, "scanType");
  const status: unknown = Reflect.get(record, "status");
  if (scanType !== "SAST" && scanType !== "DAST") throw new Error("Job scanType is invalid.");
  if (!isStatus(status)) throw new Error("Job status is invalid.");

  return {
    jobId: requiredString(record, "jobId"),
    projectId: requiredString(record, "projectId"),
    scanType,
    targetId: nullableString(record, "targetId"),
    status,
    requestedBy: requiredString(record, "requestedBy"),
    imageTag: nullableString(record, "imageTag"),
    createdAt: requiredString(record, "createdAt"),
    queuedAt: nullableString(record, "queuedAt"),
    startedAt: nullableString(record, "startedAt"),
    finishedAt: nullableString(record, "finishedAt"),
    summary: readSummary(Reflect.get(record, "summary")),
    error: nullableString(record, "error"),
  };
}
