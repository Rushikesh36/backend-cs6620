import { randomBytes } from "node:crypto";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { badRequest, unauthorized } from "../../common/errors.js";
import { signToken, type Role } from "../../common/jwt.js";
import { logger } from "../../common/logger.js";
import { hashPassword, MAX_PASSWORD_BYTES, verifyPassword } from "../../common/passwords.js";
import { requireString } from "../../common/validation.js";

export const MAX_USERNAME_LENGTH = 64;

/** The same message for a wrong username and a wrong password, so an attacker learns nothing. */
export const BAD_LOGIN_MESSAGE = "Incorrect username or password.";

interface UserRecord {
  passwordHash: string;
  role: Role;
  disabled: boolean;
}

export interface LoginDeps {
  getUser: (username: string) => Promise<UserRecord | undefined>;
  getSecret: () => Promise<string>;
  ttlSeconds: number;
  verify?: (password: string, hash: string) => Promise<boolean>;
  now?: number;
}

export interface LoginResult {
  token: string;
  expiresIn: number;
  user: { username: string; role: Role };
}

// A real bcrypt hash of a random password nobody knows, made with the same cost as real ones.
// Unknown users are compared against it so the response takes about as long as a real check.
let dummyHash: Promise<string> | undefined;
const getDummyHash = (): Promise<string> =>
  (dummyHash ??= hashPassword(randomBytes(24).toString("hex")));

export async function login(body: Record<string, unknown>, deps: LoginDeps): Promise<LoginResult> {
  const username = requireString(body, "username", MAX_USERNAME_LENGTH);
  const password = requireString(body, "password", MAX_PASSWORD_BYTES);
  // Length is in characters above; bcrypt cares about bytes.
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    throw badRequest("password is too long.");
  }

  const verify = deps.verify ?? verifyPassword;
  const user = await deps.getUser(username);

  // Exactly one bcrypt comparison on every path below.
  const hash = user ? user.passwordHash : await getDummyHash();
  const passwordOk = await verify(password, hash);

  if (!user || user.disabled || !passwordOk) {
    // The reason goes to our log only, never to the caller.
    const reason = !user ? "unknown_user" : user.disabled ? "disabled" : "bad_password";
    logger.warn("Login failed", { username, reason });
    throw unauthorized(BAD_LOGIN_MESSAGE);
  }

  const secret = await deps.getSecret();
  const { token, expiresIn } = signToken(
    { username, role: user.role },
    secret,
    deps.ttlSeconds,
    deps.now,
  );
  logger.info("Login ok", { username, role: user.role });
  return { token, expiresIn, user: { username, role: user.role } };
}

/** Reads one user from the users table. Bad data in the table is a server error, not a 401. */
export async function getUserFromTable(
  client: DynamoDBDocumentClient,
  table: string,
  username: string,
): Promise<UserRecord | undefined> {
  const out = await client.send(new GetCommand({ TableName: table, Key: { username } }));
  const item = out.Item;
  if (!item) return undefined;
  const { passwordHash, role, disabled } = item as Record<string, unknown>;
  if (typeof passwordHash !== "string" || (role !== "user" && role !== "ci")) {
    throw new Error(`User record for ${username} is malformed.`);
  }
  return { passwordHash, role, disabled: disabled === true };
}
