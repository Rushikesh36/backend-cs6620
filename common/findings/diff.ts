import type { Severity } from "./fingerprint.js";

export type FindingState = "OPEN" | "FIXED";
export type DiffLabel = "NEW" | "STILL_OPEN" | "FIXED";

/** One finding as a scanner reported it in this scan, with its fingerprint already worked out. */
export interface ScannedFinding {
  fingerprint: string;
  ruleId: string;
  severity: Severity;
  location: string;
  message: string;
}

/** One row of the findings table (without `pk`), the same shape GET /projects/{id}/findings returns. */
export interface StoredFinding extends ScannedFinding {
  state: FindingState;
  firstSeenJobId: string;
  lastSeenJobId: string;
}

export interface ScanSummary {
  new: number;
  newHigh: number;
  stillOpen: number;
  fixed: number;
}

export interface DiffResult {
  /** Every finding this scan changed, with its label. Each `row` is what to write to the table. */
  changes: { label: DiffLabel; row: StoredFinding }[];
  summary: ScanSummary;
}

/**
 * Compares one scan with everything stored for the same project and scan type.
 *
 * - NEW: never seen before, or FIXED earlier and back now (it reopens; firstSeenJobId stays).
 * - STILL_OPEN: open before and seen again (lastSeenJobId and the scanner's text are updated).
 * - FIXED: open before and missing now (the row is kept; lastSeenJobId stays the last scan that saw it).
 *
 * Findings that were already FIXED and are still missing are untouched and not returned.
 * Pure function: the inputs are not changed. Rules and reasoning: docs/fingerprints.md.
 */
export function diffFindings(
  previous: readonly StoredFinding[],
  current: readonly ScannedFinding[],
  jobId: string,
): DiffResult {
  const before = new Map(previous.map((f) => [f.fingerprint, f]));
  // A scanner can report the same fingerprint twice (identical code twice in one file). It is one bug.
  const seen = new Map<string, ScannedFinding>();
  for (const f of current) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, f);

  const changes: DiffResult["changes"] = [];
  for (const f of seen.values()) {
    const old = before.get(f.fingerprint);
    const label: DiffLabel = old === undefined || old.state === "FIXED" ? "NEW" : "STILL_OPEN";
    // The scanner's latest text wins; firstSeenJobId is set once and never moves.
    changes.push({
      label,
      row: toRow(f, "OPEN", old?.firstSeenJobId ?? jobId, jobId),
    });
  }
  // `before`, not `previous`, so a duplicated stored row cannot be counted as fixed twice.
  for (const old of before.values()) {
    if (old.state === "OPEN" && !seen.has(old.fingerprint)) {
      changes.push({
        label: "FIXED",
        row: toRow(old, "FIXED", old.firstSeenJobId, old.lastSeenJobId),
      });
    }
  }

  // Same order every time, so writes and tests are predictable.
  changes.sort((a, b) => compare(a.row.fingerprint, b.row.fingerprint));

  const summary: ScanSummary = { new: 0, newHigh: 0, stillOpen: 0, fixed: 0 };
  for (const { label, row } of changes) {
    if (label === "NEW") {
      summary.new++;
      if (row.severity === "HIGH") summary.newHigh++;
    } else if (label === "STILL_OPEN") {
      summary.stillOpen++;
    } else {
      summary.fixed++;
    }
  }
  return { changes, summary };
}

/** Builds a row with exactly the contract's fields, so nothing extra (such as `pk`) leaks through. */
function toRow(
  f: ScannedFinding,
  state: FindingState,
  firstSeenJobId: string,
  lastSeenJobId: string,
): StoredFinding {
  return {
    fingerprint: f.fingerprint,
    ruleId: f.ruleId,
    severity: f.severity,
    location: f.location,
    message: f.message,
    state,
    firstSeenJobId,
    lastSeenJobId,
  };
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
