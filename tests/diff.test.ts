import { describe, expect, it } from "vitest";
import {
  diffFindings,
  type DiffResult,
  type ScannedFinding,
  type StoredFinding,
} from "../common/findings/diff.js";
import { fingerprint, type Severity } from "../common/findings/fingerprint.js";

const PROJECT = "demo";

/** A SAST finding as a parser (Task 17) would hand it over. */
function scanned(
  file: string,
  line: number,
  snippet: string,
  severity: Severity = "HIGH",
  ruleId = "python.sqli",
): ScannedFinding {
  return {
    fingerprint: fingerprint(PROJECT, { scanType: "SAST", ruleId, filePath: file, snippet }),
    ruleId,
    severity,
    location: `${file}:${String(line)}`,
    message: `${ruleId} in ${file}`,
  };
}

/** What the processor would write back after a scan. */
const rows = (result: DiffResult): StoredFinding[] => result.changes.map((c) => c.row);

/** The table after a scan: old rows, replaced by any the scan changed. */
function apply(table: StoredFinding[], result: DiffResult): StoredFinding[] {
  const byFp = new Map(table.map((r) => [r.fingerprint, r]));
  for (const row of rows(result)) byFp.set(row.fingerprint, row);
  return [...byFp.values()];
}

const labelOf = (result: DiffResult, f: ScannedFinding) =>
  result.changes.find((c) => c.row.fingerprint === f.fingerprint)?.label;

const sqli = scanned("app/views.py", 42, 'execute("SELECT " + id)');
const secret = scanned("app/config.py", 7, 'PASSWORD = "hunter2"', "MEDIUM", "generic.secret");
const xss = scanned("app/templates.py", 12, "render(raw(name))", "HIGH", "python.xss");

describe("first scan of a project", () => {
  const result = diffFindings([], [sqli, secret], "job-1");

  it("labels everything NEW and OPEN, first and last seen in this scan", () => {
    expect(result.changes.map((c) => c.label)).toEqual(["NEW", "NEW"]);
    for (const row of rows(result)) {
      expect(row.state).toBe("OPEN");
      expect(row.firstSeenJobId).toBe("job-1");
      expect(row.lastSeenJobId).toBe("job-1");
    }
  });

  it("counts new and new HIGH", () => {
    expect(result.summary).toEqual({ new: 2, newHigh: 1, stillOpen: 0, fixed: 0 });
  });
});

describe("second scan: one fixed, one new, one still open", () => {
  const table = apply([], diffFindings([], [sqli, secret], "job-1"));
  const result = diffFindings(table, [sqli, xss], "job-2");

  it("labels each finding correctly", () => {
    expect(labelOf(result, sqli)).toBe("STILL_OPEN");
    expect(labelOf(result, secret)).toBe("FIXED");
    expect(labelOf(result, xss)).toBe("NEW");
    expect(result.summary).toEqual({ new: 1, newHigh: 1, stillOpen: 1, fixed: 1 });
  });

  it("keeps the fixed row, with the last scan that still saw it", () => {
    const fixed = rows(result).find((r) => r.fingerprint === secret.fingerprint);
    expect(fixed).toMatchObject({
      state: "FIXED",
      firstSeenJobId: "job-1",
      lastSeenJobId: "job-1",
    });
  });

  it("moves lastSeenJobId forward for the still-open finding", () => {
    const open = rows(result).find((r) => r.fingerprint === sqli.fingerprint);
    expect(open).toMatchObject({ state: "OPEN", firstSeenJobId: "job-1", lastSeenJobId: "job-2" });
  });
});

describe("the code moves but the bug stays", () => {
  it("keeps the same finding when its line number shifts, and shows the new line", () => {
    const table = apply([], diffFindings([], [sqli], "job-1"));
    const moved = scanned("app/views.py", 45, 'execute("SELECT " + id)');
    expect(moved.fingerprint).toBe(sqli.fingerprint);

    const result = diffFindings(table, [moved], "job-2");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.label).toBe("STILL_OPEN");
    expect(result.changes[0]?.row.location).toBe("app/views.py:45");
    expect(result.summary).toEqual({ new: 0, newHigh: 0, stillOpen: 1, fixed: 0 });
  });
});

describe("a fixed finding comes back", () => {
  let table = apply([], diffFindings([], [sqli], "job-1"));
  table = apply(table, diffFindings(table, [], "job-2"));
  const result = diffFindings(table, [sqli], "job-3");

  it("counts it as NEW again and reopens it", () => {
    expect(labelOf(result, sqli)).toBe("NEW");
    expect(result.summary).toEqual({ new: 1, newHigh: 1, stillOpen: 0, fixed: 0 });
  });

  it("keeps the scan that first saw it", () => {
    expect(rows(result)[0]).toMatchObject({
      state: "OPEN",
      firstSeenJobId: "job-1",
      lastSeenJobId: "job-3",
    });
  });
});

