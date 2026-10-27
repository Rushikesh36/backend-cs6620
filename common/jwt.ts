import { createHmac, timingSafeEqual } from "node:crypto";
import { unauthorized } from "./errors.js";

export type Role = "user" | "ci";
export interface Claims {
  sub: string;
  role: Role;
  iat: number;
  exp: number;
}

const MIN_SECRET_LENGTH = 32;
const HEADER = { alg: "HS256", typ: "JWT" } as const;

const b64url = (data: Buffer | string): string => Buffer.from(data).toString("base64url");
const nowSeconds = (): number => Math.floor(Date.now() / 1000);

function sign(signingInput: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

function checkSecret(secret: string): void {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error("JWT secret is too short.");
  }
}

/** Creates a signed token. `expiresIn` and the `exp` claim always agree. */
export function signToken(
  user: { username: string; role: Role },
  secret: string,
  ttlSeconds: number,
  now: number = nowSeconds(),
): { token: string; expiresIn: number; claims: Claims } {
  checkSecret(secret);
  const claims: Claims = { sub: user.username, role: user.role, iat: now, exp: now + ttlSeconds };
  const input = `${b64url(JSON.stringify(HEADER))}.${b64url(JSON.stringify(claims))}`;
  const token = `${input}.${b64url(sign(input, secret))}`;
  return { token, expiresIn: ttlSeconds, claims };
}

function parseJsonPart(part: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw unauthorized();
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Checks signature, algorithm, expiry and claim shapes.
 * Every failure throws the same 401 so callers learn nothing about why.
 */
export function verifyToken(token: string, secret: string, now: number = nowSeconds()): Claims {
  checkSecret(secret);
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  const [h, p, s] = parts as [string, string, string];

  // The header must be exactly HS256. This blocks "alg: none" and algorithm-swap attacks.
  const header = parseJsonPart(h);
  if (!isObject(header) || header.alg !== "HS256") throw unauthorized();

  const given = Buffer.from(s, "base64url");
  const expected = sign(`${h}.${p}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw unauthorized();

  const c = parseJsonPart(p);
  if (!isObject(c)) throw unauthorized();
  const { sub, role, iat, exp } = c;
  if (typeof sub !== "string" || sub.length === 0) throw unauthorized();
  if (role !== "user" && role !== "ci") throw unauthorized();
  if (!Number.isInteger(iat) || !Number.isInteger(exp)) throw unauthorized();
  if ((exp as number) <= now) throw unauthorized();
  return { sub, role, iat: iat as number, exp: exp as number };
}
