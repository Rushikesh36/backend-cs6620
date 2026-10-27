import { afterEach, describe, expect, it, vi } from "vitest";
import { badRequest, conflict, forbidden, notFound, unauthorized } from "../common/errors.js";
import { json, toErrorResponse, wrap } from "../common/http.js";
import { logger, redact } from "../common/logger.js";
import {
  parseJsonObject,
  parseLimit,
  requireProjectId,
  requireScanType,
  requireString,
  requireTargetId,
  isValidJobId,
  MAX_BODY_BYTES,
} from "../common/validation.js";
import { makeEvent } from "./helpers.js";

afterEach(() => vi.restoreAllMocks());

describe("error helpers", () => {
  it("carry the right status codes", () => {
    expect(badRequest("x").statusCode).toBe(400);
    expect(unauthorized().statusCode).toBe(401);
    expect(forbidden().statusCode).toBe(403);
    expect(notFound("x").statusCode).toBe(404);
    expect(conflict("x").statusCode).toBe(409);
  });
});

describe("http responses", () => {
  it("json() sets status, content type and a JSON body", () => {
    const res = json(200, { a: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(res.body as string)).toEqual({ a: 1 });
  });

  it("maps an HttpError to { error }", () => {
    const res = toErrorResponse(notFound("Scan not found."));
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body as string)).toEqual({ error: "Scan not found." });
  });

  it("hides the details of unexpected errors behind a generic 500", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const res = toErrorResponse(new Error("db password is hunter2"));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("hunter2");
    expect(write).toHaveBeenCalled();
  });

  it("wrap() returns the handler result or converts a throw", async () => {
    const ok = wrap(() => Promise.resolve(json(200, { ok: true })));
    const bad = wrap(() => Promise.reject(conflict("This scan was already started.")));
    expect((await ok(makeEvent())).statusCode).toBe(200);
    const res = await bad(makeEvent());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body as string)).toEqual({ error: "This scan was already started." });
  });
});

describe("projectId rule", () => {
  it.each(["abc", "my-project-1", "a" + "b".repeat(49)])("accepts %s", (id) => {
    expect(requireProjectId(id)).toBe(id);
  });

  it.each([
    "ab", // too short
    "a" + "b".repeat(50), // 51 characters
    "1abc", // starts with a digit
    "-abc", // starts with a hyphen
    "Abc", // uppercase
    "ab_c", // underscore
    "ab c", // space
    "abc\n", // trailing newline must not slip past the regex
    "",
    42,
    null,
    undefined,
  ])("rejects %j", (id) => {
    expect(() => requireProjectId(id)).toThrow(/Project ID/);
  });
});

describe("other validators", () => {
  it("scanType must be SAST or DAST", () => {
    expect(requireScanType("SAST")).toBe("SAST");
    expect(requireScanType("DAST")).toBe("DAST");
    for (const bad of ["sast", "", undefined, 1, "SAST "]) {
      expect(() => requireScanType(bad)).toThrow(/SAST or DAST/);
    }
  });

  it("targetId must look like a short slug", () => {
    expect(requireTargetId("juice-shop")).toBe("juice-shop");
    for (const bad of ["http://evil.example", "a b", "", 5, "x".repeat(51)]) {
      expect(() => requireTargetId(bad)).toThrow();
    }
  });

  it("jobId must be a lowercase uuid", () => {
    expect(isValidJobId("3f2b8c1e-9d4a-4b7e-8a11-0c5d6e7f8a9b")).toBe(true);
    expect(isValidJobId("not-a-uuid")).toBe(false);
    expect(isValidJobId("3F2B8C1E-9D4A-4B7E-8A11-0C5D6E7F8A9B")).toBe(false);
  });

  it("requireString checks presence, type and length", () => {
    expect(requireString({ a: "x" }, "a", 5)).toBe("x");
    expect(() => requireString({}, "a", 5)).toThrow(/required/);
    expect(() => requireString({ a: "" }, "a", 5)).toThrow(/required/);
    expect(() => requireString({ a: 7 }, "a", 5)).toThrow(/required/);
    expect(() => requireString({ a: "toolong" }, "a", 5)).toThrow(/too long/);
  });

  it("parseLimit defaults to 20 and allows 1..100 only", () => {
    expect(parseLimit(undefined)).toBe(20);
    expect(parseLimit("1")).toBe(1);
    expect(parseLimit("100")).toBe(100);
    for (const bad of ["0", "101", "-1", "abc", "1.5", "", "10000000"]) {
      expect(() => parseLimit(bad)).toThrow(/limit/);
    }
  });
});

describe("parseJsonObject", () => {
  it("parses an object body", () => {
    expect(parseJsonObject(makeEvent({ body: '{"a":1}' }))).toEqual({ a: 1 });
  });

  it("reads a base64 body", () => {
    const body = Buffer.from('{"a":2}').toString("base64");
    expect(parseJsonObject(makeEvent({ body, isBase64Encoded: true }))).toEqual({ a: 2 });
  });

  it.each([undefined, "", "not json", "[1]", "null", '"text"', "42"])("rejects body %j", (body) => {
    const event = makeEvent(body === undefined ? {} : { body });
    expect(() => parseJsonObject(event)).toThrow(/JSON/);
  });

  it("rejects an oversized body", () => {
    const body = JSON.stringify({ a: "x".repeat(MAX_BODY_BYTES) });
    expect(() => parseJsonObject(makeEvent({ body }))).toThrow(/too large/);
  });
});

describe("logger", () => {
  it("redacts secret-looking keys, even nested", () => {
    const out = redact({
      username: "rushikesh",
      password: "hunter2",
      headers: { Authorization: "Bearer abc" },
      nested: [{ passwordHash: "$2a$..." }, { jwtToken: "x" }],
    });
    expect(JSON.stringify(out)).not.toMatch(/hunter2|Bearer abc|\$2a|"x"/);
    expect(out).toMatchObject({ username: "rushikesh", password: "[redacted]" });
  });

  it("writes one JSON line per log call", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logger.info("hello", { password: "p", jobId: "j1" });
    const line = String(write.mock.calls[0]?.[0]);
    expect(line.endsWith("\n")).toBe(true);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      message: "hello",
      jobId: "j1",
      password: "[redacted]",
    });
  });
});
