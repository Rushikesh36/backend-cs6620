import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { notFound } from "../../common/errors.js";
import { logger } from "../../common/logger.js";
import { toScanItem, type ScanItem } from "../../common/scan-item.js";
import { isValidJobId } from "../../common/validation.js";

export const NOT_FOUND_MESSAGE = "Scan not found.";

export interface GetScanDeps {
  getRecord: (jobId: string) => Promise<Record<string, unknown> | undefined>;
}

export async function getScan(jobId: string, deps: GetScanDeps): Promise<ScanItem> {
  // A malformed id cannot exist, so it is "not found". No database call is made for it.
  if (!isValidJobId(jobId)) throw notFound(NOT_FOUND_MESSAGE);
  const record = await deps.getRecord(jobId);
  if (!record) throw notFound(NOT_FOUND_MESSAGE);
  try {
    return toScanItem(record);
  } catch (err) {
    // Log it with the job id, so one search finds it. The caller only sees a generic 500.
    logger.error("Job record is malformed", { jobId, error: err });
    throw err;
  }
}

/**
 * One key lookup. It is a strongly consistent read, so a scan that was just started never
 * shows its old status. The cost is tiny: one small item, read every 5 seconds per open page.
 */
export function getRecordFromTable(
  client: DynamoDBDocumentClient,
  table: string,
): (jobId: string) => Promise<Record<string, unknown> | undefined> {
  return async (jobId) => {
    const out = await client.send(
      new GetCommand({ TableName: table, Key: { jobId }, ConsistentRead: true }),
    );
    return out.Item;
  };
}
