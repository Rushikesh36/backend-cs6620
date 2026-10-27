import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { badRequest } from "./errors.js";

export const MAX_BODY_BYTES = 16 * 1024;
export const SCAN_TYPES = ["SAST", "DAST"] as const;
export type ScanType = (typeof SCAN_TYPES)[number];

// 3 to 50 characters: a letter first, then lowercase letters, digits or hyphens.
const PROJECT_ID = /^[a-z][a-z0-9-]{2,49}$/;
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TARGET_ID = /^[a-z0-9-]{1,50}$/;

export const isValidProjectId = (v: unknown): v is string =>
  typeof v === "string" && PROJECT_ID.test(v);
export const isValidJobId = (v: unknown): v is string => typeof v === "string" && JOB_ID.test(v);

export function requireProjectId(v: unknown): string {
  if (!isValidProjectId(v)) {
    throw badRequest(
      "Project ID must be 3 to 50 characters: lowercase letters, digits and hyphens, starting with a letter.",
    );
  }
  return v;
}

export function requireScanType(v: unknown): ScanType {
  if (v !== "SAST" && v !== "DAST") throw badRequest("Scan type must be SAST or DAST.");
  return v;
}

export function requireTargetId(v: unknown): string {
  if (typeof v !== "string" || !TARGET_ID.test(v)) throw badRequest("Unknown target.");
  return v;
}

/** Reads the JSON body and makes sure it is an object (not an array, string or null). */
export function parseJsonObject(event: APIGatewayProxyEventV2): Record<string, unknown> {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : (event.body ?? "");
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) throw badRequest("Request is too large.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw badRequest("Request body must be valid JSON.");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw badRequest("Request body must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

/** A required, non-empty string with a maximum length. */
export function requireString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number,
): string {
  const value: unknown = Reflect.get(body, field);
  if (typeof value !== "string" || value.length === 0) {
    throw badRequest(`${field} is required.`);
  }
  if (value.length > maxLength) throw badRequest(`${field} is too long.`);
  return value;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/** Parses ?limit= (default 20, max 100). Anything that is not a whole number 1..100 is a 400. */
export function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT;
  if (!/^\d{1,4}$/.test(raw)) throw badRequest("limit must be a whole number.");
  const n = Number(raw);
  if (n < 1 || n > MAX_LIMIT) throw badRequest(`limit must be between 1 and ${String(MAX_LIMIT)}.`);
  return n;
}
