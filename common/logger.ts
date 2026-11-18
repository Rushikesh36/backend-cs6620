/** Structured JSON logs. Anything that looks like a secret is replaced before it is written. */

const SECRET_KEY = /pass(word)?|token|secret|authorization|cookie|hash|signature|credential/i;
const MAX_DEPTH = 5;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[too deep]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        SECRET_KEY.test(key) ? "[redacted]" : redact(v, depth + 1),
      ]),
    );
  }
  return value;
}

type Level = "info" | "warn" | "error";

// Extra fields on every line from a process that is not a Lambda, set once at start-up. A scanner
// container sets awsService, container, scanner and scanType so its lines say what wrote them.
let processContext: Record<string, unknown> = {};

export function setLogContext(fields: Record<string, unknown>): void {
  processContext = fields;
}

/** Which AWS service wrote the line: a Lambda names itself, a container uses setLogContext. */
function source(): Record<string, unknown> {
  const functionName = process.env.AWS_LAMBDA_FUNCTION_NAME;
  const fromLambda = functionName ? { awsService: "Lambda", function: functionName } : {};
  return { ...fromLambda, ...processContext };
}

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  if (process.env.LOG_LEVEL === "silent") return; // used by unit tests to keep output readable
  const line = JSON.stringify({
    level,
    ...source(),
    message,
    time: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  });
  process.stdout.write(`${line}\n`);
}

export const logger = {
  info: (message: string, fields?: Record<string, unknown>): void => {
    write("info", message, fields);
  },
  warn: (message: string, fields?: Record<string, unknown>): void => {
    write("warn", message, fields);
  },
  error: (message: string, fields?: Record<string, unknown>): void => {
    write("error", message, fields);
  },
};
