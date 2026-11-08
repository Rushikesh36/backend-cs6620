// Creates the JWT signing secret in SSM Parameter Store. Run once per Learner Lab account,
// before the first deploy: login and the authorizer both read it.
//   npm run create-jwt-secret
// Uses your current AWS credentials (the Learner Lab keys in your shell). The secret is random,
// goes straight to SSM and is never printed, so it never lands in Terraform state or your history.
import { SSMClient } from "@aws-sdk/client-ssm";
import { parseArgs } from "node:util";
import { createJwtSecret, DEFAULT_SECRET_NAME, SecretError } from "./lib/jwt-secret.js";

const USAGE = `Usage: npm run create-jwt-secret -- [--name <ssm parameter>] [--rotate]

  --name    SSM parameter name (default: $JWT_SECRET_SSM_NAME or ${DEFAULT_SECRET_NAME}).
            It must match jwt_secret_ssm_name in your tfvars.
  --rotate  replace an existing secret. Every logged-in user is signed out.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      name: { type: "string" },
      rotate: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  const name = values.name ?? process.env.JWT_SECRET_SSM_NAME ?? DEFAULT_SECRET_NAME;
  const result = await createJwtSecret(new SSMClient({}), name, values.rotate);
  console.log(`JWT secret ${result} at ${name}.`);
}

main().catch((err: unknown) => {
  if (err instanceof SecretError) {
    console.error(`Error: ${err.message}`);
  } else {
    // Show the error type and message only; never dump objects that could hold credentials.
    console.error(`Unexpected error: ${err instanceof Error ? err.message : "unknown"}`);
  }
  process.exit(1);
});
