import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const run = (pw: string, salt: Buffer) => new Promise<Buffer>((res, rej) => scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));

/** `s1$<salt>$<hash>`: scrypt, a fresh random salt per password. */
export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  return `s1$${salt.toString("hex")}$${(await run(pw, salt)).toString("hex")}`;
}

export async function checkPassword(pw: string, stored: string | null | undefined) {
  const [v, salt, hash] = (stored ?? "").split("$");
  if (v !== "s1" || !salt || !hash) return false;
  const want = Buffer.from(hash, "hex");
  const got = await run(pw, Buffer.from(salt, "hex"));
  return want.length === got.length && timingSafeEqual(want, got);
}

export const PASSWORD_HELP = "Choose a password of 6 to 72 characters.";
export const passwordOk = (pw: unknown): pw is string => typeof pw === "string" && pw.length >= 6 && pw.length <= 72;
