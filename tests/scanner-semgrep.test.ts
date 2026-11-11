/* eslint-disable security/detect-non-literal-fs-filename -- files in temporary test folders */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedFinding } from "../common/findings/report.js";
import { parseSemgrep } from "../common/findings/semgrep.js";
import { logger } from "../common/logger.js";
import { uploadKey as createScanUploadKey } from "../lambdas/create-scan/create-scan.js";
import { reportKey as processorReportKey } from "../lambdas/processor/processor.js";
import { MAX_ZIP_BYTES as START_SCAN_MAX_ZIP_BYTES } from "../lambdas/start-scan/start-scan.js";
import {
  EXIT,
  MAX_TIMEOUT_SECONDS,
  reportKey,
  ScanError,
  uploadKey,
} from "../scanners/common/job.js";
import type { RunOptions, RunResult } from "../scanners/common/run.js";
import {
  DEFAULT_TIMEOUT_SECONDS,
  fillMatchedCode,
  findScanRoot,
  MAX_MATCHED_CODE,
  MAX_ZIP_BYTES,
  readSastConfig,
  rulePrefix,
  runSast,
  semgrepArgs,
  sourceReader,
  stripRulePrefix,
  type SastConfig,
  type SastDeps,
} from "../scanners/semgrep/semgrep.js";
import { buildZip } from "./zip-builder.js";

const JOB = "123e4567-e89b-42d3-a456-426614174001";
const FIXTURES = join(import.meta.dirname, "fixtures");
const SAMPLE_V1 = join(FIXTURES, "sample-app", "v1");
const RULES_DIR = "/opt/semgrep-rules";

const semgrepFixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, "reports", "semgrep-v1.json"), "utf8")) as Record<
    string,
    unknown
  >;

/** The fixture as the image's Semgrep writes it: rule IDs carry the rules folder as a prefix. */
function reportAsImageWritesIt(): Record<string, unknown> {
  const report = semgrepFixture();
  for (const r of report.results as { check_id: string }[]) {
    r.check_id = `opt.semgrep-rules.${r.check_id}`;
  }
  return report;
}

const snippet = (f: ParsedFinding | undefined): string =>
  f?.identity.scanType === "SAST" ? f.identity.snippet : "";

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
  dir = mkdtempSync(join(tmpdir(), "sast-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("keys and limits shared with the Lambdas", () => {
  it("uses the same S3 keys as create-scan and the processor", () => {
    expect(uploadKey(JOB)).toBe(createScanUploadKey(JOB));
    expect(reportKey(JOB)).toBe(processorReportKey(JOB));
  });

  it("refuses the same zip size as start-scan", () => {
    expect(MAX_ZIP_BYTES).toBe(START_SCAN_MAX_ZIP_BYTES);
  });
});

describe("readSastConfig", () => {
  const env = { JOB_ID: JOB, REPORTS_BUCKET: "reports", UPLOADS_BUCKET: "uploads" };

  it("reads the settings the launcher passes", () => {
    expect(readSastConfig(env)).toEqual({
      jobId: JOB,
      reportsBucket: "reports",
      uploadsBucket: "uploads",
      timeoutMs: DEFAULT_TIMEOUT_SECONDS * 1000,
    });
    expect(readSastConfig({ ...env, SCAN_TIMEOUT_SECONDS: "120" }).timeoutMs).toBe(120_000);
  });

  it.each([
    [{ ...env, JOB_ID: undefined }, "JOB_ID"],
    [{ ...env, JOB_ID: "../../etc" }, "JOB_ID"],
    [{ ...env, REPORTS_BUCKET: " " }, "REPORTS_BUCKET"],
    [{ ...env, UPLOADS_BUCKET: undefined }, "UPLOADS_BUCKET"],
    [{ ...env, SCAN_TIMEOUT_SECONDS: "30" }, "SCAN_TIMEOUT_SECONDS"],
    [{ ...env, SCAN_TIMEOUT_SECONDS: String(MAX_TIMEOUT_SECONDS + 1) }, "SCAN_TIMEOUT_SECONDS"],
    [{ ...env, SCAN_TIMEOUT_SECONDS: "10m" }, "SCAN_TIMEOUT_SECONDS"],
  ])("is a configuration error when a setting is wrong (%#)", (bad, name) => {
    expect(() => readSastConfig(bad)).toThrow(name);
    expect(exitCodeOf(() => readSastConfig(bad))).toBe(EXIT.CONFIG);
  });

  it("keeps every timeout under the reaper's 25 minutes", () => {
    expect(MAX_TIMEOUT_SECONDS).toBeLessThan(25 * 60);
    expect(DEFAULT_TIMEOUT_SECONDS).toBeLessThanOrEqual(MAX_TIMEOUT_SECONDS);
  });
});

describe("semgrepArgs", () => {
  it("scans the current folder offline with the baked-in rules", () => {
    const args = semgrepArgs("/work/semgrep.json");
    expect(args).toEqual(
      expect.arrayContaining(["--config", RULES_DIR, "--json", "--no-git-ignore"]),
    );
    expect(args.join(" ")).toContain("--metrics off");
    expect(args.join(" ")).toContain("--output /work/semgrep.json");
    expect(args.at(-1)).toBe(".");
  });
});

