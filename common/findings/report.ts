import type { ScannedFinding } from "./diff.js";
import { fingerprint, type FindingIdentity, type Severity } from "./fingerprint.js";

/** One finding taken out of a scanner report, before its fingerprint is worked out. */
export interface ParsedFinding {
  identity: FindingIdentity;
  severity: Severity;
  location: string;
  message: string;
}

export interface ParseResult {
  findings: ParsedFinding[];
  /** Entries that were skipped or degraded, in plain words, for the logs. Never shown to users. */
  warnings: string[];
}

/** The report as a whole is unusable (not JSON of the expected shape). */
export class ReportError extends Error {
  override name = "ReportError";
}

// Scanner text is untrusted and can be long. Caps keep a findings row far below DynamoDB's 400 KB.
export const MAX_RULE_ID = 300;
export const MAX_LOCATION = 500;
export const MAX_MESSAGE = 1000;

/** Plain, single-spaced, capped text. Stored and returned as plain text, never as markup. */
export function cleanText(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Adds the fingerprint, giving what diffFindings() takes. */
export function toScanned(projectId: string, f: ParsedFinding): ScannedFinding {
  return {
    fingerprint: fingerprint(projectId, f.identity),
    ruleId: f.identity.ruleId,
    severity: f.severity,
    location: f.location,
    message: f.message,
  };
}

// Small type guards for untrusted JSON.
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
