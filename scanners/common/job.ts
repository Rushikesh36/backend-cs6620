import { logger } from "../../common/logger.js";
import { isValidJobId } from "../../common/validation.js";

/**
 * Exit codes of the scanner containers. The processor (Task 19) reports any non-zero code as
 * "Scanner exited with code N", so each code names one kind of problem (docs/scanners.md).
 */
export const EXIT = {
  OK: 0,
  UNEXPECTED: 1,
  CONFIG: 2,
  INPUT: 3,
  SCANNER: 4,
  STORAGE: 5,
  TARGET: 6,
  TIMEOUT: 124,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** A failure the wrapper understands. The message goes to the logs, the code to ECS. */
export class ScanError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
  ) {
    super(message);
    this.name = "ScanError";
  }
}

// Same key names as create-scan's uploadKey and the processor's reportKey (tests check this).
export const uploadKey = (jobId: string): string => `uploads/${jobId}.zip`;
export const reportKey = (jobId: string): string => `reports/${jobId}.json`;

/** The reaper fails a job that is RUNNING for 25 minutes, so a scan must give up before that. */
export const MAX_TIMEOUT_SECONDS = 23 * 60;
const MIN_TIMEOUT_SECONDS = 60;

export interface JobConfig {
  jobId: string;
  reportsBucket: string;
  timeoutMs: number;
}

export type Env = Readonly<Record<string, string | undefined>>;

export function requireSetting(env: Env, name: string): string {
  // eslint-disable-next-line security/detect-object-injection -- name is a constant from our code
  const value = env[name]?.trim();
  if (!value) throw new ScanError(`${name} is not set.`, EXIT.CONFIG);
  return value;
}

/** Settings every scanner needs. The launcher (Task 20) passes them as container overrides. */
export function readJobConfig(env: Env, defaultTimeoutSeconds: number): JobConfig {
  const jobId = env.JOB_ID;
  if (!isValidJobId(jobId)) throw new ScanError("JOB_ID is missing or not a job ID.", EXIT.CONFIG);
  const reportsBucket = requireSetting(env, "REPORTS_BUCKET");

  let timeoutSeconds = defaultTimeoutSeconds;
  const raw = env.SCAN_TIMEOUT_SECONDS?.trim();
  if (raw) {
    timeoutSeconds = Number(raw);
    if (
      !Number.isInteger(timeoutSeconds) ||
      timeoutSeconds < MIN_TIMEOUT_SECONDS ||
      timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new ScanError(
        `SCAN_TIMEOUT_SECONDS must be a whole number from ${String(MIN_TIMEOUT_SECONDS)} to ${String(MAX_TIMEOUT_SECONDS)}.`,
        EXIT.CONFIG,
      );
    }
  }
  return { jobId, reportsBucket, timeoutMs: timeoutSeconds * 1000 };
}

/** Logger whose every line carries the jobId, so one Logs Insights query follows a scan. */
export function jobLogger(jobId: string): typeof logger {
  return {
    info: (message, fields) => {
      logger.info(message, { jobId, ...fields });
    },
    warn: (message, fields) => {
      logger.warn(message, { jobId, ...fields });
    },
    error: (message, fields) => {
      logger.error(message, { jobId, ...fields });
    },
  };
}

/** Time left before the scan's hard timeout. Every step gets only what is left. */
export function deadline(timeoutMs: number, now: () => number = Date.now): () => number {
  const end = now() + timeoutMs;
  return () => {
    const left = end - now();
    if (left <= 0) throw new ScanError("The scan timed out.", EXIT.TIMEOUT);
    return left;
  };
}

/** Runs one scan and turns the outcome into the container's exit code. Never throws. */
export async function runToExitCode(
  scan: () => Promise<void>,
  log: typeof logger = logger,
): Promise<ExitCode> {
  try {
    await scan();
    return EXIT.OK;
  } catch (err) {
    if (err instanceof ScanError) {
      log.error(err.message, { exitCode: err.exitCode });
      return err.exitCode;
    }
    log.error("Unexpected error in the scanner wrapper", { error: err });
    return EXIT.UNEXPECTED;
  }
}

/** Reads the settings, runs the scan with a jobId logger, and returns the exit code. */
export async function runScanner<C extends JobConfig>(
  env: Env,
  readConfig: (env: Env) => C,
  scan: (config: C, log: typeof logger) => Promise<void>,
): Promise<ExitCode> {
  let config: C;
  try {
    config = readConfig(env);
  } catch (err) {
    return runToExitCode(() => {
      throw err;
    });
  }
  const log = jobLogger(config.jobId);
  log.info("Scanner started");
  const code = await runToExitCode(() => scan(config, log), log);
  log.info("Scanner finished", { exitCode: code });
  return code;
}
