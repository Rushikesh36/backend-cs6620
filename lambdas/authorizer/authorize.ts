import type {
  APIGatewayRequestAuthorizerEventV2,
  APIGatewaySimpleAuthorizerWithContextResult,
} from "aws-lambda";
import { HttpError } from "../../common/errors.js";
import { verifyToken } from "../../common/jwt.js";
import { logger } from "../../common/logger.js";

export type AuthResult = APIGatewaySimpleAuthorizerWithContextResult<{
  username: string;
  role: string;
}>;

const DENY: AuthResult = { isAuthorized: false, context: { username: "", role: "" } };
const MAX_HEADER_LENGTH = 4096;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

/**
 * Allows the request only if it carries a valid, unexpired token signed with our secret.
 * A bad token is a normal "deny" (401). A failure to read the secret is thrown, so the
 * caller gets a retryable 5xx instead of being logged out.
 */
export async function authorize(
  event: APIGatewayRequestAuthorizerEventV2,
  getSecret: () => Promise<string>,
): Promise<AuthResult> {
  const header = event.headers?.authorization;
  if (!header || header.length > MAX_HEADER_LENGTH) return DENY;
  const token = BEARER.exec(header)?.[1];
  if (!token) return DENY;

  const secret = await getSecret();
  try {
    const claims = verifyToken(token, secret);
    return { isAuthorized: true, context: { username: claims.sub, role: claims.role } };
  } catch (err) {
    if (err instanceof HttpError) {
      logger.warn("Token rejected");
      return DENY;
    }
    throw err;
  }
}
