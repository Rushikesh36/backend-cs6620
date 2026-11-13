import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { decodeCursor, encodeCursor } from "../../common/dynamo.js";
import { logger } from "../../common/logger.js";
import { toScanItem, type ScanItem } from "../../common/scan-item.js";
import { parseLimit } from "../../common/validation.js";

/** The keys DynamoDB returns as LastEvaluatedKey for the byCreated index. */
export const CURSOR_KEYS = ["jobId", "scope", "createdAt"] as const;

/** Every job has scope = "ALL", so one partition holds all scans (see docs/data-model.md). */
export const SCOPE = "ALL";

export interface RecentScansPage {
  records: Record<string, unknown>[];
  lastKey: Record<string, unknown> | undefined;
}

export interface ListRecentScansDeps {
  queryPage: (
    limit: number,
    startKey: Record<string, string> | undefined,
  ) => Promise<RecentScansPage>;
}

export interface ScanList {
  items: ScanItem[];
  nextCursor: string | null;
}

export async function listRecentScans(
  rawLimit: string | undefined,
  rawCursor: string | undefined,
  deps: ListRecentScansDeps,
): Promise<ScanList> {
  const limit = parseLimit(rawLimit);
  // A cursor from another list (for example byProject) has other keys and is refused here.
  const startKey = rawCursor === undefined ? undefined : decodeCursor(rawCursor, CURSOR_KEYS);

  const page = await deps.queryPage(limit, startKey);
  try {
    return { items: page.records.map(toScanItem), nextCursor: encodeCursor(page.lastKey) };
  } catch (err) {
    logger.error("Job record is malformed", { error: err });
    throw err;
  }
}

/** Newest first, using the byCreated index. No scans means an empty list. */
export function queryRecentScans(
  client: DynamoDBDocumentClient,
  table: string,
): ListRecentScansDeps["queryPage"] {
  return async (limit, startKey) => {
    const out = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: "byCreated",
        KeyConditionExpression: "scope = :s",
        ExpressionAttributeValues: { ":s": SCOPE },
        ScanIndexForward: false,
        Limit: limit,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    return { records: out.Items ?? [], lastKey: out.LastEvaluatedKey };
  };
}
