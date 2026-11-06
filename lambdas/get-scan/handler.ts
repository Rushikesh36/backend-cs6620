import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { getRecordFromTable, getScan } from "./get-scan.js";

/** GET /scans/{jobId} */
export const handler = wrap(async (event) => {
  getCaller(event);
  const result = await getScan(event.pathParameters?.jobId ?? "", {
    getRecord: getRecordFromTable(getDocClient(), requireEnv("JOBS_TABLE")),
  });
  return json(200, result);
});
