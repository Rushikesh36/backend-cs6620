import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_MESSAGE, ReportError } from "../common/findings/report.js";
import { parseSemgrep } from "../common/findings/semgrep.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
// Real Semgrep 1.183.0 reports (`--config p/python --json`) of tests/fixtures/sample-app, trimmed.
const report = (name: string): unknown =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture path
  JSON.parse(readFileSync(join(FIXTURES, "reports", name), "utf8"));

/** What the scanner wrapper (Task 21) will do: read the matched lines from the scanned source. */
const readLinesFrom =
  (version: string) =>
  (path: string, start: number, end: number): string =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture path
    readFileSync(join(FIXTURES, "sample-app", version, path), "utf8")
      .split("\n")
      .slice(start - 1, end)
      .join("\n");

const result = (over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  check_id: "python.lang.security.audit.eval-injection",
  path: "app/views.py",
  start: { line: 29, col: 5 },
  end: { line: 29, col: 30 },
  extra: { message: "Eval with user input.", severity: "ERROR", lines: "eval(x)", ...extra },
  ...over,
});

describe("real Semgrep report", () => {
  const { findings, warnings } = parseSemgrep(report("semgrep-v1.json"), {
    readLines: readLinesFrom("v1"),
  });

  it("parses every result with no warnings", () => {
    expect(findings).toHaveLength(6);
    expect(warnings).toEqual([]);
  });

  it("maps rule, location, severity and message", () => {
    const sql = findings.find((f) => f.identity.ruleId.endsWith("tainted-sql-string"));
    expect(sql).toMatchObject({
      severity: "HIGH",
      location: "app/views.py:13",
      identity: { scanType: "SAST", filePath: "app/views.py" },
    });
    expect(sql?.message).toMatch(/^Detected user input used to manually construct a SQL string/);
  });

  it("reads the code from the source when Semgrep says 'requires login'", () => {
    const sql = findings.find((f) => f.identity.ruleId.endsWith("tainted-sql-string"));
    expect(sql?.identity).toMatchObject({
      snippet: `    cursor.execute("SELECT * FROM users WHERE id = '%s'" % user_id)`,
    });
  });

  it("without a way to read the source, falls back to the line and warns", () => {
    const fallback = parseSemgrep(report("semgrep-v1.json"));
    expect(fallback.findings).toHaveLength(6);
    expect(fallback.findings[0]?.identity).toMatchObject({ snippet: "line:4" });
    expect(fallback.warnings).toHaveLength(6);
  });
});

describe("severity mapping", () => {
  it.each([
    ["ERROR", "HIGH"],
    ["CRITICAL", "HIGH"],
    ["HIGH", "HIGH"],
    ["WARNING", "MEDIUM"],
    ["MEDIUM", "MEDIUM"],
    ["INFO", "LOW"],
    ["LOW", "LOW"],
    ["error", "HIGH"],
  ])("Semgrep %s is %s", (semgrep, ours) => {
    const { findings } = parseSemgrep({ results: [result({}, { severity: semgrep })] });
    expect(findings[0]?.severity).toBe(ours);
  });

  it("treats an unknown severity as INFO and warns", () => {
    const { findings, warnings } = parseSemgrep({
      results: [result({}, { severity: "EXPERIMENT" })],
    });
    expect(findings[0]?.severity).toBe("INFO");
    expect(warnings[0]).toContain("unknown severity");
  });

  it("does not let text such as 'constructor' match built-in object keys", () => {
    for (const severity of ["constructor", "__proto__"]) {
      const { findings } = parseSemgrep({ results: [result({}, { severity })] });
      expect(findings[0]?.severity).toBe("INFO");
    }
  });
});

describe("code snippet", () => {
  it("uses extra.lines when Semgrep provides it", () => {
    const { findings } = parseSemgrep({ results: [result()] });
    expect(findings[0]?.identity).toMatchObject({ snippet: "eval(x)" });
  });

  it("passes the start and end line to readLines", () => {
    const calls: unknown[] = [];
    parseSemgrep(
      { results: [result({ start: { line: 3 }, end: { line: 5 } }, { lines: "requires login" })] },
      { readLines: (...args) => (calls.push(args), "code") },
    );
    expect(calls).toEqual([["app/views.py", 3, 5]]);
  });
});

describe("untrusted input", () => {
  it("rejects a report without a results list", () => {
    expect(() => parseSemgrep({})).toThrow(ReportError);
    expect(() => parseSemgrep(null)).toThrow(ReportError);
    expect(() => parseSemgrep([])).toThrow(ReportError);
  });

  it("skips broken results and warns, keeping the good ones", () => {
    const { findings, warnings } = parseSemgrep({
      results: [
        result(),
        null,
        result({ check_id: 7 }),
        result({ path: undefined }),
        result({ start: {} }),
      ],
    });
    expect(findings).toHaveLength(1);
    expect(warnings).toHaveLength(4);
  });

  it("stores the message as single-spaced plain text, capped in length", () => {
    const long = `<b>bold</b>\n\n${"x".repeat(5000)}`;
    const { findings } = parseSemgrep({ results: [result({}, { message: long })] });
    const message = findings[0]?.message ?? "";
    expect(message.startsWith("<b>bold</b> x")).toBe(true);
    expect(message).toHaveLength(MAX_MESSAGE);
  });

  it("uses the rule ID as the message when there is none", () => {
    const { findings } = parseSemgrep({ results: [result({}, { message: undefined })] });
    expect(findings[0]?.message).toBe("python.lang.security.audit.eval-injection");
  });
});
