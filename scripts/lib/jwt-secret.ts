import { randomBytes } from "node:crypto";
import { ParameterAlreadyExists, PutParameterCommand, type SSMClient } from "@aws-sdk/client-ssm";

/** Random bytes in the secret. 48 bytes is 64 base64 characters, well over the 32 the signer needs. */
const SECRET_BYTES = 48;

export const DEFAULT_SECRET_NAME = "/security-hub/jwt-secret";

/** A problem the admin can fix. The message is shown as-is. */
export class SecretError extends Error {}

export type SecretResult = "created" | "rotated";

/** A fresh random secret. Never printed and never written to disk. */
export const generateSecret = (): string => randomBytes(SECRET_BYTES).toString("base64");

/**
 * Stores a new JWT signing secret in SSM Parameter Store as a SecureString.
 * It refuses to replace an existing secret unless `rotate` is set: replacing it signs every
 * logged-in user out, because their tokens no longer verify.
 */
export async function createJwtSecret(
  ssm: SSMClient,
  name: string,
  rotate: boolean,
  secret: string = generateSecret(),
): Promise<SecretResult> {
  if (!name.startsWith("/")) throw new SecretError("The parameter name must start with a slash.");
  try {
    await ssm.send(
      new PutParameterCommand({
        Name: name,
        Value: secret,
        Type: "SecureString",
        Overwrite: rotate,
        Description:
          "JWT signing secret for Unified Security Hub. Created by a script, not Terraform.",
      }),
    );
  } catch (err) {
    if (err instanceof ParameterAlreadyExists) {
      throw new SecretError(
        `${name} already exists. Use --rotate to replace it (this signs every user out).`,
      );
    }
    throw err;
  }
  return rotate ? "rotated" : "created";
}
