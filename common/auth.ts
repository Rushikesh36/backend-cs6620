import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { forbidden, unauthorized } from "./errors.js";
import type { Role } from "./jwt.js";

export interface Caller {
  username: string;
  role: Role;
}

/**
 * Who is calling, as put there by the authorizer. API Gateway never lets a client set this,
 * but if it is missing or wrong we still refuse (defence in depth).
 */
export function getCaller(event: APIGatewayProxyEventV2): Caller {
  const authorizer = (event.requestContext as { authorizer?: { lambda?: unknown } } | undefined)
    ?.authorizer;
  const ctx = authorizer?.lambda;
  if (ctx === null || typeof ctx !== "object") throw unauthorized();
  const { username, role } = ctx as Record<string, unknown>;
  if (typeof username !== "string" || username.length === 0) throw unauthorized();
  if (role !== "user" && role !== "ci") throw unauthorized();
  return { username, role };
}

/** 403 unless the caller has one of the allowed roles. */
export function requireRole(caller: Caller, ...allowed: Role[]): void {
  if (!allowed.includes(caller.role)) throw forbidden();
}
