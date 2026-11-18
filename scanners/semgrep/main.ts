// Entry point of the Semgrep (SAST) image. Settings come from the launcher (Task 20).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setLogContext } from "../../common/logger.js";
import { deadline, runScanner } from "../common/job.js";
import { runProcess, stopAll } from "../common/run.js";
import { downloadToFile, scannerS3Client, uploadReport } from "../common/storage.js";
import { readSastConfig, runSast } from "./semgrep.js";

setLogContext({
  awsService: "ECS Fargate",
  container: "scanner",
  scanner: "semgrep",
  scanType: "SAST",
});

process.on("SIGTERM", () => {
  // ECS is stopping the task (the reaper, or a stop from the console): stop Semgrep too.
  stopAll();
});

process.exitCode = await runScanner(process.env, readSastConfig, async (config, log) => {
  const s3 = scannerS3Client(process.env);
  const workDir = await mkdtemp(join(tmpdir(), "sast-"));
  try {
    await runSast(config, {
      workDir,
      download: (bucket, key, file, maxBytes) => downloadToFile(s3, bucket, key, file, maxBytes),
      upload: (bucket, key, report) => uploadReport(s3, bucket, key, report),
      run: runProcess,
      timeLeft: deadline(config.timeoutMs),
      log,
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
});
