import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BCRYPT_COST,
  checkNewPassword,
  hashPassword,
  verifyPassword,
} from "../common/passwords.js";
import { addUser, parseRole, prepareUser, UserError } from "../scripts/lib/users.js";

const ddb = mockClient(DynamoDBDocumentClient);
beforeEach(() => ddb.reset());
const client = () => ddb as unknown as DynamoDBDocumentClient;
const conditionFailed = () => new ConditionalCheckFailedException({ message: "no", $metadata: {} });
const PASSWORD = "correct horse battery";

describe("passwords", () => {
  it("hashes with bcrypt at the shared cost, and verifies", async () => {
    const hash = await hashPassword(PASSWORD);
    expect(
      hash.startsWith(`$2b$${String(BCRYPT_COST)}$`) ||
        hash.startsWith(`$2a$${String(BCRYPT_COST)}$`),
    ).toBe(true);
    expect(hash).not.toContain(PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
    expect(await verifyPassword("wrong password!!", hash)).toBe(false);
  });

  it("uses a different salt every time", async () => {
    expect(await hashPassword(PASSWORD)).not.toBe(await hashPassword(PASSWORD));
  });

  it("enforces length rules for new passwords", () => {
    expect(checkNewPassword("short")).toMatch(/at least 12/);
    expect(checkNewPassword("x".repeat(12))).toBeNull();
    expect(checkNewPassword("x".repeat(72))).toBeNull();
    expect(checkNewPassword("x".repeat(73))).toMatch(/at most 72/);
    // 40 characters but 80 bytes: bcrypt would silently cut it, so it must be refused.
    expect(checkNewPassword("é".repeat(40))).toMatch(/at most 72/);
  });
});

describe("prepareUser", () => {
  it("returns a hash for valid input", async () => {
    const hash = await prepareUser("rushikesh", PASSWORD);
    expect(await verifyPassword(PASSWORD, hash)).toBe(true);
  });

  it.each(["ab", "Rushikesh", "1abc", "has space", "a".repeat(33), "", "bad/name"])(
    "rejects username %j",
    async (name) => {
      await expect(prepareUser(name, PASSWORD)).rejects.toThrow(/Username/);
    },
  );

  it("rejects a weak password", async () => {
    await expect(prepareUser("rushikesh", "short")).rejects.toThrow(/Password/);
  });
});

describe("parseRole", () => {
  it("accepts user and ci only", () => {
    expect(parseRole("user")).toBe("user");
    expect(parseRole("ci")).toBe("ci");
    expect(() => parseRole("admin")).toThrow(UserError);
    expect(() => parseRole("")).toThrow(UserError);
  });
});

describe("addUser", () => {
  const base = {
    username: "rushikesh",
    role: "user",
    passwordHash: "$2a$10$hash",
    update: false,
  } as const;

  it("creates a user only if the name is free, and stores no plain password", async () => {
    ddb.on(PutCommand).resolves({});
    expect(await addUser(client(), "users", { ...base, role: "ci" })).toBe("created");
    const input = ddb.commandCalls(PutCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("attribute_not_exists(username)");
    expect(input?.Item).toMatchObject({
      username: "rushikesh",
      role: "ci",
      disabled: false,
      passwordHash: "$2a$10$hash",
    });
    expect(JSON.stringify(input)).not.toContain(PASSWORD);
  });

  it("refuses to overwrite an existing user without --update", async () => {
    ddb.on(PutCommand).rejects(conditionFailed());
    await expect(addUser(client(), "users", base)).rejects.toThrow(/already exists.*--update/);
  });

  it("updates password and role of an existing user", async () => {
    ddb.on(UpdateCommand).resolves({});
    expect(await addUser(client(), "users", { ...base, update: true })).toBe("updated");
    const input = ddb.commandCalls(UpdateCommand)[0]?.args[0].input;
    expect(input?.ConditionExpression).toBe("attribute_exists(username)");
    expect(input?.UpdateExpression).not.toContain("disabled");
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });

  it("--update on a missing user is an error, not a silent create", async () => {
    ddb.on(UpdateCommand).rejects(conditionFailed());
    await expect(addUser(client(), "users", { ...base, update: true })).rejects.toThrow(
      /does not exist/,
    );
  });

  it("passes other AWS errors through", async () => {
    ddb.on(PutCommand).rejects(new Error("ExpiredToken"));
    await expect(addUser(client(), "users", base)).rejects.toThrow("ExpiredToken");
  });
});
