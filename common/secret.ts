import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { requireEnv } from "./dynamo.js";

const CACHE_MS = 5 * 60 * 1000;
let ssm: SSMClient | undefined;
let cached: { value: string; expiresAt: number } | undefined;

/**
 * The JWT signing secret from SSM Parameter Store. Cached for 5 minutes per Lambda container
 * so we do not call SSM on every request, but a rotated secret is still picked up.
 */
export async function getJwtSecret(now: number = Date.now()): Promise<string> {
  if (cached && cached.expiresAt > now) return cached.value;
  ssm ??= new SSMClient({});
  const out = await ssm.send(
    new GetParameterCommand({ Name: requireEnv("JWT_SECRET_SSM_NAME"), WithDecryption: true }),
  );
  const value = out.Parameter?.Value;
  if (!value) throw new Error("JWT secret is not set in SSM.");
  cached = { value, expiresAt: now + CACHE_MS };
  return value;
}

/** For tests. */
export function resetSecretCache(): void {
  cached = undefined;
  ssm = undefined;
}
