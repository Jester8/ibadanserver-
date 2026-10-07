import type { IncomingMessage, ServerResponse } from "node:http";
import { cleanChat } from "../../src/lib/moderation";
import { addTransfer, claimTransfer, getPlayer, getPlayerByUsername, getTransfer, pendingFor, sentSince, transfersOf } from "../db/repo";
import { isOnline, sendToPid } from "../presence";
import { verifyToken } from "./auth";

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const USERNAME = /^[a-z0-9_]{3,16}$/i;
/** Money in the game is kept on each player's device, so transfers are capped to keep a cheat from draining the economy. */
const MAX_ONE = 1_000_000;
const MAX_DAY = 3_000_000;
const lastSend = new Map<string, number>();

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 4 * 1024) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** The bank: look up an account by username, send money, and receive it (once, even if the page reloads). */
export async function handleBank(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/bank")) return false;
  const send = (status: number, json: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  const me = await verifyToken(req.headers.authorization?.replace(/^Bearer /i, ""));
  if (!me) return send(401, { error: "unauthorised" }), true;
  const body = req.method === "POST" ? await readJson(req) : null;
  if (req.method === "POST" && !body) return send(400, { error: "bad json" }), true;

  // who owns this account number (username)?
  if (req.method === "GET" && path === "/api/bank/lookup") {
    const u = clean(url.searchParams.get("u"), 20).replace(/^@/, "");
    if (!USERNAME.test(u)) return send(200, { found: false }), true;
    const p = await getPlayerByUsername(u);
    if (!p || p.pid === me) return send(200, { found: false, self: p?.pid === me }), true;
    return send(200, { found: true, name: p.name, username: p.username }), true;
  }

  if (req.method === "POST" && path === "/api/bank/send") {
    const u = clean(body?.to, 20).replace(/^@/, "");
    const amount = Math.floor(Number(body?.amount));
    const note = cleanChat(clean(body?.note, 60));
    if (!USERNAME.test(u)) return send(400, { error: "Enter the account number (a username)." }), true;
    if (!Number.isFinite(amount) || amount < 100) return send(400, { error: "The smallest transfer is ₦100." }), true;
    if (amount > MAX_ONE) return send(400, { error: "The most you can send at once is ₦1,000,000." }), true;
    const to = await getPlayerByUsername(u);
    if (!to) return send(404, { error: "No account with that number." }), true;
    if (to.pid === me) return send(400, { error: "You cannot send money to yourself." }), true;
    const now = Date.now();
    if (now - (lastSend.get(me) ?? 0) < 2000) return send(429, { error: "Slow down a little." }), true;
    if ((await sentSince(me, now - 24 * 3600_000)) + amount > MAX_DAY) return send(400, { error: "That is over your daily limit of ₦3,000,000." }), true;
    lastSend.set(me, now);
    const id = await addTransfer(me, to.pid, amount, note);
    const from = await getPlayer(me);
    // delivered at once if they are online, otherwise the next time they log in
    sendToPid(to.pid, { t: "credit", id, from: from?.name ?? "Someone", username: from?.username ?? "", amount, note });
    return send(200, { ok: true, id, name: to.name, username: to.username, delivered: isOnline(to.pid) }), true;
  }

  // money waiting for me (sent while I was away)
  if (req.method === "GET" && path === "/api/bank/pending") {
    const rows = await pendingFor(me);
    const out = [];
    for (const r of rows) {
      const f = await getPlayer(r.from_pid);
      out.push({ id: r.id, from: f?.name ?? "Someone", username: f?.username ?? "", amount: r.amount, note: r.note, at: r.at });
    }
    return send(200, { credits: out }), true;
  }

  // take the money: true only once per transfer
  if (req.method === "POST" && path === "/api/bank/claim") {
    const id = Math.floor(Number(body?.id));
    const t = Number.isFinite(id) ? await getTransfer(id) : undefined;
    if (!t || t.to_pid !== me) return send(404, { error: "not found" }), true;
    const first = await claimTransfer(id, me);
    return send(200, { ok: first, amount: first ? t.amount : 0 }), true;
  }

  if (req.method === "GET" && path === "/api/bank/history") {
    const rows = await transfersOf(me);
    const out = [];
    for (const r of rows) {
      const other = await getPlayer(r.from_pid === me ? r.to_pid : r.from_pid);
      out.push({ id: r.id, dir: r.from_pid === me ? "out" : "in", name: other?.name ?? "Someone", username: other?.username ?? "", amount: r.amount, note: r.note, at: r.at });
    }
    return send(200, { items: out }), true;
  }
  return send(404, { error: "not found" }), true;
}
