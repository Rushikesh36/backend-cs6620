import { getCaller } from "../../common/auth.js";
import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { listRecentScans, queryRecentScans } from "./list-recent-scans.js";

/** GET /scans?limit=&cursor= */
export const handler = wrap(async (event) => {
  getCaller(event);
  const query = event.queryStringParameters;
  const result = await listRecentScans(query?.limit, query?.cursor, {
    queryPage: queryRecentScans(getDocClient(), requireEnv("JOBS_TABLE")),
  });
  return json(200, result);
});
