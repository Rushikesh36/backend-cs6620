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

function write(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({
    level,
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
