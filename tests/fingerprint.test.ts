import { describe, expect, it } from "vitest";
import {
  fingerprint,
  normaliseFilePath,
  normaliseSnippet,
  urlPath,
  type DastIdentity,
  type SastIdentity,
} from "../common/findings/fingerprint.js";

const sast: SastIdentity = {
  scanType: "SAST",
  ruleId: "python.lang.security.sqli",
  filePath: "app/views.py",
  snippet: 'cursor.execute("SELECT * FROM users WHERE id=" + user_id)',
};

const dast: DastIdentity = {
  scanType: "DAST",
  ruleId: "40018",
  method: "GET",
  url: "http://juice-shop.internal:3000/rest/products/search?q=apple",
  param: "q",
};

describe("fingerprint format", () => {
  it("is 64 lowercase hex characters (sha256)", () => {
    expect(fingerprint("demo", sast)).toMatch(/^[0-9a-f]{64}$/);
    expect(fingerprint("demo", dast)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is the same every time for the same input", () => {
    expect(fingerprint("demo", sast)).toBe(fingerprint("demo", { ...sast }));
    expect(fingerprint("demo", dast)).toBe(fingerprint("demo", { ...dast }));
  });
});

describe("SAST fingerprint", () => {
  const base = fingerprint("demo", sast);

  it("ignores indentation, line breaks and formatter spacing inside the matched code", () => {
    const reformatted = {
      ...sast,
      snippet: '    cursor.execute(\n\t"SELECT * FROM users WHERE id="   + user_id)  ',
    };
    expect(fingerprint("demo", reformatted)).toBe(base);
  });

  it("treats ./app/views.py, app\\views.py and app/views.py as the same file", () => {
    expect(fingerprint("demo", { ...sast, filePath: "./app/views.py" })).toBe(base);
    expect(fingerprint("demo", { ...sast, filePath: "app\\views.py" })).toBe(base);
  });

  it("changes when the project, rule, file or code changes", () => {
    expect(fingerprint("other-project", sast)).not.toBe(base);
    expect(fingerprint("demo", { ...sast, ruleId: "python.lang.security.xss" })).not.toBe(base);
    expect(fingerprint("demo", { ...sast, filePath: "app/admin.py" })).not.toBe(base);
    expect(fingerprint("demo", { ...sast, snippet: "cursor.execute(query)" })).not.toBe(base);
  });

  it("does not let field values run into each other", () => {
    const a = fingerprint("demo", { ...sast, ruleId: "rule|a", filePath: "b" });
    const b = fingerprint("demo", { ...sast, ruleId: "rule", filePath: "a|b" });
    expect(a).not.toBe(b);
  });
});

describe("DAST fingerprint", () => {
  const base = fingerprint("demo", dast);

  it("ignores query values, because a scanner tries many values on one parameter", () => {
    const other = { ...dast, url: "http://juice-shop.internal:3000/rest/products/search?q=%27OR1" };
    expect(fingerprint("demo", other)).toBe(base);
  });

  it("ignores the host, so each lab's target address gives the same fingerprint", () => {
    expect(
      fingerprint("demo", { ...dast, url: "http://10.0.3.17:3000/rest/products/search" }),
    ).toBe(base);
    expect(fingerprint("demo", { ...dast, url: "/rest/products/search?q=x" })).toBe(base);
  });

  it("ignores the case of the HTTP method", () => {
    expect(fingerprint("demo", { ...dast, method: "get" })).toBe(base);
  });

  it("changes when the rule, method, path or parameter changes", () => {
    expect(fingerprint("demo", { ...dast, ruleId: "40012" })).not.toBe(base);
    expect(fingerprint("demo", { ...dast, method: "POST" })).not.toBe(base);
    expect(fingerprint("demo", { ...dast, url: "/rest/user/login" })).not.toBe(base);
    expect(fingerprint("demo", { ...dast, param: "id" })).not.toBe(base);
    expect(fingerprint("demo", { ...dast, param: "" })).not.toBe(base);
  });
});

describe("SAST and DAST never share a fingerprint", () => {
  it("keeps the scan type in the hash", () => {
    const s: SastIdentity = { scanType: "SAST", ruleId: "r", filePath: "/x", snippet: "" };
    const d: DastIdentity = { scanType: "DAST", ruleId: "r", method: "", url: "/x", param: "" };
    expect(fingerprint("demo", s)).not.toBe(fingerprint("demo", d));
  });
});

describe("helpers", () => {
  it("normaliseSnippet drops all whitespace", () => {
    expect(normaliseSnippet("  f(a, \n\t b)  ")).toBe("f(a,b)");
  });

  it("normaliseFilePath uses forward slashes and drops leading ./", () => {
    expect(normaliseFilePath(" ./././src\\a.py ")).toBe("src/a.py");
  });

  it("urlPath keeps only the path", () => {
    expect(urlPath("https://h:8080/a/b?x=1#top")).toBe("/a/b");
    expect(urlPath("/a/b?x=1")).toBe("/a/b");
    expect(urlPath("http://h")).toBe("/");
  });

  it("urlPath does not throw on a malformed URL, so one bad report line cannot fail a scan", () => {
    expect(urlPath("http://[broken/rest/x?q=1")).toBe("/rest/x");
    expect(urlPath("http://bad host/rest/x?q=1")).toBe("/rest/x");
    expect(() => fingerprint("demo", { ...dast, url: "http://[broken" })).not.toThrow();
  });
});
