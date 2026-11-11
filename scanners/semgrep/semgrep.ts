import { mkdir, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isObject, ReportError } from "../../common/findings/report.js";
import { LOGIN_PLACEHOLDER, parseSemgrep } from "../../common/findings/semgrep.js";
import type { logger } from "../../common/logger.js";
import {
  EXIT,
  readJobConfig,
  reportKey,
  requireSetting,
  ScanError,
  uploadKey,
  type Env,
  type JobConfig,
} from "../common/job.js";
import type { RunOptions, RunResult } from "../common/run.js";
import { extractZip, type ZipLimits } from "../common/unzip.js";

/** Where the Dockerfile puts the rule packs. Semgrep runs offline with only these rules. */
export const RULES_DIR = "/opt/semgrep-rules";

/** Same as start-scan's MAX_ZIP_BYTES: start-scan already refused anything bigger. */
export const MAX_ZIP_BYTES = 50 * 1024 * 1024;

/** 10 minutes, well under the reaper's 25. */
export const DEFAULT_TIMEOUT_SECONDS = 10 * 60;

/** The matched code put back into a report is capped, so one huge match cannot bloat it. */
export const MAX_MATCHED_CODE = 4000;

export interface SastConfig extends JobConfig {
  uploadsBucket: string;
}

export function readSastConfig(env: Env): SastConfig {
  return {
    ...readJobConfig(env, DEFAULT_TIMEOUT_SECONDS),
    uploadsBucket: requireSetting(env, "UPLOADS_BUCKET"),
  };
}

/**
 * Semgrep command line. It runs inside the unpacked source folder on ".", so paths in the report
 * are relative (app/views.py), which the parser and the fingerprint need (docs/report-parsers.md).
 */
export function semgrepArgs(reportFile: string, rulesDir: string = RULES_DIR): string[] {
  return [
    "scan",
    "--config",
    rulesDir,
    "--json",
    "--output",
    reportFile,
    "--metrics",
    "off",
    "--disable-version-check",
    // Scan the same files whether or not the zip has a .git folder.
    "--no-git-ignore",
    ".",
  ];
}

/**
 * Semgrep names rules from a local folder after that folder: /opt/semgrep-rules turns
 * "python.lang...md5" into "opt.semgrep-rules.python.lang...md5". We remove that prefix so rule
 * IDs match the Semgrep registry and stay the same if the folder ever moves.
 */
export function rulePrefix(rulesDir: string = RULES_DIR): string {
  return `${rulesDir.split("/").filter(Boolean).join(".")}.`;
}

export function stripRulePrefix(report: unknown, rulesDir: string = RULES_DIR): void {
  if (!isObject(report) || !Array.isArray(report.results)) return;
  const prefix = rulePrefix(rulesDir);
  for (const result of report.results) {
    if (isObject(result) && typeof result.check_id === "string") {
      if (result.check_id.startsWith(prefix)) {
        result.check_id = result.check_id.slice(prefix.length);
      }
    }
  }
}