describe("findings that are already fixed and still missing", () => {
  it("are left alone and not counted again", () => {
    let table = apply([], diffFindings([], [sqli, secret], "job-1"));
    table = apply(table, diffFindings(table, [sqli], "job-2"));
    const result = diffFindings(table, [sqli], "job-3");
    expect(labelOf(result, secret)).toBeUndefined();
    expect(result.summary).toEqual({ new: 0, newHigh: 0, stillOpen: 1, fixed: 0 });
  });
});

describe("newHigh", () => {
  it("counts only NEW findings with severity HIGH", () => {
    const table = apply([], diffFindings([], [sqli], "job-1"));
    const medium = scanned("a.py", 1, "m()", "MEDIUM", "r.medium");
    const low = scanned("a.py", 2, "l()", "LOW", "r.low");
    const info = scanned("a.py", 3, "i()", "INFO", "r.info");
    const high = scanned("a.py", 4, "h()", "HIGH", "r.high");
    const result = diffFindings(table, [sqli, medium, low, info, high], "job-2");
    // sqli is HIGH but STILL_OPEN, so only `high` counts.
    expect(result.summary).toEqual({ new: 4, newHigh: 1, stillOpen: 1, fixed: 0 });
  });

  it("counts a returning HIGH finding", () => {
    let table = apply([], diffFindings([], [sqli], "job-1"));
    table = apply(table, diffFindings(table, [], "job-2"));
    expect(diffFindings(table, [sqli], "job-3").summary.newHigh).toBe(1);
  });
});

describe("edge cases", () => {
  it("treats the same fingerprint twice in one scan as one finding", () => {
    const again = { ...sqli, location: "app/views.py:90" };
    const result = diffFindings([], [sqli, again], "job-1");
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]?.row.location).toBe("app/views.py:42");
    expect(result.summary.new).toBe(1);
  });

  it("marks everything open as FIXED when a scan finds nothing", () => {
    const table = apply([], diffFindings([], [sqli, secret], "job-1"));
    expect(diffFindings(table, [], "job-2").summary).toEqual({
      new: 0,
      newHigh: 0,
      stillOpen: 0,
      fixed: 2,
    });
  });

  it("returns an empty result for an empty project and an empty scan", () => {
    expect(diffFindings([], [], "job-1")).toEqual({
      changes: [],
      summary: { new: 0, newHigh: 0, stillOpen: 0, fixed: 0 },
    });
  });

  it("updates the scanner's text (severity, message) on a still-open finding", () => {
    const table = apply([], diffFindings([], [sqli], "job-1"));
    const reworded = { ...sqli, severity: "MEDIUM" as const, message: "New wording" };
    const row = rows(diffFindings(table, [reworded], "job-2"))[0];
    expect(row).toMatchObject({ severity: "MEDIUM", message: "New wording", state: "OPEN" });
  });

  it("does not change its inputs", () => {
    const table = apply([], diffFindings([], [sqli, secret], "job-1"));
    const tableCopy = structuredClone(table);
    const scan = [xss];
    const scanCopy = structuredClone(scan);
    diffFindings(table, scan, "job-2");
    expect(table).toEqual(tableCopy);
    expect(scan).toEqual(scanCopy);
  });

  it("returns changes in the same order every time", () => {
    const a = diffFindings([], [sqli, secret, xss], "job-1");
    const b = diffFindings([], [xss, sqli, secret], "job-1");
    expect(rows(a).map((r) => r.fingerprint)).toEqual(rows(b).map((r) => r.fingerprint));
  });

  it("returns rows with exactly the contract's fields, even if stored rows carry extras like pk", () => {
    const table = apply([], diffFindings([], [sqli, secret], "job-1")).map((r) => ({
      ...r,
      pk: "demo#SAST",
    }));
    const contractFields = [
      "fingerprint",
      "firstSeenJobId",
      "lastSeenJobId",
      "location",
      "message",
      "ruleId",
      "severity",
      "state",
    ];
    for (const row of rows(diffFindings(table, [sqli], "job-2"))) {
      expect(Object.keys(row).sort()).toEqual(contractFields);
    }
  });

  it("counts a stored row only once, even if it appears twice", () => {
    const table = apply([], diffFindings([], [secret], "job-1"));
    const doubled = [...table, ...table];
    expect(diffFindings(doubled, [], "job-2").summary.fixed).toBe(1);
  });
});
