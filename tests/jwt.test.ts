import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HttpError } from "../common/errors.js";
import { signToken, verifyToken } from "../common/jwt.js";

const SECRET = "s".repeat(40);
const NOW = 1_800_000_000;
const user = { username: "rushikesh", role: "user" } as const;

const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
/** Builds a token by hand so tests can forge odd ones. */
function forge(header: unknown, claims: unknown, secret = SECRET): string {
  const input = `${b64(header)}.${b64(claims)}`;
  const sig = createHmac("sha256", secret).update(input).digest("base64url");
  return `${input}.${sig}`;
}
const good = { sub: "u", role: "user", iat: NOW, exp: NOW + 3600 };
const hs256 = { alg: "HS256", typ: "JWT" };

function expect401(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(401);
    return;
  }
  throw new Error("expected a 401");
}

describe("signToken", () => {
  it("makes a token whose exp, iat and expiresIn agree", () => {
    const { token, expiresIn, claims } = signToken(user, SECRET, 3600, NOW);
    expect(expiresIn).toBe(3600);
    expect(claims).toEqual({ sub: "rushikesh", role: "user", iat: NOW, exp: NOW + 3600 });
    // The browser reads exp without checking the signature.
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      exp: number;
    };
    expect(payload.exp).toBe(NOW + expiresIn);
    expect(typeof payload.exp).toBe("number");
  });

  it("refuses a short secret", () => {
    expect(() => signToken(user, "short", 3600)).toThrow(/too short/);
  });
});

describe("verifyToken", () => {
  it("accepts a valid token", () => {
    const { token } = signToken({ username: "bot", role: "ci" }, SECRET, 3600, NOW);
    expect(verifyToken(token, SECRET, NOW + 10)).toMatchObject({ sub: "bot", role: "ci" });
  });

  it("rejects an expired token, including exactly at exp", () => {
    const { token } = signToken(user, SECRET, 3600, NOW);
    expect401(() => verifyToken(token, SECRET, NOW + 3600));
    expect401(() => verifyToken(token, SECRET, NOW + 99999));
  });

  it("rejects a token signed with another secret", () => {
    expect401(() => verifyToken(forge(hs256, good, "x".repeat(40)), SECRET, NOW));
  });

  it("rejects a tampered payload", () => {
    const { token } = signToken(user, SECRET, 3600, NOW);
    const [h, , s] = token.split(".");
    const evil = b64({ ...good, role: "ci" });
    expect401(() => verifyToken(`${h ?? ""}.${evil}.${s ?? ""}`, SECRET, NOW));
  });

  it("rejects alg none and other algorithms", () => {
    const noSig = `${b64({ alg: "none", typ: "JWT" })}.${b64(good)}.`;
    expect401(() => verifyToken(noSig, SECRET, NOW));
    expect401(() => verifyToken(forge({ alg: "none" }, good), SECRET, NOW));
    expect401(() => verifyToken(forge({ alg: "HS512" }, good), SECRET, NOW));
    expect401(() => verifyToken(forge({ alg: "RS256" }, good), SECRET, NOW));
  });

  it.each(["", "abc", "a.b", "a.b.c.d", "..", "a.b.c"])("rejects malformed token %j", (t) => {
    expect401(() => verifyToken(t, SECRET, NOW));
  });

  it.each([
    ["missing exp", { sub: "u", role: "user", iat: NOW }],
    ["string exp", { ...good, exp: String(NOW + 3600) }],
    ["fractional exp", { ...good, exp: NOW + 3600.5 }],
    ["missing iat", { sub: "u", role: "user", exp: NOW + 3600 }],
    ["missing sub", { role: "user", iat: NOW, exp: NOW + 3600 }],
    ["empty sub", { ...good, sub: "" }],
    ["unknown role", { ...good, role: "admin" }],
    ["missing role", { sub: "u", iat: NOW, exp: NOW + 3600 }],
    ["array payload", [1, 2]],
  ])("rejects a correctly signed token with %s", (_name, claims) => {
    expect401(() => verifyToken(forge(hs256, claims), SECRET, NOW));
  });

  it("rejects a signature of the wrong length without throwing a different error", () => {
    const { token } = signToken(user, SECRET, 3600, NOW);
    expect401(() => verifyToken(`${token}AAAA`, SECRET, NOW));
  });
});
