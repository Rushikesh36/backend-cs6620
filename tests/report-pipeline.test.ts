// Real scanner reports through the whole findings pipeline: parser -> fingerprint -> diff.
// Version 2 of the sample code moved and reformatted bugs, fixed one and added one.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { diffFindings, type DiffResult, type StoredFinding } from "../common/findings/diff.js";
import { toScanned, type ParseResult } from "../common/findings/report.js";
import { parseSemgrep } from "../common/findings/semgrep.js";
import { parseZap } from "../common/findings/zap.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
// eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture paths
const read = (...parts: string[]) => readFileSync(join(FIXTURES, ...parts), "utf8");

const semgrep = (version: string): ParseResult =>
  parseSemgrep(JSON.parse(read("reports", `semgrep-${version}.json`)), {
    readLines: (path, start, end) =>
      read("sample-app", version, path)
        .split("\n")
        .slice(start - 1, end)
        .join("\n"),
  });
const zap = (version: string): ParseResult =>
  parseZap(JSON.parse(read("reports", `zap-${version}.json`)));

/** Two scans of one project, the way the processor (Task 19) will run them. */
function twoScans(parse: (version: string) => ParseResult): DiffResult {
  const first = diffFindings(
    [],
    parse("v1").findings.map((f) => toScanned("demo", f)),
    "job-1",
  );
  const table: StoredFinding[] = first.changes.map((c) => c.row);
  return diffFindings(
    table,
    parse("v2").findings.map((f) => toScanned("demo", f)),
    "job-2",
  );
}

const short = (result: DiffResult, label: string) =>
  result.changes
    .filter((c) => c.label === label)
    .map((c) => `${c.row.ruleId.split(".").pop() ?? ""} ${c.row.location}`)
    .sort();

describe("SAST: real Semgrep reports", () => {
  const result = twoScans(semgrep);

  it("keeps moved and reformatted bugs as STILL_OPEN", () => {
    expect(short(result, "STILL_OPEN")).toEqual([
      "dangerous-subprocess-use app/views.py:24",
      "sql-injection-db-cursor-execute app/views.py:14",
      "subprocess-injection app/views.py:24",
      "subprocess-shell-true app/views.py:24",
      "tainted-sql-string app/views.py:17",
    ]);
  });

  it("finds the fixed MD5 and the new eval", () => {
    expect(short(result, "FIXED")).toEqual(["insecure-hash-algorithm-md5 app/config.py:4"]);
    expect(short(result, "NEW")).toEqual([
      "eval-injection app/views.py:29",
      "user-eval app/views.py:29",
    ]);
    expect(result.summary).toEqual({ new: 2, newHigh: 1, stillOpen: 5, fixed: 1 });
  });
});

describe("DAST: real ZAP reports", () => {
  const result = twoScans(zap);

  it("sees the XSS move from /search to /greet and nothing else", () => {
    expect(short(result, "FIXED")).toEqual(["40012 GET /search?q", "40026 GET /search?q"]);
    expect(short(result, "NEW")).toEqual(["40012 GET /greet?name", "40026 GET /greet?name"]);
    expect(result.summary).toMatchObject({ new: 2, newHigh: 2, fixed: 2 });
  });

  it("keeps site-wide alerts stable although ZAP sampled different pages", () => {
    expect(short(result, "STILL_OPEN")).toContain("10036-2 GET / (site-wide)");
  });
});
