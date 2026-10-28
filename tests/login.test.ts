import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyToken } from "../common/jwt.js";
import { hashPassword } from "../common/passwords.js";
import { resetSecretCache } from "../common/secret.js";
import { handler } from "../lambdas/login/handler.js";
import { BAD_LOGIN_MESSAGE, login, type LoginDeps } from "../lambdas/login/login.js";
import { makeEvent } from "./helpers.js";

const SECRET = "login-test-secret-".padEnd(40, "x");
const PASSWORD = "correct horse battery";
const NOW = 1_800_000_000;
let hash: string;

beforeAll(async () => {
  hash = await hashPassword(PASSWORD);
  process.env.USERS_TABLE = "users";
  process.env.TOKEN_LIFETIME_SECONDS = "3600";
  process.env.JWT_SECRET_SSM_NAME = "/security-hub/jwt-secret";
});

const users: Record<string, { passwordHash: string; role: string; disabled?: boolean }> = {
  rushikesh: { passwordHash: "", role: "user" },
  "github-bot": { passwordHash: "", role: "ci" },
  gone: { passwordHash: "", role: "user", disabled: true },
};

function deps(over: Partial<LoginDeps> = {}): LoginDeps {
  return {
    getUser: (name) => {
      const u = users[name];
      return Promise.resolve(
        u ? ({ ...u, passwordHash: hash, disabled: u.disabled === true } as never) : undefined,
      );
    },
    getSecret: () => Promise.resolve(SECRET),
    ttlSeconds: 3600,
    now: NOW,
    ...over,
  };
}

async function status(body: Record<string, unknown>, d = deps()): Promise<number> {
  try {
    await login(body, d);
    return 200;
  } catch (e) {
    return (e as { statusCode: number }).statusCode;
  }
}

describe("login logic", () => {
  it("returns a token, expiresIn and the user for good credentials", async () => {
    const r = await login({ username: "rushikesh", password: PASSWORD }, deps());
    expect(r.expiresIn).toBe(3600);
    expect(r.user).toEqual({ username: "rushikesh", role: "user" });
    const claims = verifyToken(r.token, SECRET, NOW);
    expect(claims).toMatchObject({ sub: "rushikesh", role: "user" });
    expect(claims.exp).toBe(NOW + r.expiresIn); // exp agrees with expiresIn
  });

  it("gives the ci role to the bot", async () => {
    const r = await login({ username: "github-bot", password: PASSWORD }, deps());
    expect(r.user.role).toBe("ci");
  });

  it("returns 401 for a wrong password, unknown user and disabled user", async () => {
    expect(await status({ username: "rushikesh", password: "wrong password!!" })).toBe(401);
    expect(await status({ username: "nobody", password: PASSWORD })).toBe(401);
    expect(await status({ username: "gone", password: PASSWORD })).toBe(401);
  });

  it("runs exactly one bcrypt comparison on every path", async () => {
    for (const [username, password] of [
      ["rushikesh", PASSWORD],
      ["rushikesh", "wrong password!!"],
      ["nobody", PASSWORD],
      ["gone", PASSWORD],
    ] as const) {
      const verify = vi.fn(() => Promise.resolve(false));
      await status({ username, password }, deps({ verify }));
      expect(verify).toHaveBeenCalledTimes(1);
    }
  });

  it("takes about the same time for an unknown user as for a wrong password", async () => {
    const time = async (username: string): Promise<number> => {
      const t = performance.now();
      await status({ username, password: "wrong password!!" });
      return performance.now() - t;
    };
    await time("nobody"); // warm up: builds the dummy hash once
    const median = async (name: string): Promise<number> => {
      const xs: number[] = [];
      for (let i = 0; i < 5; i++) xs.push(await time(name));
      return xs.sort((a, b) => a - b)[2] ?? 0;
    };
    const unknown = await median("nobody");
    const wrong = await median("rushikesh");
    expect(unknown / wrong).toBeGreaterThan(0.5);
    expect(unknown / wrong).toBeLessThan(2);
  });

  it.each([
    ["missing username", { password: PASSWORD }],
    ["missing password", { username: "rushikesh" }],
    ["empty username", { username: "", password: PASSWORD }],
    ["empty password", { username: "rushikesh", password: "" }],
    ["non-string username", { username: 5, password: PASSWORD }],
    ["non-string password", { username: "rushikesh", password: { a: 1 } }],
    ["username too long", { username: "a".repeat(65), password: PASSWORD }],
    ["password over 72 characters", { username: "rushikesh", password: "x".repeat(73) }],
    ["password over 72 bytes", { username: "rushikesh", password: "é".repeat(40) }],
  ])("returns 400 for %s", async (_n, body) => {
    expect(await status(body)).toBe(400);
  });
});

describe("login handler (POST /login)", () => {
  const ddb = mockClient(DynamoDBDocumentClient);
  const ssm = mockClient(SSMClient);
  beforeEach(() => {
    ddb.reset();
    ssm.reset();
    resetSecretCache();
    ssm.on(GetParameterCommand).resolves({ Parameter: { Value: SECRET } });
    ddb.on(GetCommand).callsFake((input: { Key: { username: string } }) => {
      const u = users[input.Key.username];
      return { Item: u ? { username: input.Key.username, ...u, passwordHash: hash } : undefined };
    });
  });
  const post = (body: unknown) => handler(makeEvent({ body: JSON.stringify(body) }));

  it("200 with the exact contract shape", async () => {
    const res = (await post({ username: "rushikesh", password: PASSWORD })) as {
      statusCode: number;
      body: string;
    };
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["expiresIn", "token", "user"]);
    expect(body.user).toEqual({ username: "rushikesh", role: "user" });
    const payload = JSON.parse(
      Buffer.from(String(body.token).split(".")[1] ?? "", "base64url").toString(),
    ) as { exp: number; iat: number };
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(body.expiresIn);
  });

  it("wrong username and wrong password give an IDENTICAL 401 response", async () => {
    const a = await post({ username: "nobody", password: PASSWORD });
    const b = await post({ username: "rushikesh", password: "wrong password!!" });
    const c = await post({ username: "gone", password: PASSWORD });
    expect(a).toEqual(b);
    expect(a).toEqual(c);
    expect(a.statusCode).toBe(401);
    expect(JSON.parse(a.body as string)).toEqual({ error: BAD_LOGIN_MESSAGE });
  });

  it("400 for a body that is not JSON", async () => {
    const res = await handler(makeEvent({ body: "not json" }));
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body as string)).toHaveProperty("error");
  });

  it("never writes the password or token to the logs", async () => {
    vi.stubEnv("LOG_LEVEL", "info");
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const ok = (await post({ username: "rushikesh", password: PASSWORD })) as { body: string };
    await post({ username: "rushikesh", password: "wrong password!!" });
    const logs = write.mock.calls.map((c) => String(c[0])).join("");
    write.mockRestore();
    vi.unstubAllEnvs();
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain("wrong password!!");
    expect(logs).not.toContain((JSON.parse(ok.body) as { token: string }).token);
    expect(logs).toContain("Login failed");
  });

  it("500 (generic) if the user record in the table is malformed", async () => {
    ddb.on(GetCommand).resolves({ Item: { username: "rushikesh", role: "admin" } });
    const res = await post({ username: "rushikesh", password: PASSWORD });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain("malformed");
  });

  it("caches the secret so SSM is read once", async () => {
    await post({ username: "rushikesh", password: PASSWORD });
    await post({ username: "rushikesh", password: PASSWORD });
    expect(ssm.commandCalls(GetParameterCommand)).toHaveLength(1);
  });
});
