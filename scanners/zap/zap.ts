import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isObject, ReportError } from "../../common/findings/report.js";
import { parseZap } from "../../common/findings/zap.js";
import type { logger } from "../../common/logger.js";
import {
  EXIT,
  readJobConfig,
  reportKey,
  requireSetting,
  ScanError,
  type Env,
  type JobConfig,
} from "../common/job.js";
import type { RunOptions, RunResult } from "../common/run.js";

/** ZAP's scan scripts read and write files only in this folder when they run in a container. */
export const ZAP_WORK_DIR = "/zap/wrk";
const REPORT_FILE = "report.json";

/**
 * ZAP's own limits, in minutes. Worst case: start (3) + spider (5) + active scan (10) + passive
 * scan (3) = 21, inside the 22-minute hard timeout, which is under the reaper's 25.
 */
export const SPIDER_MINUTES = 5;
export const ACTIVE_SCAN_MINUTES = 10;
/** How long ZAP may take to start, and again to finish the passive scan. */
export const START_AND_PASSIVE_MINUTES = 3;
export const DEFAULT_TIMEOUT_SECONDS = 22 * 60;

export interface DastConfig extends JobConfig {
  targetUrl: string;
}

/** The launcher sends the test app's real URL from the allow-list, never one a user typed. */
export function readDastConfig(env: Env): DastConfig {
  const targetUrl = requireSetting(env, "TARGET_URL");
  let url: URL;
  try {
    url = new URL(targetUrl);
  } catch {
    throw new ScanError("TARGET_URL is not a URL.", EXIT.CONFIG);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new ScanError(
      "TARGET_URL must be an http:// or https:// URL without a password.",
      EXIT.CONFIG,
    );
  }
  return { ...readJobConfig(env, DEFAULT_TIMEOUT_SECONDS), targetUrl };
}

/**
 * zap-full-scan.py command line: spider, then active scan (ZAP "attacks" the app), then the
 * traditional JSON report the parser reads (docs/report-parsers.md).
 */
export function zapArgs(targetUrl: string): string[] {
  const zapOptions = [
    // No update checks, no add-on downloads, no telemetry: the scanner has no internet.
    // The beta rules the script would download are installed when the image is built.
    "-silent",
    "-config",
    `scanner.maxScanDurationInMins=${String(ACTIVE_SCAN_MINUTES)}`,
  ].join(" ");
  return [
    "-t",
    targetUrl,
    "-J",
    REPORT_FILE,
    "-m",
    String(SPIDER_MINUTES),
    "-T",
    String(START_AND_PASSIVE_MINUTES),
    // Warnings are findings, not a failed scan: exit 0 unless something broke.
    "-I",
    "-z",
    zapOptions,
  ];
}

export interface DastDeps {
  /** ZAP_WORK_DIR in the image; a temporary folder in tests. */
  workDir: string;
  upload: (bucket: string, key: string, report: unknown) => Promise<void>;
  run: (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
  /** Milliseconds left before the hard timeout; throws ScanError(TIMEOUT) when none are. */
  timeLeft: () => number;
  log: typeof logger;
}

/**
 * zap-full-scan.py exits 0 (no problems), 1 (a FAIL rule), 2 (warnings) or 3 (ZAP or the scan
 * failed). 0 to 2 all mean the scan ran and wrote its report.
 */
const SCAN_RAN = new Set([0, 1, 2]);

/**
 * True if ZAP got at least one HTTP answer from the target. When the test app is down, ZAP still
 * exits 0 with an empty report, and uploading that would mark every open finding FIXED. ZAP 2.x
 * records the share of responses per status class as `insight.code.2xx` and so on; a report with
 * none of those and no alerts never reached the app. (Older reports without insights count as
 * reached if they have alerts.)
 */
export function reachedTarget(report: unknown): boolean {
  if (!isObject(report)) return false;
  const insights = Array.isArray(report.insights) ? report.insights : [];
  const answered = insights.some(
    (i) =>
      isObject(i) &&
      typeof i.key === "string" &&
      i.key.startsWith("insight.code.") &&
      Number(i.statistic) > 0,
  );
  const sites = Array.isArray(report.site) ? report.site : [];
  const alerts = sites.some((s) => isObject(s) && Array.isArray(s.alerts) && s.alerts.length > 0);
  return answered || alerts;
}

/** One DAST scan: run ZAP against the target, check the report, upload it. */
export async function runDast(config: DastConfig, deps: DastDeps): Promise<void> {
  const { log } = deps;
  const reportFile = join(deps.workDir, REPORT_FILE);

  log.info("Starting ZAP", { target: config.targetUrl });
  const result = await deps.run("zap-full-scan.py", zapArgs(config.targetUrl), {
    cwd: deps.workDir,
    timeoutMs: deps.timeLeft(),
    onLine: (stream, line) => {
      log.info("zap output", { stream, line: line.slice(0, 2000) });
    },
  });
  if (result.timedOut) throw new ScanError("ZAP did not finish in time.", EXIT.TIMEOUT);
  if (result.exitCode === null || !SCAN_RAN.has(result.exitCode)) {
    throw new ScanError(
      `ZAP exited with code ${String(result.exitCode ?? result.signal)}.`,
      EXIT.SCANNER,
    );
  }

  let report: unknown;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    throw new ScanError("ZAP did not write a readable report.", EXIT.SCANNER);
  }
  if (!reachedTarget(report)) {
    throw new ScanError("ZAP got no answer from the target; is the test app running?", EXIT.TARGET);
  }
  try {
    const parsed = parseZap(report);
    log.info("ZAP finished", {
      zapExitCode: result.exitCode,
      findings: parsed.findings.length,
      warnings: parsed.warnings.length,
    });
  } catch (err) {
    if (err instanceof ReportError) throw new ScanError(err.message, EXIT.SCANNER);
    throw err;
  }

  await deps.upload(config.reportsBucket, reportKey(config.jobId), report);
  log.info("Report uploaded", { bucket: config.reportsBucket, key: reportKey(config.jobId) });
}
