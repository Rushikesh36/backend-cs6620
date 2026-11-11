import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  /** Called for every line the program prints, so its output can go through our logger. */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
}

/** How long a program gets to stop after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 5000;

/** Process groups still running, so a stop request from ECS can end them too. */
const running = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // A negative pid sends the signal to the whole group: ZAP's Python script starts Java.
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Stops every program started by runProcess. Used when ECS stops the task. */
export function stopAll(signal: NodeJS.Signals = "SIGTERM"): void {
  for (const pid of running) killGroup(pid, signal);
}

function forwardLines(
  stream: Readable,
  name: "stdout" | "stderr",
  onLine: RunOptions["onLine"],
): void {
  if (!onLine) {
    stream.resume();
    return;
  }
  createInterface({ input: stream, crlfDelay: Infinity }).on("line", (line) => {
    onLine(name, line);
  });
}

/**
 * Runs a program in its own process group with a hard timeout. On timeout the whole group gets
 * SIGTERM, then SIGKILL after KILL_GRACE_MS. Rejects only if the program cannot be started.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    if (pid !== undefined) running.add(pid);

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid === undefined) return;
      killGroup(pid, "SIGTERM");
      killTimer = setTimeout(() => {
        killGroup(pid, "SIGKILL");
      }, KILL_GRACE_MS);
    }, options.timeoutMs);

    const done = (): void => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (pid !== undefined) running.delete(pid);
    };

    forwardLines(child.stdout, "stdout", options.onLine);
    forwardLines(child.stderr, "stderr", options.onLine);

    child.on("error", (err) => {
      done();
      reject(err);
    });
    child.on("close", (exitCode, signal) => {
      done();
      resolve({ exitCode, signal, timedOut });
    });
  });
}
