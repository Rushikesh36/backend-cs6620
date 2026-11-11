import type { Severity } from "./fingerprint.js";
import {
  cleanText,
  isObject,
  MAX_LOCATION,
  MAX_MESSAGE,
  MAX_RULE_ID,
  ReportError,
  str,
  type ParsedFinding,
  type ParseResult,
} from "./report.js";

/**
 * Semgrep severities to ours. ERROR, WARNING and INFO are the classic levels; newer Semgrep
 * versions can also say CRITICAL, HIGH, MEDIUM or LOW. Anything else counts as INFO.
 * Documented in docs/report-parsers.md.
 */
// A Map, not an object: scanner text like "constructor" must not match built-in object keys.
const SEVERITY = new Map<string, Severity>([
  ["CRITICAL", "HIGH"],
  ["ERROR", "HIGH"],
  ["HIGH", "HIGH"],
  ["WARNING", "MEDIUM"],
  ["MEDIUM", "MEDIUM"],
  ["INFO", "LOW"],
  ["LOW", "LOW"],
]);

/** What free Semgrep writes in `extra.lines` (and `extra.fingerprint`) when nobody is logged in. */
export const LOGIN_PLACEHOLDER = "requires login";

export interface SemgrepOptions {
  /**
   * Reads lines `start` to `end` (1-based, inclusive) of a scanned file. Used when the report has
   * no code (`extra.lines` is "requires login"). The scanner wrapper (Task 21) has the source.
   */
  readLines?: (path: string, start: number, end: number) => string | undefined;
}

/** Turns a Semgrep `--json` report into findings. Throws ReportError if the report itself is unusable. */
export function parseSemgrep(report: unknown, options: SemgrepOptions = {}): ParseResult {
  if (!isObject(report) || !Array.isArray(report.results)) {
    throw new ReportError("Semgrep report has no results list.");
  }
  const findings: ParsedFinding[] = [];
  const warnings: string[] = [];

  report.results.forEach((raw: unknown, i) => {
    const r = isObject(raw) ? raw : {};
    const extra = isObject(r.extra) ? r.extra : {};
    const ruleId = str(r.check_id);
    const path = str(r.path);
    const start = isObject(r.start) ? r.start.line : undefined;
    const end = isObject(r.end) ? r.end.line : start;
    if (!ruleId || !path || !isLine(start)) {
      warnings.push(`Semgrep result ${String(i)} skipped: missing rule, path or line.`);
      return;
    }
    const last = isLine(end) && end >= start ? end : start;

    const rawSeverity = (str(extra.severity) ?? "").toUpperCase();
    const severity = SEVERITY.get(rawSeverity) ?? "INFO";
    if (!SEVERITY.has(rawSeverity)) {
      warnings.push(`Semgrep result ${String(i)}: unknown severity "${rawSeverity}", using INFO.`);
    }

    let snippet = str(extra.lines);
    if (snippet === undefined || snippet.trim() === "" || snippet.trim() === LOGIN_PLACEHOLDER) {
      snippet = options.readLines?.(path, start, last);
    }
    if (snippet === undefined || snippet.trim() === "") {
      // Without the code, the line is the only way to keep different bugs apart. Moving the code
      // will then make this finding look FIXED and NEW once; merging bugs would hide them instead.
      snippet = `line:${String(start)}`;
      warnings.push(`Semgrep result ${String(i)}: no code snippet, fingerprint uses the line.`);
    }

    findings.push({
      identity: {
        scanType: "SAST",
        ruleId: cleanText(ruleId, MAX_RULE_ID),
        filePath: path,
        snippet,
      },
      severity,
      location: cleanText(`${path}:${String(start)}`, MAX_LOCATION),
      message: cleanText(str(extra.message) ?? ruleId, MAX_MESSAGE),
    });
  });

  return { findings, warnings };
}

const isLine = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;
