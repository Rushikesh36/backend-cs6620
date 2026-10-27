import { createHmac } from "node:crypto";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import type { APIGatewayRequestAuthorizerEventV2 } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCaller, requireRole } from "../common/auth.js";
import { HttpError } from "../common/errors.js";
import { signToken } from "../common/jwt.js";
import { resetSecretCache } from "../common/secret.js";
import { handler } from "../lambdas/authorizer/handler.js";
import { authorize } from "../lambdas/authorizer/authorize.js";
import { makeEvent } from "./helpers.js";

const SECRET = "authorizer-test-secret-".padEnd(40, "x");
const now = () => Math.floor(Date.now() / 1000);
const getSecret = () => Promise.resolve(SECRET);

const evt = (authorization?: string): APIGatewayRequestAuthorizerEventV2 =>
  ({
    version: "2.0",
    type: "REQUEST",
    headers: authorization === undefined ? {} : { authorization },
  }) as unknown as APIGatewayRequestAuthorizerEventV2;

const good = (role: "user" | "ci" = "user") =>
  signToken({ username: "rushikesh", role }, SECRET, 3600).token;
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
function forge(header: unknown, claims: unknown, secret = SECRET): string {
  const input = `${b64(header)}.${b64(claims)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
const claims = { sub: "u", role: "user", iat: now(), exp: now() + 3600 };

describe("authorize", () => {
  it("allows a valid token and passes username and role on", async () => {
    const r = await authorize(evt(`Bearer ${good()}`), getSecret);
    expect(r).toEqual({ isAuthorized: true, context: { username: "rushikesh", role: "user" } });
  });

  it("passes the ci role through", async () => {
    const r = await authorize(evt(`Bearer ${good("ci")}`), getSecret);
    expect(r.context.role).toBe("ci");
  });

  it("accepts a lowercase 'bearer' scheme", async () => {
    expect((await authorize(evt(`bearer ${good()}`), getSecret)).isAuthorized).toBe(true);
  });

  it.each([
    ["no header", undefined],
    ["empty header", ""],
    ["scheme only", "Bearer"],
    ["scheme and space only", "Bearer "],
    ["wrong scheme", `Basic ${good()}`],
    ["token without scheme", good()],
    ["two spaces", `Bearer  ${good()}`],
    ["extra word", `Bearer ${good()} extra`],
    ["not a jwt", "Bearer abc"],
    ["oversized header", `Bearer ${"a".repeat(5000)}.b.c`],
  ])("denies %s", async (_n, header) => {
    expect((await authorize(evt(header), getSecret)).isAuthorized).toBe(false);
  });

  it("denies an expired token", async () => {
    const t = signToken({ username: "u", role: "user" }, SECRET, 3600, now() - 7200).token;
    expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
  });

  it("denies a token signed with another secret (forged)", async () => {
    const t = forge({ alg: "HS256" }, claims, "x".repeat(40));
    expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
  });

  it("denies a tampered payload", async () => {
    const [h, , s] = good().split(".");
    const t = `${h ?? ""}.${b64({ ...claims, role: "ci" })}.${s ?? ""}`;
    expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
  });

  it("denies alg none and other algorithms", async () => {
    const none = `${b64({ alg: "none" })}.${b64(claims)}.${b64("sig")}`;
    for (const t of [none, forge({ alg: "HS512" }, claims), forge({ alg: "RS256" }, claims)]) {
      expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
    }
  });

  it("denies an unknown role", async () => {
    const t = forge({ alg: "HS256" }, { ...claims, role: "admin" });
    expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
  });

  it("denies a token with no exp", async () => {
    const t = forge({ alg: "HS256" }, { sub: "u", role: "user", iat: now() });
    expect((await authorize(evt(`Bearer ${t}`), getSecret)).isAuthorized).toBe(false);
  });

  it("throws (so the caller gets a 5xx, not a logout) if the secret cannot be read", async () => {
    const broken = () => Promise.reject(new Error("SSM unavailable"));
    await expect(authorize(evt(`Bearer ${good()}`), broken)).rejects.toThrow("SSM unavailable");
  });

  it("does not need the secret at all when there is no token", async () => {
    const getSecretSpy = vi.fn(getSecret);
    await authorize(evt(), getSecretSpy);
    expect(getSecretSpy).not.toHaveBeenCalled();
  });

  it("never logs the token", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const bad = forge({ alg: "HS256" }, claims, "x".repeat(40));
    await authorize(evt(`Bearer ${bad}`), getSecret);
    const logs = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    vi.unstubAllEnvs();
    expect(logs).toContain("Token rejected");
    expect(logs).not.toContain(bad);
  });
});

describe("authorizer handler", () => {
  const ssm = mockClient(SSMClient);
  beforeEach(() => {
    ssm.reset();
    resetSecretCache();
    process.env.JWT_SECRET_SSM_NAME = "/security-hub/jwt-secret";
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
  });

  it("reads the secret from SSM and allows a valid token", async () => {
    const r = await handler(evt(`Bearer ${good()}`));
    expect(r.isAuthorized).toBe(true);
    expect(ssm.commandCalls(GetParameterCommand)[0]?.args[0].input).toMatchObject({
      Name: "/security-hub/jwt-secret",
      WithDecryption: true,
    });
  });

  it("denies without calling SSM when there is no token", async () => {
    expect((await handler(evt())).isAuthorized).toBe(false);
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(0);
  });
});

describe("getCaller and requireRole", () => {
  const withCtx = (lambda: unknown) =>
    makeEvent({ requestContext: { authorizer: { lambda } } } as never);

  it("reads username and role from the authorizer context", () => {
    expect(getCaller(withCtx({ username: "bot", role: "ci" }))).toEqual({
      username: "bot",
      role: "ci",
    });
  });

  it.each([
    ["no context at all", makeEvent()],
    ["no authorizer", makeEvent({ requestContext: {} } as never)],
    ["null context", withCtx(null)],
    ["empty username", withCtx({ username: "", role: "user" })],
    ["missing role", withCtx({ username: "u" })],
    ["unknown role", withCtx({ username: "u", role: "admin" })],
  ])("refuses with 401 when there is %s", (_n, event) => {
    try {
      getCaller(event);
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(401);
      return;
    }
    throw new Error("expected 401");
  });

  it("requireRole gives 403 for a role that is not allowed", () => {
    expect(() => {
      requireRole({ username: "u", role: "user" }, "user", "ci");
    }).not.toThrow();
    try {
      requireRole({ username: "bot", role: "ci" }, "user");
    } catch (e) {
      expect((e as HttpError).statusCode).toBe(403);
      return;
    }
    throw new Error("expected 403");
  });
});
