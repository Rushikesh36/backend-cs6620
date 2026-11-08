import { ParameterAlreadyExists, PutParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import { signToken, verifyToken } from "../common/jwt.js";
import { createJwtSecret, generateSecret, SecretError } from "../scripts/lib/jwt-secret.js";

const ssm = mockClient(SSMClient);
beforeEach(() => ssm.reset());
const client = () => new SSMClient({});
const NAME = "/security-hub/jwt-secret";

describe("generateSecret", () => {
  it("is long enough for the signer and different every time", () => {
    const a = generateSecret();
    expect(a.length).toBeGreaterThanOrEqual(64);
    expect(generateSecret()).not.toBe(a);
  });

  it("works as a signing key", () => {
    const secret = generateSecret();
    const { token } = signToken({ username: "rushikesh", role: "user" }, secret, 3600);
    expect(verifyToken(token, secret).sub).toBe("rushikesh");
  });
});

describe("createJwtSecret", () => {
  it("stores a SecureString without overwriting", async () => {
    ssm.on(PutParameterCommand).resolves({});
    expect(await createJwtSecret(client(), NAME, false, "s".repeat(40))).toBe("created");
    const input = ssm.commandCalls(PutParameterCommand)[0]?.args[0].input;
    expect(input).toMatchObject({ Name: NAME, Type: "SecureString", Overwrite: false });
    expect(input?.Value).toBe("s".repeat(40));
  });

  it("with --rotate it overwrites and says rotated", async () => {
    ssm.on(PutParameterCommand).resolves({});
    expect(await createJwtSecret(client(), NAME, true)).toBe("rotated");
    expect(ssm.commandCalls(PutParameterCommand)[0]?.args[0].input.Overwrite).toBe(true);
  });

  it("refuses an existing secret with a helpful message, and never echoes the secret", async () => {
    ssm
      .on(PutParameterCommand)
      .rejects(new ParameterAlreadyExists({ message: "exists", $metadata: {} }));
    const err = await createJwtSecret(client(), NAME, false, "topsecret".repeat(5)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SecretError);
    expect((err as Error).message).toContain("--rotate");
    expect((err as Error).message).not.toContain("topsecret");
  });

  it("rejects a name without a leading slash before calling AWS", async () => {
    await expect(createJwtSecret(client(), "jwt-secret", false)).rejects.toBeInstanceOf(
      SecretError,
    );
    expect(ssm.commandCalls(PutParameterCommand)).toHaveLength(0);
  });

  it("passes other AWS errors through", async () => {
    ssm.on(PutParameterCommand).rejects(new Error("AccessDenied"));
    await expect(createJwtSecret(client(), NAME, false)).rejects.toThrow("AccessDenied");
  });
});
