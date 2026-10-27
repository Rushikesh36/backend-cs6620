// Creates or updates a login user. Run from the repo root:
//   npm run add-user -- --username rushikesh --role user
// Uses your current AWS credentials (the Learner Lab keys in your shell).
// The password is asked for with a hidden prompt, never taken from the command line.
import { parseArgs } from "node:util";
import { getDocClient } from "../common/dynamo.js";
import { askHidden, readLineFromStdin } from "./lib/prompt.js";
import { addUser, parseRole, prepareUser, UserError } from "./lib/users.js";

const USAGE = `Usage: npm run add-user -- --username <name> [--role user|ci] [--update]
                          [--table <users table>] [--password-stdin] [--dry-run]

  --username        3 to 32 characters (lowercase letters, digits, . _ -)
  --role            user (default) or ci (for the GitHub Actions bot)
  --update          change the password/role of an existing user (without it, existing users are never overwritten)
  --table           users table name (default: $USERS_TABLE; find it with: terraform -chdir=terraform output table_names)
  --password-stdin  read the password from piped input instead of the hidden prompt
  --dry-run         check everything and hash the password, but write nothing`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      username: { type: "string" },
      role: { type: "string", default: "user" },
      update: { type: "boolean", default: false },
      table: { type: "string" },
      "password-stdin": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help || !values.username) {
    console.log(USAGE);
    process.exit(values.help ? 0 : 1);
  }

  const role = parseRole(values.role);
  const dryRun = values["dry-run"];
  const table = values.table ?? process.env.USERS_TABLE;
  if (!table && !dryRun) throw new UserError("Give --table or set USERS_TABLE.");

  let password: string;
  if (values["password-stdin"]) {
    password = await readLineFromStdin();
  } else {
    password = await askHidden("Password: ");
    // eslint-disable-next-line security/detect-possible-timing-attacks -- comparing two things the admin just typed locally
    if (password !== (await askHidden("Repeat password: "))) {
      throw new UserError("The two passwords do not match.");
    }
  }

  const passwordHash = await prepareUser(values.username, password);
  if (dryRun) {
    console.log(`Dry run OK: "${values.username}" (${role}) would be saved. Nothing was written.`);
    return;
  }
  const result = await addUser(getDocClient(), table ?? "", {
    username: values.username,
    role,
    passwordHash,
    update: values.update,
  });
  console.log(`User "${values.username}" ${result}.`);
}

main().catch((err: unknown) => {
  if (err instanceof UserError) {
    console.error(`Error: ${err.message}`);
  } else {
    // Show the error type and message only; never dump objects that could hold credentials.
    console.error(`Unexpected error: ${err instanceof Error ? err.message : "unknown"}`);
  }
  process.exit(1);
});
