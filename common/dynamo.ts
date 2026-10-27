import { ConditionalCheckFailedException, DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { badRequest } from "./errors.js";

export type JobStatus = "CREATED" | "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

/**
 * The only allowed status changes. COMPLETED and FAILED have no way out, so a finished scan
 * can never change. QUEUED may jump straight to a final state because the task-stopped event
 * can arrive before the job was marked RUNNING.
 */
export const ALLOWED_FROM: Record<JobStatus, readonly JobStatus[]> = {
  CREATED: [],
  QUEUED: ["CREATED"],
  RUNNING: ["QUEUED"],
  COMPLETED: ["QUEUED", "RUNNING"],
  FAILED: ["QUEUED", "RUNNING"],
};

export const isFinal = (s: JobStatus): boolean => s === "COMPLETED" || s === "FAILED";

let docClient: DynamoDBDocumentClient | undefined;

export function getDocClient(): DynamoDBDocumentClient {
  docClient ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });
  return docClient;
}

export function requireEnv(name: string): string {
  // eslint-disable-next-line security/detect-object-injection -- name is a constant from our code
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

type Attr = string | number | boolean | null;

/**
 * Moves a job to `to` only if it is in an allowed earlier state, in one atomic write.
 * Returns true if it changed, false if the job is missing or already in another state.
 */
export async function transitionJob(
  client: DynamoDBDocumentClient,
  table: string,
  jobId: string,
  to: JobStatus,
  extra: Record<string, Attr> = {},
): Promise<boolean> {
  // eslint-disable-next-line security/detect-object-injection -- `to` is a typed JobStatus
  const from = ALLOWED_FROM[to];
  if (from.length === 0) throw new Error(`Cannot move a job to ${to}`);

  const names: Record<string, string> = { "#status": "status" };
  const values: Record<string, unknown> = { ":to": to };
  const sets = ["#status = :to"];
  Object.entries(extra).forEach(([key, value], i) => {
    names[`#a${String(i)}`] = key;
    values[`:a${String(i)}`] = value;
    sets.push(`#a${String(i)} = :a${String(i)}`);
  });
  from.forEach((f, i) => {
    values[`:f${String(i)}`] = f;
  });
  const inList = from.map((_, i) => `:f${String(i)}`).join(", ");

  try {
    await client.send(
      new UpdateCommand({
        TableName: table,
        Key: { jobId },
        UpdateExpression: `SET ${sets.join(", ")}`,
        ConditionExpression: `attribute_exists(jobId) AND #status IN (${inList})`,
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/** Turns DynamoDB's LastEvaluatedKey into an opaque string for the browser. */
export function encodeCursor(key: Record<string, unknown> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key), "utf8").toString("base64url");
}

/**
 * Reads a cursor back. Only accepts an object with exactly the expected string keys, so a
 * tampered cursor cannot point DynamoDB at anything unexpected. Invalid means 400.
 */
export function decodeCursor(
  cursor: string,
  expectedKeys: readonly string[],
): Record<string, string> {
  const fail = (): never => {
    throw badRequest("Invalid cursor.");
  };
  if (cursor.length === 0 || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return fail();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail();
  const keys = Object.keys(parsed).sort();
  const wanted = [...expectedKeys].sort();
  if (
    keys.length !== wanted.length || // eslint-disable-next-line security/detect-object-injection -- i is a numeric index
    keys.some((k, i) => k !== wanted[i])
  )
    return fail();
  if (!Object.values(parsed).every((v) => typeof v === "string")) return fail();
  return parsed as Record<string, string>;
}