describe("stripRulePrefix", () => {
  it("removes the rules folder from rule IDs, so they match the Semgrep registry", () => {
    expect(rulePrefix(RULES_DIR)).toBe("opt.semgrep-rules.");
    const report = {
      results: [{ check_id: "opt.semgrep-rules.python.lang.md5" }, { check_id: "other.rule" }],
    };
    stripRulePrefix(report, RULES_DIR);
    expect(report.results.map((r) => r.check_id)).toEqual(["python.lang.md5", "other.rule"]);
  });

  it("ignores reports without results", () => {
    expect(() => {
      stripRulePrefix(null);
      stripRulePrefix({ results: "no" });
    }).not.toThrow();
  });
});

describe("fillMatchedCode", () => {
  it("puts the code back where free Semgrep wrote 'requires login'", async () => {
    const report = semgrepFixture();
    const filled = await fillMatchedCode(report, sourceReader(SAMPLE_V1));
    expect(filled).toBe(6);
    const results = report.results as {
      path: string;
      start: { line: number };
      extra: { lines: string };
    }[];
    const md5 = results.find((r) => r.path === "app/config.py");
    expect(md5?.extra.lines).toBe(
      readFileSync(join(SAMPLE_V1, "app/config.py"), "utf8").split("\n")[3],
    );
    // A match over lines 10 to 13 gets all four lines.
    const multi = results.find((r) => r.start.line === 10);
    expect(multi?.extra.lines.split("\n")).toHaveLength(4);
    // The parser now takes the code from the report, with no warnings.
    const parsed = parseSemgrep(report);
    expect(parsed.warnings).toEqual([]);
    expect(snippet(parsed.findings[0])).not.toContain("requires login");
  });

  it("keeps code that is already in the report", async () => {
    const report = {
      results: [
        { path: "app/views.py", start: { line: 1 }, end: { line: 1 }, extra: { lines: "real()" } },
      ],
    };
    expect(await fillMatchedCode(report, sourceReader(SAMPLE_V1))).toBe(0);
    expect(report.results[0]?.extra.lines).toBe("real()");
  });

  it("leaves a result alone when the file is missing or outside the source folder", async () => {
    const report = {
      results: [
        {
          path: "../v2/app/views.py",
          start: { line: 1 },
          end: { line: 1 },
          extra: { lines: "requires login" },
        },
        {
          path: "/etc/hosts",
          start: { line: 1 },
          end: { line: 1 },
          extra: { lines: "requires login" },
        },
        {
          path: "app/missing.py",
          start: { line: 1 },
          end: { line: 1 },
          extra: { lines: "requires login" },
        },
        {
          path: "app/views.py",
          start: { line: 9999 },
          end: { line: 9999 },
          extra: { lines: "requires login" },
        },
      ],
    };
    expect(await fillMatchedCode(report, sourceReader(SAMPLE_V1))).toBe(0);
    expect(report.results.every((r) => r.extra.lines === "requires login")).toBe(true);
  });

  it("caps very long matches", async () => {
    writeFileSync(join(dir, "big.js"), `${"x".repeat(MAX_MATCHED_CODE * 2)}\n`);
    const code = await sourceReader(dir)("big.js", 1, 1);
    expect(code).toHaveLength(MAX_MATCHED_CODE);
  });
});

describe("findScanRoot", () => {
  it("scans inside a single top-level folder, so the folder name never changes paths", async () => {
    mkdirSync(join(dir, "my-project-v2", "app"), { recursive: true });
    expect(await findScanRoot(dir)).toBe(join(dir, "my-project-v2"));
  });

  it("scans the folder itself when the zip holds several entries", async () => {
    mkdirSync(join(dir, "app"));
    writeFileSync(join(dir, "README.md"), "hi");
    expect(await findScanRoot(dir)).toBe(dir);
  });
});

