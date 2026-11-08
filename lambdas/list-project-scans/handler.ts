import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { listProjectScans, queryProjectScans } from "./list-project-scans.js";

/** GET /projects/{projectId}/scans?limit=&cursor= */
export const handler = wrap(async (event) => {
  getCaller(event);
  const query = event.queryStringParameters;
  const result = await listProjectScans(
    event.pathParameters?.projectId ?? "",
    query?.limit,
    query?.cursor,
    { queryPage: queryProjectScans(getDocClient(), requireEnv("JOBS_TABLE")) },
  );
  return json(200, result);
});
