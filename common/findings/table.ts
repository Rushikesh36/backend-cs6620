import {
  BatchWriteCommand,
  QueryCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { FindingState, StoredFinding } from "./diff.js";
import type { Severity } from "./fingerprint.js";
import { str } from "./report.js";
import type { ScanType } from "../validation.js";

/**
 * Partition key of the findings table: `projectId#scanType`, for example `demo#SAST`
 * (docs/data-model.md). The list-findings Lambda reads with it; the processor writes with it.
 */
export const findingsKey = (projectId: string, scanType: ScanType): string =>
  `${projectId}#${scanType}`;

const SEVERITIES: readonly string[] = ["HIGH", "MEDIUM", "LOW", "INFO"];
const STATES: readonly string[] = ["OPEN", "FIXED"];

/** A row of the findings table is not in the expected shape. */
export class MalformedFindingError extends Error {
  override name = "MalformedFindingError";
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = str(Reflect.get(record, field));
  if (value === undefined) {
    throw new MalformedFindingError(`Finding field ${field} is missing or not a string.`);
  }
  return value;
}

/**
 * Turns a row of the findings table into the contract's shape. It copies only the contract's
 * fields, so the table's own key (`pk`) never reaches the browser. Bad data in the table is a
 * server error (the caller sees a generic 500), never half a finding.
 */
export function toFindingItem(record: Record<string, unknown>): StoredFinding {
  const severity: unknown = Reflect.get(record, "severity");
  const state: unknown = Reflect.get(record, "state");
  if (typeof severity !== "string" || !SEVERITIES.includes(severity)) {
    throw new MalformedFindingError("Finding severity is invalid.");
  }
  if (typeof state !== "string" || !STATES.includes(state)) {
    throw new MalformedFindingError("Finding state is invalid.");
  }
  return {
    fingerprint: requiredString(record, "fingerprint"),
    ruleId: requiredString(record, "ruleId"),
    severity: severity as Severity,
    location: requiredString(record, "location"),
    message: requiredString(record, "message"),
    state: state as FindingState,
    firstSeenJobId: requiredString(record, "firstSeenJobId"),
    lastSeenJobId: requiredString(record, "lastSeenJobId"),
  };
}

export interface FindingsPage {
  records: Record<string, unknown>[];
  lastKey: Record<string, unknown> | undefined;
}

export type QueryFindingsPage = (
  pk: string,
  startKey: Record<string, unknown> | undefined,
) => Promise<FindingsPage>;

/**
 * One page of a project's findings. Strongly consistent, so a scan that has just finished
 * shows all of the findings the processor wrote for it.
 */
export function queryFindings(client: DynamoDBDocumentClient, table: string): QueryFindingsPage {
  return async (pk, startKey) => {
    const out = await client.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": pk },
        ConsistentRead: true,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    return { records: out.Items ?? [], lastKey: out.LastEvaluatedKey };
  };
}

/**
 * Every finding under one key, following DynamoDB's 1 MB pages to the end. Used by the
 * list-findings Lambda (to answer the API) and the processor (to diff against).
 * Throws MalformedFindingError for a row in the wrong shape.
 */
export async function readAllFindings(
  queryPage: QueryFindingsPage,
  pk: string,
): Promise<StoredFinding[]> {
  const items: StoredFinding[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await queryPage(pk, startKey);
    items.push(...page.records.map(toFindingItem));
    startKey = page.lastKey;
  } while (startKey !== undefined);
  return items;
}

/** DynamoDB writes at most 25 items per BatchWriteItem call. */
const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 5;

export type WriteFindings = (pk: string, rows: readonly StoredFinding[]) => Promise<void>;

/**
 * Saves rows under one key, 25 at a time. Items DynamoDB leaves unprocessed (throttling) are
 * retried with a short back-off. Writing the same rows twice gives the same table, so a
 * repeated event is harmless.
 */
export function writeFindingsToTable(
  client: DynamoDBDocumentClient,
  table: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): WriteFindings {
  return async (pk, rows) => {
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      let requests = rows
        .slice(i, i + BATCH_SIZE)
        .map((row) => ({ PutRequest: { Item: { pk, ...row } } }));
      for (let attempt = 1; requests.length > 0; attempt++) {
        if (attempt > MAX_ATTEMPTS) throw new Error("Findings could not be saved (throttled).");
        if (attempt > 1) await sleep(100 * 2 ** attempt);
        const out = await client.send(
          new BatchWriteCommand({ RequestItems: { [table]: requests } }),
        );
        const unprocessed: unknown = Reflect.get(out.UnprocessedItems ?? {}, table);
        requests = (Array.isArray(unprocessed) ? unprocessed : []) as typeof requests;
      }
    }
  };
}