describe("runSast", () => {
  const config: SastConfig = {
    jobId: JOB,
    reportsBucket: "reports",
    uploadsBucket: "uploads",
    timeoutMs: 60_000,
  };

  /** A zip of tests/fixtures/sample-app/v1 inside a folder, like a zipped project folder. */
  function sampleZip(): Buffer {
    const file = (name: string) => readFileSync(join(SAMPLE_V1, name));
    return buildZip([
      { name: "shop/app/views.py", data: file("app/views.py"), deflate: true },
      { name: "shop/app/config.py", data: file("app/config.py") },
    ]);
  }

  function deps(overrides: Partial<SastDeps> = {}) {
    const uploaded: { bucket: string; key: string; report: unknown }[] = [];
    const calls: { command: string; args: readonly string[]; options: RunOptions }[] = [];
    const workDir = mkdtempSync(join(dir, "work-"));
    const d: SastDeps = {
      workDir,
      download: vi.fn((_bucket: string, _key: string, file: string) => {
        writeFileSync(file, sampleZip());
        return Promise.resolve();
      }),
      upload: (bucket, key, report) => {
        uploaded.push({ bucket, key, report });
        return Promise.resolve();
      },
      run: (command, args, options): Promise<RunResult> => {
        calls.push({ command, args, options });
        // Pretend to be Semgrep: write the report where --output says.
        const output = args[args.indexOf("--output") + 1] ?? "";
        writeFileSync(output, JSON.stringify(reportAsImageWritesIt()));
        return Promise.resolve({ exitCode: 0, signal: null, timedOut: false });
      },
      timeLeft: () => 30_000,
      log: logger,
      ...overrides,
    };
    return { d, uploaded, calls, workDir };
  }

  it("downloads, unpacks, scans and uploads a report the processor can read", async () => {
    const { d, uploaded, calls, workDir } = deps();
    await runSast(config, d);

    expect(d.download).toHaveBeenCalledWith(
      "uploads",
      `uploads/${JOB}.zip`,
      join(workDir, "upload.zip"),
      MAX_ZIP_BYTES,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("semgrep");
    // Inside the zip's single folder, so paths are app/views.py, not shop/app/views.py.
    expect(calls[0]?.options.cwd).toBe(join(workDir, "src", "shop"));
    expect(calls[0]?.options.timeoutMs).toBe(30_000);

    expect(uploaded).toHaveLength(1);
    const { bucket, key, report } = uploaded[0] ?? {};
    expect(bucket).toBe("reports");
    expect(key).toBe(`reports/${JOB}.json`);
    const parsed = parseSemgrep(report);
    expect(parsed.warnings).toEqual([]);
    expect(parsed.findings.map((f) => f.identity.ruleId)).toEqual(
      (semgrepFixture().results as { check_id: string }[]).map((r) => r.check_id),
    );
    expect(
      parsed.findings.every((f) => snippet(f) !== "" && !snippet(f).includes("requires login")),
    ).toBe(true);
  });

  async function expectFailure(d: SastDeps, exitCode: number, message: RegExp) {
    const err: unknown = await runSast(config, d).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ScanError);
    expect((err as ScanError).exitCode).toBe(exitCode);
    expect((err as ScanError).message).toMatch(message);
  }

  it("fails with SCANNER when Semgrep exits with an error", async () => {
    const { d, uploaded } = deps({
      run: () => Promise.resolve({ exitCode: 2, signal: null, timedOut: false }),
    });
    await expectFailure(d, EXIT.SCANNER, /Semgrep exited with code 2/);
    expect(uploaded).toEqual([]);
  });

  it("fails with TIMEOUT when Semgrep runs out of time", async () => {
    const { d } = deps({
      run: () => Promise.resolve({ exitCode: null, signal: "SIGTERM", timedOut: true }),
    });
    await expectFailure(d, EXIT.TIMEOUT, /did not finish in time/);
  });

  it("fails with SCANNER when Semgrep writes no report", async () => {
    const { d } = deps({
      run: () => Promise.resolve({ exitCode: 0, signal: null, timedOut: false }),
    });
    await expectFailure(d, EXIT.SCANNER, /did not write a readable report/);
  });

  it("fails with SCANNER when the report has no results list", async () => {
    const { d } = deps({
      run: (_command, args) => {
        writeFileSync(args[args.indexOf("--output") + 1] ?? "", JSON.stringify({ errors: [] }));
        return Promise.resolve({ exitCode: 0, signal: null, timedOut: false });
      },
    });
    await expectFailure(d, EXIT.SCANNER, /no results list/);
  });

  it("fails with INPUT when the zip has no files", async () => {
    const { d } = deps({
      download: (_bucket, _key, file) => {
        writeFileSync(file, buildZip([{ name: "empty/" }]));
        return Promise.resolve();
      },
    });
    await expectFailure(d, EXIT.INPUT, /no files to scan/);
  });

  it("fails with INPUT for an unsafe zip, before running Semgrep", async () => {
    const run = vi.fn();
    const { d } = deps({
      run,
      download: (_bucket, _key, file) => {
        writeFileSync(file, buildZip([{ name: "../evil.py", data: "x" }]));
        return Promise.resolve();
      },
    });
    await expectFailure(d, EXIT.INPUT, /not a safe zip/);
    expect(run).not.toHaveBeenCalled();
  });

  it("passes download and upload failures through with their own code", async () => {
    const { d } = deps({
      download: () => Promise.reject(new ScanError("The uploaded zip was not found.", EXIT.INPUT)),
    });
    await expectFailure(d, EXIT.INPUT, /not found/);

    const second = deps({
      upload: () =>
        Promise.reject(new ScanError("Could not upload the report: boom", EXIT.STORAGE)),
    });
    await expectFailure(second.d, EXIT.STORAGE, /Could not upload/);
  });

  it("stops when the time is already used up", async () => {
    const { d } = deps({
      timeLeft: () => {
        throw new ScanError("The scan timed out.", EXIT.TIMEOUT);
      },
    });
    await expectFailure(d, EXIT.TIMEOUT, /timed out/);
  });
});
