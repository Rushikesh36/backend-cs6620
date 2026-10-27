import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { HttpError } from "./errors.js";
import { logger } from "./logger.js";

// CORS headers are added by API Gateway, so Lambdas only set the content type.
const HEADERS = { "Content-Type": "application/json" };

export function json(statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 {
  return { statusCode, headers: HEADERS, body: JSON.stringify(body) };
}

export function errorResponse(statusCode: number, message: string) {
  return json(statusCode, { error: message });
}

/** Turns any thrown error into the contract's `{ "error": "..." }` body. */
export function toErrorResponse(err: unknown): APIGatewayProxyStructuredResultV2 {
  if (err instanceof HttpError) return errorResponse(err.statusCode, err.message);
  // Unexpected: log the details, but never show them to the caller.
  logger.error("Unhandled error", { error: err });
  return errorResponse(500, "Something went wrong. Please try again.");
}

type Handler = (event: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;

/** Keeps handlers thin: they just return a response or throw an HttpError. */
export function wrap(handler: Handler): Handler {
  return async (event) => {
    try {
      return await handler(event);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}
