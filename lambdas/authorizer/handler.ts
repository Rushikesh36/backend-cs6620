import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { getJwtSecret } from "../../common/secret.js";
import { authorize, type AuthResult } from "./authorize.js";

/** Lambda authorizer for the HTTP API (payload 2.0, simple responses). */
export const handler = (event: APIGatewayRequestAuthorizerEventV2): Promise<AuthResult> =>
  authorize(event, () => getJwtSecret());
