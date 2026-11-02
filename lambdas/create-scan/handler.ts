import { S3Client } from "@aws-sdk/client-s3";
import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { parseTargets } from "../../common/targets.js";
import { parseJsonObject } from "../../common/validation.js";
import { createScan, presignPut, putJobInTable } from "./create-scan.js";

// WHEN_REQUIRED keeps a checksum of an empty body out of the pre-signed URL.
// Without it, S3 rejects the real zip because its checksum would not match.
const s3 = new S3Client({ requestChecksumCalculation: "WHEN_REQUIRED" });

/** POST /scans */
export const handler = wrap(async (event) => {
  const caller = getCaller(event);
  const body = parseJsonObject(event);
  const jobsTable = requireEnv("JOBS_TABLE");

  const result = await createScan(body, caller.username, {
    targets: parseTargets(requireEnv("TARGETS_JSON")),
    putJob: (job) => putJobInTable(getDocClient(), jobsTable, job),
    presign: presignPut(s3, requireEnv("UPLOADS_BUCKET")),
  });
  return json(200, result);
});
