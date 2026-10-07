import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "../config";
import { bumpAttempts, createVerifiedPlayer, deleteCode, getCode, getPlayer, getPlayerByEmail, getPlayerByUsername, getState, putState, saveCode, touchPlayer } from "../db/repo";
import { issueToken, turnCredential, verifyToken } from "./auth";
import { createHmac, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { sendCode } from "../mail";
import { handleSocial } from "./social";
import { handleTracks } from "./tracks";
import { handleBank } from "./bank";
import { handleIntro } from "./intro";
import { checkPassword, hashPassword, passwordOk, PASSWORD_HELP } from "./password";
import { AccessToken } from "livekit-server-sdk";
import { clients } from "../presence";

type Handler = (ctx: { req: IncomingMessage; body: unknown; pid: string | null; url: URL }) => { status?: number; json: unknown } | Promise<{ status?: number; json: unknown }>;

const ipCodes = new Map<string, { n: number; until: number }>();
const failedLogins = new Map<string, { n: number; until: number }>();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const USERNAME = /^[a-z0-9_]{3,16}$/i;
const USERNAME_HELP = "Choose a username: 3 to 16 letters, numbers or underscores.";

/** Log in accepts an email or a username. Returns the account email, or null when there is no such account. */
async function emailFor(ident: string): Promise<string | null> {
  if (ident.includes("@")) return ident;
  return (await getPlayerByUsername(ident))?.email ?? null;
}
const hashCode = (email: string, code: string) => createHmac("sha256", config.authSecret).update(`${email}:${code}`).digest("hex");
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hits = new Map<string, { n: number; reset: number }>();
const limited = (ip: string) => {
  const now = Date.now();
  const h = hits.get(ip);
  if (!h || now > h.reset) {
    hits.set(ip, { n: 1, reset: now + 60_000 });
    return false;
  }
  return ++h.n > 120;
};

const clamp = (n: unknown, lo: number, hi: number, d = lo) => (typeof n === "number" && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d);
const strs = (a: unknown, max: number) => (Array.isArray(a) ? a.filter((x): x is string => typeof x === "string" && /^[\w-]{1,24}$/.test(x)).slice(0, max) : []);

/** Only known fields, within sane bounds: the save is cloud storage, not a trusted economy (yet). */
export function sanitizeState(s: unknown) {
  const o = (s && typeof s === "object" ? s : {}) as Record<string, unknown>;
  const needs = (o.needs ?? {}) as Record<string, unknown>;
  const romance: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((o.romance ?? {}) as Record<string, Record<string, unknown>>).slice(0, 20)) {
    if (!/^[\w-]{1,24}$/.test(k) || !v) continue;
    romance[k] = { affection: clamp(v.affection, 0, 100), status: ["stranger", "friend", "dating", "girlfriend"].includes(String(v.status)) ? v.status : "stranger", dates: clamp(v.dates, 0, 999), lastTalk: 0, coolUntil: 0 };
  }
  return {
    money: clamp(o.money, 0, 1e9),
    rep: clamp(o.rep, 0, 1e6),
    needs: { hunger: clamp(needs.hunger, 0, 100), energy: clamp(needs.energy, 0, 100), fun: clamp(needs.fun, 0, 100), social: clamp(needs.social, 0, 100) },
    questsDone: strs(o.questsDone, 64),
    cars: strs(o.cars, 8),
    activeCar: typeof o.activeCar === "string" && /^[\w-]{1,24}$/.test(o.activeCar) ? o.activeCar : null,
    romance,
    stats: o.stats && typeof o.stats === "object" ? o.stats : {},
  };
}

