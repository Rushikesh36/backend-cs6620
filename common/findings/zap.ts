import { urlPath, type Severity } from "./fingerprint.js";
import {
  cleanText,
  isObject,
  MAX_LOCATION,
  MAX_MESSAGE,
  MAX_RULE_ID,
  ReportError,
  str,
  type ParsedFinding,
  type ParseResult,
} from "./report.js";

/** ZAP `riskcode` (a string in the JSON report) to ours. Documented in docs/report-parsers.md. */
// A Map, not an object: report text like "constructor" must not match built-in object keys.
const SEVERITY = new Map<string, Severity>([
  ["3", "HIGH"],
  ["2", "MEDIUM"],
  ["1", "LOW"],
  ["0", "INFO"],
]);

/**
 * Turns a ZAP traditional JSON report (`-J report.json`) into findings: one per alert instance,
 * or one site-wide finding for an alert ZAP marks as systemic.
 * Uses the plain `alert` title as the message: ZAP's `desc` is HTML and is never stored.
 * Throws ReportError if the report itself is unusable.
 */
export function parseZap(report: unknown): ParseResult {
  if (!isObject(report) || !Array.isArray(report.site)) {
    throw new ReportError("ZAP report has no site list.");
  }
  const findings: ParsedFinding[] = [];
  const warnings: string[] = [];

  for (const rawSite of report.site as unknown[]) {
    const alerts = isObject(rawSite) && Array.isArray(rawSite.alerts) ? rawSite.alerts : [];
    alerts.forEach((rawAlert: unknown, i) => {
      const a = isObject(rawAlert) ? rawAlert : {};
      // alertRef tells variants of one rule apart (10038-1 vs 10038-2); older reports only have pluginid.
      const ruleId = str(a.alertRef) ?? str(a.pluginid);
      const title = str(a.alert) ?? str(a.name);
      if (!ruleId || !Array.isArray(a.instances)) {
        warnings.push(`ZAP alert ${String(i)} skipped: missing rule or instances.`);
        return;
      }
      const risk = str(a.riskcode) ?? String(a.riskcode);
      const severity = SEVERITY.get(risk) ?? "INFO";
      if (!SEVERITY.has(risk)) {
        warnings.push(`ZAP alert ${ruleId}: unknown riskcode "${risk}", using INFO.`);
      }

      // ZAP marks site-wide problems (a missing header on every page) as systemic and lists only a
      // sample of pages, which changes between runs. One site-wide finding stays stable instead.
      if (a.systemic === true || a.systemic === "true") {
        const first: unknown = a.instances[0];
        const method = ((isObject(first) ? str(first.method) : undefined) ?? "GET")
          .trim()
          .toUpperCase();
        findings.push({
          identity: {
            scanType: "DAST",
            ruleId: cleanText(ruleId, MAX_RULE_ID),
            method,
            url: "/",
            param: "",
          },
          severity,
          location: `${method} / (site-wide)`,
          message: cleanText(title ?? ruleId, MAX_MESSAGE),
        });
        return;
      }

      for (const rawInstance of a.instances as unknown[]) {
        const ins = isObject(rawInstance) ? rawInstance : {};
        const uri = str(ins.uri);
        if (!uri) {
          warnings.push(`ZAP alert ${ruleId}: an instance without a URI was skipped.`);
          continue;
        }
        const method = (str(ins.method) ?? "GET").trim().toUpperCase();
        const param = (str(ins.param) ?? "").trim();
        const path = urlPath(uri);
        findings.push({
          identity: {
            scanType: "DAST",
            ruleId: cleanText(ruleId, MAX_RULE_ID),
            method,
            url: uri,
            param,
          },
          severity,
          // The contract's DAST location: "GET /rest/products/search?q" (parameter name, never its value).
          location: cleanText(`${method} ${path}${param ? `?${param}` : ""}`, MAX_LOCATION),
          message: cleanText(title ?? ruleId, MAX_MESSAGE),
        });
      }
    });
  }

  return { findings, warnings };
}
