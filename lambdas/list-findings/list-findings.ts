import type { StoredFinding } from "../../common/findings/diff.js";
import {
  findingsKey,
  MalformedFindingError,
  readAllFindings,
  type QueryFindingsPage,
} from "../../common/findings/table.js";
import { logger } from "../../common/logger.js";
import { requireProjectId, requireScanType } from "../../common/validation.js";

export interface ListFindingsDeps {
  queryPage: QueryFindingsPage;
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
  try {
    return { items: await readAllFindings(deps.queryPage, findingsKey(projectId, scanType)) };
  } catch (err) {
    // Log bad data with the project, so one search finds it. The caller only sees a generic 500.
    if (err instanceof MalformedFindingError) {
      logger.error("Finding record is malformed", { projectId, scanType, error: err });
    }
    throw err;
  }
}
