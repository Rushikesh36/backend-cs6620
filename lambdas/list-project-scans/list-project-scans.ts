import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { badRequest } from "../../common/errors.js";
import { decodeCursor, encodeCursor } from "../../common/dynamo.js";
import { logger } from "../../common/logger.js";
import { toScanItem, type ScanItem } from "../../common/scan-item.js";
import { parseLimit, requireProjectId } from "../../common/validation.js";

/** The keys DynamoDB returns as LastEvaluatedKey for the byProject index. */
export const CURSOR_KEYS = ["jobId", "projectId", "createdAt"] as const;

export interface ProjectScansPage {
  records: Record<string, unknown>[];
  lastKey: Record<string, unknown> | undefined;
}

export interface ListProjectScansDeps {
  queryPage: (
    projectId: string,
    limit: number,
    startKey: Record<string, string> | undefined,
  ) => Promise<ProjectScansPage>;
}

export interface ScanList {
  items: ScanItem[];
  nextCursor: string | null;
}

export async function listProjectScans(
  projectId: string,
  rawLimit: string | undefined,
  rawCursor: string | undefined,
  deps: ListProjectScansDeps,
): Promise<ScanList> {
  requireProjectId(projectId);
  const limit = parseLimit(rawLimit);
  let startKey: Record<string, string> | undefined;
  if (rawCursor !== undefined) {
    startKey = decodeCursor(rawCursor, CURSOR_KEYS);
    // A cursor from another project's list must not be accepted here.
    if (startKey.projectId !== projectId) throw badRequest("Invalid cursor.");
  }

  const page = await deps.queryPage(projectId, limit, startKey);
  try {
    return { items: page.records.map(toScanItem), nextCursor: encodeCursor(page.lastKey) };
  } catch (err) {
    logger.error("Job record is malformed", { projectId, error: err });
    throw err;
  }
}

/** Newest first, using the byProject index. No project record is needed: no scans means []. */
export function queryProjectScans(
  client: DynamoDBDocumentClient,
  table: string,
): ListProjectScansDeps["queryPage"] {
  return async (projectId, limit, startKey) => {
    const out = await client.send(
      new QueryCommand({
        TableName: table,
        IndexName: "byProject",
        KeyConditionExpression: "projectId = :p",
        ExpressionAttributeValues: { ":p": projectId },
        ScanIndexForward: false,
        Limit: limit,
        ...(startKey ? { ExclusiveStartKey: startKey } : {}),
      }),
    );
    return { records: out.Items ?? [], lastKey: out.LastEvaluatedKey };
  };
}
