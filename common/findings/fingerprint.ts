import { createHash } from "node:crypto";

export type Severity = "HIGH" | "MEDIUM" | "LOW" | "INFO";

/**
 * What makes two SAST findings "the same bug". No line number on purpose: adding a line above
 * the bug must not turn it into a new finding. Reasoning: docs/fingerprints.md.
 */
export interface SastIdentity {
  scanType: "SAST";
  ruleId: string;
  filePath: string;
  /** The matched code. Only its non-whitespace content counts. */
  snippet: string;
}

/** What makes two DAST findings "the same bug": the rule, the request and the parameter. */
export interface DastIdentity {
  scanType: "DAST";
  ruleId: string;
  method: string;
  /** Full URL or just the path. Only the path counts: no host, query values or fragment. */
  url: string;
  /** The attacked parameter, or "" when the finding is about the page itself. */
  param: string;
}

export type FindingIdentity = SastIdentity | DastIdentity;

/**
 * Drops all whitespace (spaces, tabs, newlines), so re-indenting or running a code formatter
 * (`f(a,b)` to `f(a, b)`) is not a change. Collapsing runs to one space would still differ there.
 */
export const normaliseSnippet = (snippet: string): string => snippet.replace(/\s+/g, "");

/** `./app\views.py` and `app/views.py` are the same file. */
export const normaliseFilePath = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(\.\/)+/, "");

/**
 * The path part of a URL. The host is dropped because each lab runs the target at its own
 * address; query values are dropped because a scanner tries many values against one parameter.
 */
export function urlPath(url: string): string {
  try {
    // The base only lets relative paths parse; absolute URLs ignore it.
    return new URL(url.trim(), "http://target.invalid").pathname;
  } catch {
    // One malformed URL in a report must not fail the whole scan: strip scheme, host, query and fragment by hand.
    const path =
      url
        .trim()
        .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, "")
        .split(/[?#]/)[0] ?? "";
    return path.startsWith("/") ? path : `/${path}`;
  }
}

/** A 64-character lowercase hex sha256 that stays the same for the same bug in later scans. */
export function fingerprint(projectId: string, identity: FindingIdentity): string {
  const parts =
    identity.scanType === "SAST"
      ? [
          projectId,
          "SAST",
          identity.ruleId.trim(),
          normaliseFilePath(identity.filePath),
          normaliseSnippet(identity.snippet),
        ]
      : [
          projectId,
          "DAST",
          identity.ruleId.trim(),
          identity.method.trim().toUpperCase(),
          urlPath(identity.url),
          identity.param.trim(),
        ];
  // A JSON array keeps the parts apart: with a plain "|" join, "a|b" + "c" and "a" + "b|c" would collide.
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}
