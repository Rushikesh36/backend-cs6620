import { getDocClient, requireEnv } from "../../common/dynamo.js";
import { json, wrap } from "../../common/http.js";
import { getJwtSecret } from "../../common/secret.js";
import { parseJsonObject } from "../../common/validation.js";
import { getUserFromTable, login } from "./login.js";

/** POST /login */
export const handler = wrap(async (event) => {
  const body = parseJsonObject(event);
  const ttlSeconds = Number(requireEnv("TOKEN_LIFETIME_SECONDS"));
  const table = requireEnv("USERS_TABLE");

  const result = await login(body, {
    getUser: (username) => getUserFromTable(getDocClient(), table, username),
    getSecret: () => getJwtSecret(),
    ttlSeconds,
  });
  return json(200, result);
});
