import { scrypt, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
export const token = () => randomBytes(32).toString("base64url");
export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
export function validatePassword(password, minimumLength = 12) {
  if (
    typeof password !== "string" ||
    password.length < minimumLength ||
    password.length > 200
  )
    throw Error(`Пароль должен содержать от ${minimumLength} до 200 символов`);
}
export async function hashPassword(
  password,
  { allowShortForTesting = false } = {},
) {
  validatePassword(password, allowShortForTesting ? 1 : 12);
  const salt = randomBytes(16).toString("hex");
  const key = await derive(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${key.toString("hex")}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || password.length > 200 || !encoded)
    return false;
  const [salt, hex] = encoded.split(":");
  const expected = Buffer.from(hex, "hex");
  const actual = await derive(password, salt, 64, {
    N: 32768,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
