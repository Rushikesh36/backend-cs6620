/* eslint-disable security/detect-non-literal-fs-filename -- files in temporary test folders */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseZap } from "../common/findings/zap.js";
import { logger } from "../common/logger.js";
import { EXIT, MAX_TIMEOUT_SECONDS, ScanError } from "../scanners/common/job.js";
import type { RunOptions, RunResult } from "../scanners/common/run.js";
import {
  ACTIVE_SCAN_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  reachedTarget,
  readDastConfig,
  runDast,
  SPIDER_MINUTES,
  START_AND_PASSIVE_MINUTES,
  zapArgs,
  type DastConfig,
  type DastDeps,
} from "../scanners/zap/zap.js";

const JOB = "123e4567-e89b-42d3-a456-426614174001";
const ZAP_REPORT = readFileSync(
  join(import.meta.dirname, "fixtures", "reports", "zap-v1.json"),
  "utf8",
);

/** The exit code a ScanError thrown by fn carries, or undefined if fn did not throw one. */
function exitCodeOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof ScanError ? err.exitCode : undefined;
  }
  return undefined;
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dast-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readDastConfig", () => {
  const env = { JOB_ID: JOB, REPORTS_BUCKET: "reports", TARGET_URL: "http://10.0.1.20:3000" };

  it("reads the settings the launcher passes", () => {
    expect(readDastConfig(env)).toEqual({
      jobId: JOB,
      reportsBucket: "reports",
      targetUrl: "http://10.0.1.20:3000",
      timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    });
  });

  it.each([
    ["no target", undefined],
    ["not a URL", "juice shop"],
    ["not http", "file:///etc/passwd"],
    ["a password in the URL", "http://admin:secret@10.0.1.20:3000"],
  ])("is a configuration error for %s", (_what, targetUrl) => {
    expect(exitCodeOf(() => readDastConfig({ ...env, TARGET_URL: targetUrl }))).toBe(EXIT.CONFIG);
  });
});

describe("zapArgs", () => {
  it("runs ZAP silently (no update checks or downloads) and writes the JSON report", () => {
    const args = zapArgs("http://10.0.1.20:3000");
    expect(args.slice(0, 4)).toEqual(["-t", "http://10.0.1.20:3000", "-J", "report.json"]);
    expect(args).toContain("-I");
    const zapOptions = args[args.indexOf("-z") + 1] ?? "";
    expect(zapOptions.split(" ")).toContain("-silent");
    expect(zapOptions).toContain(`scanner.maxScanDurationInMins=${String(ACTIVE_SCAN_MINUTES)}`);
    expect(args[args.indexOf("-m") + 1]).toBe(String(SPIDER_MINUTES));
  });

  it("fits ZAP's own limits inside the hard timeout, and that under the reaper's 25 minutes", () => {
    const worstCaseMinutes = 2 * START_AND_PASSIVE_MINUTES + SPIDER_MINUTES + ACTIVE_SCAN_MINUTES;
    expect(worstCaseMinutes * 60).toBeLessThan(DEFAULT_TIMEOUT_SECONDS);
    expect(DEFAULT_TIMEOUT_SECONDS).toBeLessThanOrEqual(MAX_TIMEOUT_SECONDS);
  });
});

