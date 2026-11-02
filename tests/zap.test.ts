import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReportError } from "../common/findings/report.js";
import { parseZap } from "../common/findings/zap.js";

// Real ZAP 2.17.0 full-scan reports (`-J`) of a local test site, trimmed.
const report = (name: string): unknown =>
  JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- fixed test fixture path
    readFileSync(join(import.meta.dirname, "fixtures", "reports", name), "utf8"),
  );

const alert = (over: Record<string, unknown> = {}) => ({
  pluginid: "40012",
  alertRef: "40012",
  alert: "Cross Site Scripting (Reflected)",
  riskcode: "3",
  desc: "<p>HTML description that must never be stored</p>",
  instances: [{ uri: "http://juice:3000/rest/search?q=%3Cscript%3E", method: "GET", param: "q" }],
  ...over,
});
const zap = (...alerts: unknown[]) => ({ site: [{ "@name": "http://juice:3000", alerts }] });

describe("real ZAP report", () => {
  const { findings, warnings } = parseZap(report("zap-v1.json"));

  it("parses every alert with no warnings", () => {
    expect(warnings).toEqual([]);
    expect(findings.length).toBeGreaterThan(10);
  });

  it("maps a SQL injection to the contract's DAST location", () => {
    const sqli = findings.find((f) => f.identity.ruleId === "40018");
    expect(sqli).toMatchObject({
      severity: "HIGH",
      location: "GET /user?id",
      message: "SQL Injection - MySQL",
      identity: { scanType: "DAST", method: "GET", param: "id" },
    });
  });

  it("makes one site-wide finding for a systemic alert", () => {
    const server = findings.filter((f) => f.identity.ruleId === "10036-2");
    expect(server).toEqual([
      expect.objectContaining({ location: "GET / (site-wide)", severity: "LOW" }),
    ]);
  });

  it("never stores ZAP's HTML description", () => {
    for (const f of findings) expect(f.message).not.toMatch(/<p>/);
  });
});

describe("severity mapping", () => {
  it.each([
    ["3", "HIGH"],
    ["2", "MEDIUM"],
    ["1", "LOW"],
    ["0", "INFO"],
  ])("riskcode %s is %s", (riskcode, ours) => {
    expect(parseZap(zap(alert({ riskcode }))).findings[0]?.severity).toBe(ours);
  });

  it("accepts a numeric riskcode", () => {
    expect(parseZap(zap(alert({ riskcode: 2 }))).findings[0]?.severity).toBe("MEDIUM");
  });

  it("treats an unknown riskcode as INFO and warns", () => {
    const { findings, warnings } = parseZap(zap(alert({ riskcode: "9" })));
    expect(findings[0]?.severity).toBe("INFO");
    expect(warnings[0]).toContain("unknown riskcode");
  });

  it("does not let text such as 'constructor' match built-in object keys", () => {
    for (const riskcode of ["constructor", "toString", "__proto__"]) {
      expect(parseZap(zap(alert({ riskcode }))).findings[0]?.severity).toBe("INFO");
    }
  });
});

describe("instances", () => {
  it("makes one finding per instance and never puts the attack value in the location", () => {
    const { findings } = parseZap(
      zap(
        alert({
          instances: [
            { uri: "http://juice:3000/rest/search?q=%3Cscript%3E", method: "get", param: "q" },
            { uri: "http://juice:3000/api/Users", method: "POST", param: "email" },
            { uri: "http://juice:3000/about", method: "GET", param: "" },
          ],
        }),
      ),
    );
    expect(findings.map((f) => f.location)).toEqual([
      "GET /rest/search?q",
      "POST /api/Users?email",
      "GET /about",
    ]);
  });

  it("uses pluginid when an older report has no alertRef", () => {
    const { findings } = parseZap(zap(alert({ alertRef: undefined, pluginid: "10021" })));
    expect(findings[0]?.identity.ruleId).toBe("10021");
  });
});

describe("untrusted input", () => {
  it("rejects a report without a site list", () => {
    expect(() => parseZap({})).toThrow(ReportError);
    expect(() => parseZap("not json")).toThrow(ReportError);
  });

  it("skips broken alerts and instances and warns, keeping the good ones", () => {
    const { findings, warnings } = parseZap(
      zap(
        alert(),
        alert({ alertRef: undefined, pluginid: undefined }),
        alert({ instances: "nope" }),
        alert({ instances: [{ method: "GET" }] }),
      ),
    );
    expect(findings).toHaveLength(1);
    expect(warnings).toHaveLength(3);
  });

  it("copes with sites that have no alerts", () => {
    expect(parseZap({ site: [{}, { alerts: [] }] }).findings).toEqual([]);
  });
});