const routes: Record<string, Handler> = {
  "GET /health": () => ({ json: { ok: true, uptime: Math.round(process.uptime()) } }),

  /** Guests get an id + token. Send the old id to keep an identity that already exists. */
  "POST /api/auth/guest": async ({ body }) => {
    const b = (body ?? {}) as { pid?: unknown; name?: unknown };
    const asked = typeof b.pid === "string" && /^[a-zA-Z0-9]{8,40}$/.test(b.pid) ? b.pid : null;
    // an id that already exists belongs to somebody: never hand out a token for it
    if (asked && (await getPlayer(asked))) return { status: 409, json: { error: "That player already exists. Log in with your email." } };
    const pid = asked ?? randomUUID().replace(/-/g, "").slice(0, 20);
    const name = String(b.name ?? "Guest").replace(/[\u0000-\u001f<>]/g, "").slice(0, 16) || "Guest";
    await touchPlayer(pid, name);
    return { json: { pid, token: issueToken(pid) } };
  },

  /**
   * Step 1 of sign up or log in: email a six-digit code.
   * Log in never reveals whether an address has an account.
   */
  "POST /api/auth/request-code": async ({ body, req }) => {
    const b = (body ?? {}) as { email?: unknown; purpose?: unknown; username?: unknown };
    const ident = String(b.email ?? "").trim().toLowerCase();
    const signup = b.purpose === "signup";
    if (!signup && ident && !ident.includes("@")) {
      // logging in with a username
      const found = await emailFor(ident);
      if (!found) return config.emailCodes ? { json: { ok: true, cooldown: 30 } } : { status: 404, json: { error: "No account with that username yet. Sign up first." } };
    }
    const email = (signup ? ident : await emailFor(ident)) ?? ident;
    if (!EMAIL.test(email) || email.length > 80) return { status: 400, json: { error: "Enter a valid email address or username." } };
    const exists = await getPlayerByEmail(email);
    if (signup && exists) return { status: 409, json: { error: "That email already has an account. Log in instead." } };
    if (signup) {
      const u = String(b.username ?? "").trim();
      if (!USERNAME.test(u)) return { status: 400, json: { error: USERNAME_HELP } };
      if (await getPlayerByUsername(u)) return { status: 409, json: { error: "That username is taken. Try another." } };
    }
    if (!config.emailCodes) {
      if (!signup && !exists) return { status: 404, json: { error: "No account with that email yet. Sign up first." } };
      return { json: { ok: true, skip: true, cooldown: 0 } };
    }
    const ip = String(req.socket.remoteAddress);
    const ipHit = ipCodes.get(ip);
    const nowMs = Date.now();
    if (ipHit && nowMs < ipHit.until && ipHit.n >= 20) return { status: 429, json: { error: "Too many codes requested. Try again later." } };
    ipCodes.set(ip, { n: ipHit && nowMs < ipHit.until ? ipHit.n + 1 : 1, until: ipHit && nowMs < ipHit.until ? ipHit.until : nowMs + 3600_000 });
    const prev = await getCode(email);
    if (prev && nowMs - prev.sent_at < 30_000) return { status: 429, json: { error: "Please wait 30 seconds before asking for another code." } };
    if (prev && nowMs - prev.window_start < 3600_000 && prev.sends_window >= 5) return { status: 429, json: { error: "Too many codes for this email. Try again in an hour." } };
    if (!signup && !exists) return { json: { ok: true, cooldown: 30 } }; // look the same as a real send
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    await saveCode(email, hashCode(email, code), nowMs + 10 * 60_000, nowMs);
    let delivered = false;
    try {
      delivered = await sendCode(email, code);
    } catch (e) {
      console.error("[mail]", e);
      return { status: 502, json: { error: "We could not send the email. Please try again." } };
    }
    // only in development, with no mail server set up, the code is handed back so you can test
    return { json: { ok: true, cooldown: 30, ...(!delivered && !config.production ? { devCode: code } : {}) } };
  },

  /** Step 2: check the code. An existing email logs in; a new one creates the account (name + avatar). */
  "POST /api/auth/verify": async ({ body }) => {
    const b = (body ?? {}) as { email?: unknown; code?: unknown; name?: unknown; look?: unknown; username?: unknown; password?: unknown };
    const ident = String(b.email ?? "").trim().toLowerCase();
    const email = (await emailFor(ident)) ?? ident;
    const code = String(b.code ?? "").trim();
    if (!EMAIL.test(email) || email.length > 80) return { status: 400, json: { error: "Enter a valid email address." } };
    if (config.emailCodes) {
      const row = await getCode(email);
      if (!row || Date.now() > row.expires_at) return { status: 400, json: { error: "That code has expired. Ask for a new one." } };
      if (row.attempts >= 5) return { status: 429, json: { error: "Too many wrong tries. Ask for a new code." } };
      if (!/^\d{6}$/.test(code) || !same(row.code_hash, hashCode(email, code))) {
        await bumpAttempts(email);
        return { status: 401, json: { error: "That code is not right." } };
      }
      await deleteCode(email);
    }
    const existing = await getPlayerByEmail(email);
    if (existing) {
      // with no emailed code, the password is what proves it is you
      if (!config.emailCodes) {
        const f = failedLogins.get(email);
        if (f && Date.now() < f.until && f.n >= 10) return { status: 429, json: { error: "Too many wrong passwords. Try again in 15 minutes." } };
        if (!existing.password_hash) return { status: 401, json: { error: "This account has no password. Please sign up again." } };
        if (!(await checkPassword(String(b.password ?? ""), existing.password_hash))) {
          const live = f && Date.now() < f.until ? f : { n: 0, until: Date.now() + 15 * 60_000 };
          failedLogins.set(email, { n: live.n + 1, until: live.until });
          return { status: 401, json: { error: "That password is not right." } };
        }
        failedLogins.delete(email);
      }
      return { json: { isNew: false, pid: existing.pid, name: existing.name, username: existing.username, email: existing.email, look: existing.profile_json ? JSON.parse(existing.profile_json) : null, token: issueToken(existing.pid) } };
    }
    const name = String(b.name ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 16);
    if (name.length < 2) return { status: 400, json: { error: "Choose a name (2 to 16 characters)." } };
    const username = String(b.username ?? "").trim();
    if (!USERNAME.test(username)) return { status: 400, json: { error: USERNAME_HELP } };
    if (await getPlayerByUsername(username)) return { status: 409, json: { error: "That username is taken. Try another." } };
    if (!passwordOk(b.password)) return { status: 400, json: { error: PASSWORD_HELP } };
    const pid = randomUUID().replace(/-/g, "").slice(0, 20);
    await createVerifiedPlayer(pid, name, email, b.look && typeof b.look === "object" ? b.look : null, username, await hashPassword(b.password));
    return { json: { isNew: true, pid, name, username, email, look: b.look ?? null, token: issueToken(pid) } };
  },

  /** Voice relay settings: STUN, plus TURN with short-lived credentials when configured. */
  "GET /api/rtc": ({ pid }) => {
    if (!pid) return { status: 401, json: { error: "unauthorised" } };
    const iceServers: { urls: string | string[]; username?: string; credential?: string }[] = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
    if (config.turnUrls.length && config.turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + 6 * 3600}:${pid}`;
      iceServers.push({ urls: config.turnUrls, username, credential: turnCredential(username) });
    }
    return { json: { iceServers } };
  },

  /** A short-lived LiveKit ticket for one voice room. 404 when LiveKit is not configured (the game then uses peer-to-peer). */
  "POST /api/voice/token": async ({ pid, body }) => {
    if (!pid) return { status: 401, json: { error: "unauthorised" } };
    if (!config.livekitUrl || !config.livekitKey || !config.livekitSecret) return { status: 404, json: { error: "livekit off" } };
    const b = (body ?? {}) as { room?: unknown; id?: unknown };
    const room = typeof b.room === "string" ? b.room.slice(0, 80) : "";
    const id = typeof b.id === "string" ? b.id : "";
    // the identity must be this player's own live connection, so nobody can speak as somebody else
    const me = clients.get(id);
    if (!room || !me || me.info.pid !== pid) return { status: 403, json: { error: "not connected" } };
    const at = new AccessToken(config.livekitKey, config.livekitSecret, { identity: id, name: me.info.name, ttl: "2h" });
    at.addGrant({ room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: false });
    return { json: { url: config.livekitUrl, token: await at.toJwt() } };
  },

  "GET /api/state": async ({ pid }) => {
    if (!pid) return { status: 401, json: { error: "unauthorised" } };
    return { json: (await getState(pid)) ?? { state: null, updatedAt: 0 } };
  },

  "PUT /api/state": async ({ pid, body }) => {
    if (!pid) return { status: 401, json: { error: "unauthorised" } };
    const b = (body ?? {}) as { name?: unknown; state?: unknown; look?: unknown };
    await putState(pid, String(b.name ?? "Guest").slice(0, 16), sanitizeState(b.state), b.look && typeof b.look === "object" ? b.look : undefined);
    return { json: { ok: true } };
  },
};

function cors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (origin && (config.origins.includes("*") || config.origins.includes(origin))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, x-admin-token, range");
    res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  }
}

export async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  cors(req, res);
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  if (limited(req.socket.remoteAddress ?? "?")) return void res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: "slow down" }));
  if (handleIntro(req, res, url)) return;
  try {
    if (await handleTracks(req, res, url)) return;
    if (await handleSocial(req, res, url)) return;
    if (await handleBank(req, res, url)) return;
  } catch (e) {
    console.error("[tracks]", e);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "server error" }));
    return;
  }
  const handler = routes[`${req.method} ${url.pathname}`];
  const send = (status: number, json: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  if (!handler) return send(404, { error: "not found" });
  let body: unknown = undefined;
  if (req.method === "POST" || req.method === "PUT") {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024) return send(413, { error: "too large" });
      chunks.push(c as Buffer);
    }
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    } catch {
      return send(400, { error: "bad json" });
    }
  }
  const auth = req.headers.authorization?.replace(/^Bearer /i, "");
  try {
    const out = await handler({ req, body, pid: await verifyToken(auth), url });
    send(out.status ?? 200, out.json);
  } catch (e) {
    console.error("[http]", e);
    send(500, { error: "server error" });
  }
}
