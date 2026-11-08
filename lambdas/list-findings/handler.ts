import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { listFindings, queryFindings } from "./list-findings.js";

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