describe("runDast", () => {
  const config: DastConfig = {
    jobId: JOB,
    reportsBucket: "reports",
    targetUrl: "http://10.0.1.20:3000",
    timeoutMs: 60_000,
  };

  function deps(result: Partial<RunResult>, report: string | null = ZAP_REPORT) {
    const uploaded: { bucket: string; key: string; report: unknown }[] = [];
    const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
    const d: DastDeps = {
      workDir: dir,
      upload: (bucket, key, body) => {
        uploaded.push({ bucket, key, report: body });
        return Promise.resolve();
      },
      run: (command, args, options) => {
        calls.push({ command, args, options });
        if (report !== null) writeFileSync(join(dir, "report.json"), report);
        return Promise.resolve({ exitCode: 0, signal: null, timedOut: false, ...result });
      },
      timeLeft: () => 45_000,
      log: logger,
    };
    return { d, uploaded, calls };
  }

  it.each([0, 1, 2])("uploads the report when ZAP exits with %i (the scan ran)", async (code) => {
    const { d, uploaded, calls } = deps({ exitCode: code });
    await runDast(config, d);
    expect(calls[0]?.command).toBe("zap-full-scan.py");
    expect(calls[0]?.options).toMatchObject({ cwd: dir, timeoutMs: 45_000 });
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]?.key).toBe(`reports/${JOB}.json`);
    expect(uploaded[0]?.bucket).toBe("reports");
    expect(parseZap(uploaded[0]?.report).findings.length).toBeGreaterThan(0);
  });

  async function expectFailure(d: DastDeps, exitCode: number, message: RegExp) {
    const err: unknown = await runDast(config, d).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScanError);
    expect((err as ScanError).exitCode).toBe(exitCode);
    expect((err as ScanError).message).toMatch(message);
  }

  it("fails with SCANNER when ZAP itself failed (exit 3), even if a report is there", async () => {
    const { d, uploaded } = deps({ exitCode: 3 });
    await expectFailure(d, EXIT.SCANNER, /ZAP exited with code 3/);
    expect(uploaded).toEqual([]);
  });

  it("fails with SCANNER when ZAP was killed by a signal", async () => {
    const { d } = deps({ exitCode: null, signal: "SIGKILL" });
    await expectFailure(d, EXIT.SCANNER, /code SIGKILL/);
  });

  it("fails with TIMEOUT when ZAP runs out of time", async () => {
    const { d } = deps({ exitCode: null, signal: "SIGTERM", timedOut: true });
    await expectFailure(d, EXIT.TIMEOUT, /did not finish in time/);
  });

  it("fails with SCANNER when there is no report, or it is not a ZAP report", async () => {
    await expectFailure(deps({}, null).d, EXIT.SCANNER, /readable report/);
    await expectFailure(deps({}, "{not json").d, EXIT.SCANNER, /readable report/);
    const answered = [{ key: "insight.code.2xx", statistic: "90" }];
    await expectFailure(
      deps({}, JSON.stringify({ insights: answered, site: "not a list" })).d,
      EXIT.SCANNER,
      /no site list/,
    );
  });

  it("fails with TARGET when ZAP never reached the test app, instead of marking all FIXED", async () => {
    const { d, uploaded } = deps({ exitCode: 0 }, JSON.stringify(UNREACHED));
    await expectFailure(d, EXIT.TARGET, /no answer from the target/);
    expect(uploaded).toEqual([]);
  });
});

/** Trimmed from a real ZAP 2.17.0 report of a target that did not exist. */
const UNREACHED = {
  "@programName": "ZAP",
  "@version": "2.17.0",
  insights: [
    { level: "Low", site: "", key: "insight.log.warn", statistic: "97" },
    { level: "Info", site: "", key: "insight.network.failure", statistic: "100" },
  ],
  site: [{ "@name": "http://nothing-here:3000", alerts: [] }],
};

describe("reachedTarget", () => {
  it("is false when no request got an HTTP answer and nothing was found", () => {
    expect(reachedTarget(UNREACHED)).toBe(false);
    expect(reachedTarget(null)).toBe(false);
  });

  it("is true when some requests got answers, even if nothing was found", () => {
    const report = {
      ...UNREACHED,
      insights: [
        { key: "insight.network.failure", statistic: "11" },
        { site: "http://juiceshop:3000", key: "insight.code.4xx", statistic: "8" },
      ],
    };
    expect(reachedTarget(report)).toBe(true);
  });

  it("is true for a report with alerts but no insights (older ZAP versions)", () => {
    expect(reachedTarget(JSON.parse(ZAP_REPORT))).toBe(true);
  });
});
