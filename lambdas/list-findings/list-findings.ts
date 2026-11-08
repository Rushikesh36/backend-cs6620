import { QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { StoredFinding } from "../../common/findings/diff.js";
import { findingsKey, toFindingItem } from "../../common/findings/table.js";
import { logger } from "../../common/logger.js";
import { requireProjectId, requireScanType } from "../../common/validation.js";

export interface FindingsPage {
  records: Record<string, unknown>[];
  lastKey: Record<string, unknown> | undefined;
}

export interface ListFindingsDeps {
  queryPage: (pk: string, startKey: Record<string, unknown> | undefined) => Promise<FindingsPage>;
}

export interface FindingList {
  items: StoredFinding[];
}

/**
 * Every finding of one project and scan type, OPEN and FIXED. The contract has no paging (the
 * browser pages the list itself), so this follows DynamoDB's 1 MB pages until the end.
 * An unknown project simply has no rows, so it is an empty list, not 404.
 */
export async function listFindings(
  projectId: string,
  rawScanType: string | undefined,
  deps: ListFindingsDeps,
): Promise<FindingList> {
  requireProjectId(projectId);
  const scanType = requireScanType(rawScanType);
  const pk = findingsKey(projectId, scanType);

  const items: StoredFinding[] = [];
  let startKey: Record<string, unknown> | undefined;
  do {
    const page = await deps.queryPage(pk, startKey);
    try {
      items.push(...page.records.map(toFindingItem));
    } catch (err) {
      // Log it with the project, so one search finds it. The caller only sees a generic 500.
      logger.error("Finding record is malformed", { projectId, scanType, error: err });
      throw err;
    }
    startKey = page.lastKey;
  } while (startKey !== undefined);

  return { items };
}

/**
 * One page of the project's findings. Strongly consistent, so a scan that has just finished
 * shows all of the findings the processor wrote for it.
 */
export function queryFindings(
  client: DynamoDBDocumentClient,
  table: string,
): ListFindingsDeps["queryPage"] {
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
