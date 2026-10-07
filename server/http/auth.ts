import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { hasEmail } from "../db/repo";

const mac = (s: string) => createHmac("sha256", config.authSecret).update(s).digest("base64url");
const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export const TOKEN_DAYS = 30;

/** Session token: `v2.<pid>.<expiry>.<signature>`. It expires after 30 days. */
export function issueToken(pid: string, days = TOKEN_DAYS) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400;
  return `v2.${pid}.${exp}.${mac(`${pid}.${exp}`)}`;
}

/** Returns the player id if the token is genuine and unexpired. */
export async function verifyToken(token: string | undefined | null): Promise<string | null> {
  if (!token) return null;
  if (token.startsWith("v2.")) {
    const [, pid, exp, sig] = token.split(".");
    if (!pid || !exp || !sig) return null;
    if (Number(exp) < Date.now() / 1000) return null;
    return same(sig, mac(`${pid}.${exp}`)) ? pid : null;
  }
  // old guest tokens (`pid.signature`) keep working, but only for players who never attached an email
  const i = token.lastIndexOf(".");
  if (i < 1) return null;
  const pid = token.slice(0, i);
  if (!same(token.slice(i + 1), mac(pid))) return null;
  return (await hasEmail(pid)) ? null : pid;
}

/** A short-lived signature for a TURN username (coturn "use-auth-secret"). */
export const turnCredential = (username: string) => createHmac("sha1", config.turnSecret).update(username).digest("base64");
