import { beforeEach, describe, expect, it } from "vitest";
import { handler } from "../lambdas/targets/handler.js";
import { listTargets } from "../lambdas/targets/targets.js";
import { makeEvent } from "./helpers.js";

const JUICE = {
  targetId: "juice-shop",
  name: "OWASP Juice Shop",
  description: "Deliberately vulnerable test app",
};

const asUser = {
  requestContext: { authorizer: { lambda: { username: "rushikesh", role: "user" } } } as never,
};

describe("listTargets", () => {
  it("returns exactly the contract shape", () => {
    expect(listTargets([JUICE])).toEqual({ targets: [JUICE] });
  });

  it("returns an empty list when there are no targets", () => {
    expect(listTargets([])).toEqual({ targets: [] });
  });
});

describe("GET /targets handler", () => {
  beforeEach(() => {
    process.env.TARGETS_JSON = JSON.stringify([JUICE]);
  });

  it("200 with the allow-list", async () => {
    const res = await handler(makeEvent(asUser));
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body as string)).toEqual({ targets: [JUICE] });
  });

  it("never returns a URL, even if the configuration contains one", async () => {
    process.env.TARGETS_JSON = JSON.stringify([
      { ...JUICE, url: "http://10.0.0.5:3000", internalHost: "juice.internal" },
    ]);
    const res = await handler(makeEvent(asUser));
    expect(res.body).not.toContain("10.0.0.5");
    expect(res.body).not.toContain("juice.internal");
    expect(JSON.parse(res.body as string)).toEqual({ targets: [JUICE] });
  });

  it("401 without a caller from the authorizer", async () => {
    const res = await handler(makeEvent());
    expect(res.statusCode).toBe(401);
  });

  it("generic 500 if the configuration is broken", async () => {
    process.env.TARGETS_JSON = "not json";
    const res = await handler(makeEvent(asUser));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("TARGETS_JSON");
  });
});
