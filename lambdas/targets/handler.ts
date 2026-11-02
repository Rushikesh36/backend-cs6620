import { getCaller } from "../../common/auth.js";
import { requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { parseTargets } from "../../common/targets.js";
import { listTargets } from "./targets.js";

/** GET /targets */
export const handler = wrap((event) => {
  getCaller(event);
  return Promise.resolve(json(200, listTargets(parseTargets(requireEnv("TARGETS_JSON")))));
});
