import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** Builds a minimal API Gateway v2 event for unit tests. */
export function makeEvent(overrides: Partial<APIGatewayProxyEventV2> = {}): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    headers: {},
    isBase64Encoded: false,
    ...overrides,
  } as APIGatewayProxyEventV2;
}
