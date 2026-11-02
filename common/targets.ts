import { badRequest } from "./errors.js";

/** One DAST test app a user may pick. The real URL is never here, only the id and labels. */
export interface Target {
  targetId: string;
  name: string;
  description: string;
}

/**
 * Reads the allow-list from the TARGETS_JSON environment variable (set by Terraform).
 * Bad data is a server error (a deploy mistake), not a 400.
 */
export function parseTargets(raw: string): Target[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("TARGETS_JSON is not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("TARGETS_JSON must be a list.");
  return parsed.map((item: unknown) => {
    const { targetId, name, description } = (item ?? {}) as Record<string, unknown>;
    if (
      typeof targetId !== "string" ||
      typeof name !== "string" ||
      typeof description !== "string"
    ) {
      throw new Error("Each target in TARGETS_JSON needs a targetId, a name and a description.");
    }
    // Copy only these three fields, so nothing else (like a URL) can ever reach a response.
    return { targetId, name, description };
  });
}

/** 400 unless the id is on the allow-list. The message never says what the real targets are. */
export function requireKnownTarget(targets: readonly Target[], targetId: string): void {
  if (!targets.some((t) => t.targetId === targetId)) throw badRequest("Unknown target.");
}
