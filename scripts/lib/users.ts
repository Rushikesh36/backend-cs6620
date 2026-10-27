import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { PutCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { checkNewPassword, hashPassword } from "../../common/passwords.js";

/** A problem the admin can fix. The message is shown as-is. */
export class UserError extends Error {}

export type UserRole = "user" | "ci";

const USERNAME = /^[a-z][a-z0-9._-]{2,31}$/;

export function parseRole(value: string): UserRole {
  if (value !== "user" && value !== "ci") throw new UserError('Role must be "user" or "ci".');
  return value;
}

/** Checks everything that can be checked without AWS. Returns the bcrypt hash. */
export async function prepareUser(username: string, password: string): Promise<string> {
  if (!USERNAME.test(username)) {
    throw new UserError(
      "Username must be 3 to 32 characters: lowercase letters, digits, dot, underscore, hyphen, starting with a letter.",
    );
  }
  const problem = checkNewPassword(password);
  if (problem) throw new UserError(problem);
  return hashPassword(password);
}

/**
 * Creates a user, or with `update` changes the password and role of an existing one.
 * Refuses to overwrite unless `update` is set. Does not change the `disabled` flag.
 */
export async function addUser(
  client: DynamoDBDocumentClient,
  table: string,
  input: { username: string; role: UserRole; passwordHash: string; update: boolean },
): Promise<"created" | "updated"> {
  const now = new Date().toISOString();
  try {
    if (input.update) {
      await client.send(
        new UpdateCommand({
          TableName: table,
          Key: { username: input.username },
          UpdateExpression: "SET passwordHash = :h, #role = :r, updatedAt = :t",
          ConditionExpression: "attribute_exists(username)",
          ExpressionAttributeNames: { "#role": "role" },
          ExpressionAttributeValues: { ":h": input.passwordHash, ":r": input.role, ":t": now },
        }),
      );
      return "updated";
    }
    await client.send(
      new PutCommand({
        TableName: table,
        Item: {
          username: input.username,
          passwordHash: input.passwordHash,
          role: input.role,
          disabled: false,
          createdAt: now,
        },
        ConditionExpression: "attribute_not_exists(username)",
      }),
    );
    return "created";
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      throw new UserError(
        input.update
          ? `User "${input.username}" does not exist. Run again without --update to create it.`
          : `User "${input.username}" already exists. Use --update to change the password or role.`,
      );
    }
    throw err;
  }
}
