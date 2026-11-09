import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { queryFindings } from "../../common/findings/table.js";
import { listFindings } from "./list-findings.js";

/** GET /projects/{projectId}/findings?scanType=SAST|DAST */
export const handler = wrap(async (event) => {
  getCaller(event);
  const result = await listFindings(
    event.pathParameters?.projectId ?? "",
    event.queryStringParameters?.scanType,
    { queryPage: queryFindings(getDocClient(), requireEnv("FINDINGS_TABLE")) },
  );
  return json(200, result);
});
