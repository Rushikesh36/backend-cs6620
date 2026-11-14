// Checks one API response body (read from stdin) against a contract schema.
//
//   curl -s "$API/targets" -H "Authorization: Bearer $TOKEN" | npx tsx scripts/check_response.ts targets-response
//
// Prints OK, or one line per problem, and exits 1 on a mismatch. Used by scripts/smoke.sh.
import { schemaNames, validateAgainst } from "./lib/contract-schemas.js";

const name = process.argv[2];
if (name === undefined || !schemaNames().includes(name)) {
  console.error(`Usage: check_response.ts <schema>   (one of: ${schemaNames().join(", ")})`);
  process.exit(2);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const raw = Buffer.concat(chunks).toString("utf8");

let body: unknown;
try {
  body = JSON.parse(raw);
} catch {
  console.error(`Not JSON: ${raw.slice(0, 200)}`);
  process.exit(1);
}
const problems = validateAgainst(name, body);
if (problems.length > 0) {
  console.error(`${name}: ${problems.join("; ")}`);
  process.exit(1);
}
console.log(`OK ${name}`);
