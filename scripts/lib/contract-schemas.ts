import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv, { type AnySchema, type ErrorObject } from "ajv";
import addFormats from "ajv-formats";

/** The JSON Schemas of the API contract (contract.md), one file per response. */
export const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "tests",
  "contract",
  "schemas",
);

export function schemaNames(): string[] {
  return readdirSync(SCHEMA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

// ajv-formats is a CommonJS module, so its function sits on `.default` under some loaders.
const applyFormats =
  (addFormats as unknown as { default?: typeof addFormats }).default ?? addFormats;

const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
applyFormats(ajv);
for (const name of schemaNames()) {
  const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, `${name}.json`), "utf8")) as AnySchema;
  ajv.addSchema(schema, `${name}.json`);
}

const describeError = (e: ErrorObject): string =>
  `${e.instancePath === "" ? "(body)" : e.instancePath} ${e.message ?? "is invalid"}`;

/** [] when `data` fits the schema, otherwise one plain sentence per problem. */
export function validateAgainst(schemaName: string, data: unknown): string[] {
  const validate = ajv.getSchema(`${schemaName}.json`);
  if (!validate) throw new Error(`No schema named ${schemaName}`);
  return validate(data) ? [] : (validate.errors ?? []).map(describeError);
}
