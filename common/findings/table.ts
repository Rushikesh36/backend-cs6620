import type { FindingState, StoredFinding } from "./diff.js";
import type { Severity } from "./fingerprint.js";
import { str } from "./report.js";
import type { ScanType } from "../validation.js";

/**
 * Partition key of the findings table: `projectId#scanType`, for example `demo#SAST`
 * (docs/data-model.md). The list-findings Lambda reads with it; the processor writes with it.
 */
export const findingsKey = (projectId: string, scanType: ScanType): string =>
  `${projectId}#${scanType}`;

const SEVERITIES: readonly string[] = ["HIGH", "MEDIUM", "LOW", "INFO"];
const STATES: readonly string[] = ["OPEN", "FIXED"];

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = str(Reflect.get(record, field));
  if (value === undefined) throw new Error(`Finding field ${field} is missing or not a string.`);
  return value;
}

/**
 * Turns a row of the findings table into the contract's shape. It copies only the contract's
 * fields, so the table's own key (`pk`) never reaches the browser. Bad data in the table is a
 * server error (the caller sees a generic 500), never half a finding.
 */
export function toFindingItem(record: Record<string, unknown>): StoredFinding {
  const severity: unknown = Reflect.get(record, "severity");
  const state: unknown = Reflect.get(record, "state");
  if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
    throw new Error("Finding severity is invalid.");
  }
  if (typeof state !== "string" || !STATES.includes(state)) {
    throw new Error("Finding state is invalid.");
  }
  return {
    fingerprint: requiredString(record, "fingerprint"),
    ruleId: requiredString(record, "ruleId"),
    severity: severity as Severity,
    location: requiredString(record, "location"),
    message: requiredString(record, "message"),
    state: state as FindingState,
    firstSeenJobId: requiredString(record, "firstSeenJobId"),
    lastSeenJobId: requiredString(record, "lastSeenJobId"),
  };
}
