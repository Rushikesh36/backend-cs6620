import type { Target } from "../../common/targets.js";

/** What GET /targets returns. Only the id, name and description. The real URL is never here. */
export function listTargets(targets: readonly Target[]): { targets: Target[] } {
  return {
    targets: targets.map(({ targetId, name, description }) => ({ targetId, name, description })),
  };
}
