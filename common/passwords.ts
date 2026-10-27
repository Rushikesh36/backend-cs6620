import bcrypt from "bcryptjs";

/**
 * Cost 10 keeps login fast on a small Lambda. bcryptjs is pure JavaScript, so there is
 * no native binary to package. Login and add_user must share this value.
 */
export const BCRYPT_COST = 10;

export const MIN_PASSWORD_LENGTH = 12;
// bcrypt only reads the first 72 bytes, so longer passwords would be silently cut.
export const MAX_PASSWORD_BYTES = 72;

/** Rules for choosing a NEW password. Returns a plain-words problem, or null if fine. */
export function checkNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`;
  }
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    return `Password must be at most ${String(MAX_PASSWORD_BYTES)} bytes.`;
  }
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