/** Reads lines start..end (1-based) of a file under srcDir. Undefined if it is not there. */
export function sourceReader(srcDir: string) {
  const root = resolve(srcDir);
  const cache = new Map<string, string[] | undefined>();
  return async (path: string, start: number, end: number): Promise<string | undefined> => {
    const file = resolve(root, path);
    const inside = relative(root, file);
    if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`)) return undefined;
    if (!cache.has(file)) {
      try {
        cache.set(file, (await readFile(file, "utf8")).split(/\r?\n/));
      } catch {
        cache.set(file, undefined);
      }
    }
    const lines = cache.get(file);
    if (!lines || start < 1 || end < start || start > lines.length) return undefined;
    return lines
      .slice(start - 1, end)
      .join("\n")
      .slice(0, MAX_MATCHED_CODE);
  };
}

/**
 * Free Semgrep writes "requires login" instead of the matched code. The processor (Task 19) has
 * only the report, and the fingerprint needs the code, so we put the code back from the source.
 * Returns how many results were filled.
 */
export async function fillMatchedCode(
  report: unknown,
  readLines: (path: string, start: number, end: number) => Promise<string | undefined>,
): Promise<number> {
  if (!isObject(report) || !Array.isArray(report.results)) return 0;
  let filled = 0;
  for (const result of report.results) {
    if (!isObject(result) || !isObject(result.extra)) continue;
    const lines = result.extra.lines;
    if (typeof lines === "string" && lines.trim() !== "" && lines.trim() !== LOGIN_PLACEHOLDER) {
      continue;
    }
    const start = isObject(result.start) ? result.start.line : undefined;
    const end = isObject(result.end) ? result.end.line : start;
    if (typeof result.path !== "string" || typeof start !== "number") continue;
    const code = await readLines(result.path, start, typeof end === "number" ? end : start);
    if (code !== undefined) {
      result.extra.lines = code;
      filled += 1;
    }
  }
  return filled;
}

export interface SastDeps {
  /** Empty folder for this job; deleted by main.ts afterwards. */
  workDir: string;
  /** Downloads one S3 object to a file (scanners/common/storage.ts). */
  download: (bucket: string, key: string, file: string, maxBytes: number) => Promise<void>;
  upload: (bucket: string, key: string, report: unknown) => Promise<void>;
  run: (command: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
  /** Milliseconds left before the hard timeout; throws ScanError(TIMEOUT) when none are. */
  timeLeft: () => number;
  log: typeof logger;
  rulesDir?: string;
  zipLimits?: ZipLimits;
}

/**
 * A zip of a folder holds one top-level folder ("myapp/app/views.py"). Scanning inside it keeps
 * paths, and so fingerprints, the same whether the user zipped the folder or its contents, and
 * whatever the folder was called.
 */
export async function findScanRoot(srcDir: string): Promise<string> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  const only = entries.length === 1 ? entries[0] : undefined;
  return only?.isDirectory() ? join(srcDir, only.name) : srcDir;
}

/** One SAST scan: download the zip, unpack it safely, run Semgrep offline, upload the report. */
export async function runSast(config: SastConfig, deps: SastDeps): Promise<void> {
  const { log } = deps;
  const rulesDir = deps.rulesDir ?? RULES_DIR;
  const zipFile = join(deps.workDir, "upload.zip");
  const srcDir = join(deps.workDir, "src");
  const reportFile = join(deps.workDir, "semgrep.json");

  log.info("Downloading the upload", { bucket: config.uploadsBucket });
  await deps.download(config.uploadsBucket, uploadKey(config.jobId), zipFile, MAX_ZIP_BYTES);
  await mkdir(srcDir);
  const unzipped = await extractZip(zipFile, srcDir, deps.zipLimits);
  log.info("Upload unpacked", { ...unzipped });
  if (unzipped.files === 0) throw new ScanError("The upload has no files to scan.", EXIT.INPUT);
  const scanRoot = await findScanRoot(srcDir);

  log.info("Starting Semgrep");
  const result = await deps.run("semgrep", semgrepArgs(reportFile, rulesDir), {
    cwd: scanRoot,
    timeoutMs: deps.timeLeft(),
    onLine: (stream, line) => {
      log.info("semgrep output", { stream, line: line.slice(0, 2000) });
    },
  });
  if (result.timedOut) throw new ScanError("Semgrep did not finish in time.", EXIT.TIMEOUT);
  // Without --error, Semgrep exits 0 when the scan worked, with or without findings.
  if (result.exitCode !== 0) {
    throw new ScanError(
      `Semgrep exited with code ${String(result.exitCode ?? result.signal)}.`,
      EXIT.SCANNER,
    );
  }

  let report: unknown;
  try {
    report = JSON.parse(await readFile(reportFile, "utf8"));
  } catch {
    throw new ScanError("Semgrep did not write a readable report.", EXIT.SCANNER);
  }
  stripRulePrefix(report, rulesDir);
  const filled = await fillMatchedCode(report, sourceReader(scanRoot));

  // Parse here too, so a report the processor could not read fails the scan now, with a reason.
  let findings: number;
  let warnings: number;
  try {
    const parsed = parseSemgrep(report);
    findings = parsed.findings.length;
    warnings = parsed.warnings.length;
  } catch (err) {
    if (err instanceof ReportError) throw new ScanError(err.message, EXIT.SCANNER);
    throw err;
  }
  const errors = isObject(report) && Array.isArray(report.errors) ? report.errors.length : 0;
  log.info("Semgrep finished", { findings, codeFilled: filled, warnings, semgrepErrors: errors });

  await deps.upload(config.reportsBucket, reportKey(config.jobId), report);
  log.info("Report uploaded", { bucket: config.reportsBucket, key: reportKey(config.jobId) });
}
