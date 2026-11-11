// Entry point of the ZAP (DAST) image. Settings come from the launcher (Task 20).
import { deadline, runScanner } from "../common/job.js";
import { runProcess, stopAll } from "../common/run.js";
import { scannerS3Client, uploadReport } from "../common/storage.js";
import { readDastConfig, runDast, ZAP_WORK_DIR } from "./zap.js";

process.on("SIGTERM", () => {
  // ECS is stopping the task (the reaper, or a stop from the console): stop ZAP too.
  stopAll();
});

process.exitCode = await runScanner(process.env, readDastConfig, async (config, log) => {
  const s3 = scannerS3Client(process.env);
  await runDast(config, {
    workDir: ZAP_WORK_DIR,
    upload: (bucket, key, report) => uploadReport(s3, bucket, key, report),
    run: runProcess,
    timeLeft: deadline(config.timeoutMs),
    log,
  });
});
