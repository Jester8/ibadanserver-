import type { IncomingMessage, ServerResponse } from "node:http";
import { cleanChat } from "../../src/lib/moderation";
import { addBlock, addDm, acceptFriend, blockedEither, countLevel, searchPlayers, setFriendLevel, blocksOf, countFriends, dmThread, dmThreads, friendshipsOf, getDm, getFriendship, getPlayer, markRead, removeBlock, removeFriendship, requestFriend } from "../db/repo";
import { isOnline, sendToPid } from "../presence";
import { verifyToken } from "./auth";

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const PID = /^[a-zA-Z0-9]{8,40}$/;
const lastDm = new Map<string, number>();

/** Closeness between two friends, lowest to highest. Going up needs the other person to agree; coming down does not. */
export const LEVELS = ["friend", "bestie", "fwb", "babe", "wife"] as const;
const rank = (l: string) => LEVELS.indexOf(l as (typeof LEVELS)[number]);
const LABEL: Record<string, string> = { friend: "friend", bestie: "best friend", fwb: "friends with benefits", babe: "babe", wife: "wife" };
const PARTNER = ["babe", "wife"];
/** proposals waiting for an answer: "from|to" -> level and when */
const asks = new Map<string, { level: string; at: number }>();

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8 * 1024) return null;
    chunks.push(c as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return null;
  }
}

const look = async (pid: string) => {
  const p = await getPlayer(pid);
  return p ? { pid: p.pid, name: p.name, username: p.username, look: p.profile_json ? JSON.parse(p.profile_json) : null } : null;
};

export type DmOut = { id: number; from: string; to: string; text: string; at: number };

/** Used by both the REST route and the websocket. Only friends can message each other, and blocks are respected. */
export async function sendDm(from: string, to: string, rawText: unknown): Promise<{ ok: true; msg: DmOut } | { ok: false; error: string }> {
  const text = cleanChat(clean(rawText, 400));
  if (!text) return { ok: false, error: "Write something first." };
  if (!PID.test(to) || !(await getPlayer(to))) return { ok: false, error: "That player does not exist." };
  const now = Date.now();
  if (now - (lastDm.get(from) ?? 0) < 400) return { ok: false, error: "Slow down a little." };
  lastDm.set(from, now);
  if (await blockedEither(from, to)) return { ok: false, error: "You can't message this player." };
  const f = await getFriendship(from, to);
  if (f?.status !== "accepted") return { ok: false, error: "You can only message your friends." };
  const id = await addDm(from, to, text, now);
  const msg: DmOut = { id, from, to, text, at: now };
  const data = { t: "dm" as const, ...msg, fromName: await (await getPlayer(from))?.name ?? "" };
  sendToPid(to, data);
  sendToPid(from, data);
  return { ok: true, msg };
}

export async function handleSocial(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!/^\/api\/(friends|blocks|dm|players)/.test(path)) return false;
  const send = (status: number, json: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  const me = await verifyToken(req.headers.authorization?.replace(/^Bearer /i, ""));
  if (!me) return send(401, { error: "unauthorised" }), true;
  const parts = path.split("/").filter(Boolean);
  const body = req.method === "POST" || req.method === "PUT" ? await readJson(req) : null;
  if ((req.method === "POST" || req.method === "PUT") && !body) return send(400, { error: "bad json" }), true;

  // ---------------- friends
  if (req.method === "GET" && path === "/api/friends") {
    const friends: unknown[] = [];
    const incoming: unknown[] = [];
    const outgoing: unknown[] = [];
    for (const f of await friendshipsOf(me)) {
      const other = f.a === me ? f.b : f.a;
      const info = await look(other);
      if (!info) continue;
      if (f.status === "accepted") friends.push({ ...info, online: isOnline(other), level: f.level ?? "friend" });
      else if (f.requester === me) outgoing.push(info);
      else incoming.push(info);
    }
    return send(200, { friends, incoming, outgoing, blocked: await blocksOf(me) }), true;
  }
  if (req.method === "POST" && path === "/api/friends/request") {
    const to = String(body!.to ?? "");
    if (!PID.test(to) || to === me || !(await getPlayer(to))) return send(404, { error: "Player not found." }), true;
    if (await blockedEither(me, to)) return send(403, { error: "You can't send this request." }), true;
    if (await countFriends(me) >= 200) return send(400, { error: "Your friends list is full." }), true;
    const f = await getFriendship(me, to);
    if (f?.status === "accepted") return send(200, { status: "friends" }), true;
    if (f && f.requester !== me) {
      // they already asked you: that makes you friends
      await acceptFriend(me, to);
      sendToPid(to, { t: "friendEvent", kind: "accepted", pid: me, name: (await getPlayer(me))?.name ?? "" });
      return send(200, { status: "friends" }), true;
    }
    if (!f) await requestFriend(me, to);
    sendToPid(to, { t: "friendEvent", kind: "request", pid: me, name: (await getPlayer(me))?.name ?? "" });
    return send(200, { status: "pending" }), true;
  }
  if (req.method === "POST" && path === "/api/friends/respond") {
    const other = String(body!.pid ?? "");
    const f = PID.test(other) ? await getFriendship(me, other) : undefined;
    if (!f || f.status !== "pending" || f.requester === me) return send(404, { error: "No such request." }), true;
    if (body!.accept === true) {
      await acceptFriend(me, other);
      sendToPid(other, { t: "friendEvent", kind: "accepted", pid: me, name: (await getPlayer(me))?.name ?? "" });
    } else await removeFriendship(me, other);
    return send(200, { ok: true }), true;
  }
  if (req.method === "POST" && path === "/api/friends/level") {
    const other = clean(body?.pid, 40);
    const level = clean(body?.level, 12);
    if (!PID.test(other) || rank(level) < 0) return send(400, { error: "Pick a friend and a level." }), true;
    const f = await getFriendship(me, other);
    if (f?.status !== "accepted") return send(400, { error: "You can only change this with a friend." }), true;
    const cur = f.level ?? "friend";
    const myName = (await getPlayer(me))?.name ?? "";
    if (rank(level) <= rank(cur)) {
      // coming down (or staying): no permission needed, the other person is told
      await setFriendLevel(me, other, level);
      sendToPid(other, { t: "relChanged", pid: me, name: myName, level, by: "them" });
      return send(200, { status: "set", level }), true;
    }
    if (PARTNER.includes(level)) {
      if ((await countLevel(me, PARTNER, other)) > 0) return send(400, { error: "You already have a partner. Move them back to friend first." }), true;
      if ((await countLevel(other, PARTNER, me)) > 0) return send(400, { error: "They already have a partner." }), true;
    }
    if (level === "fwb" && ((await countLevel(me, ["fwb"], other)) >= 3 || (await countLevel(other, ["fwb"], me)) >= 3)) return send(400, { error: "That is too many already." }), true;
    if (!isOnline(other)) return send(409, { error: "They need to be online to answer. Try again when they are." }), true;
    asks.set(`${me}|${other}`, { level, at: Date.now() });
    sendToPid(other, { t: "relAsk", from: me, name: myName, level });
    return send(200, { status: "asked" }), true;
  }
  if (req.method === "POST" && path === "/api/friends/level/respond") {
    const from = clean(body?.pid, 40);
    const ask = asks.get(`${from}|${me}`);
    if (!PID.test(from) || !ask || Date.now() - ask.at > 10 * 60_000) return send(400, { error: "That request has expired." }), true;
    asks.delete(`${from}|${me}`);
    const myName = (await getPlayer(me))?.name ?? "";
    const f = await getFriendship(me, from);
    if (!body?.accept || f?.status !== "accepted") {
      sendToPid(from, { t: "relDeclined", pid: me, name: myName, level: ask.level });
      return send(200, { status: "declined" }), true;
    }
    if (PARTNER.includes(ask.level) && ((await countLevel(me, PARTNER, from)) > 0 || (await countLevel(from, PARTNER, me)) > 0)) return send(400, { error: "One of you already has a partner." }), true;
    await setFriendLevel(me, from, ask.level);
    sendToPid(from, { t: "relChanged", pid: me, name: myName, level: ask.level, by: "accepted" });
    return send(200, { status: "set", level: ask.level }), true;
  }
  if (req.method === "DELETE" && parts[1] === "friends" && parts.length === 3) {
    await removeFriendship(me, parts[2]);
    sendToPid(parts[2], { t: "friendEvent", kind: "removed", pid: me, name: "" });
    return send(200, { ok: true }), true;
  }

  // ---------------- blocks
  if (path === "/api/blocks") {
    if (req.method === "GET") return send(200, { blocked: await blocksOf(me) }), true;
    if (req.method === "POST") {
      const other = String(body!.pid ?? "");
      if (!PID.test(other) || other === me || !(await getPlayer(other))) return send(404, { error: "Player not found." }), true;
      await addBlock(me, other);
      await removeFriendship(me, other);
      return send(200, { ok: true }), true;
    }
  }
  if (req.method === "DELETE" && parts[1] === "blocks" && parts.length === 3) {
    await removeBlock(me, parts[2]);
    return send(200, { ok: true }), true;
  }

  // ---------------- direct messages
  if (req.method === "GET" && path === "/api/dm/threads") {
    const rows = await dmThreads(me);
    const threads: unknown[] = [];
    for (const t of rows) {
      const info = await look(t.other);
      const last = await getDm(t.last_id);
      if (info && last) threads.push({ ...info, unread: t.unread, last: { text: last.text, at: last.at, mine: last.from_pid === me }, online: isOnline(t.other) });
    }
    return send(200, { threads }), true;
  }
  if (parts[1] === "dm" && parts.length === 3 && PID.test(parts[2])) {
    const other = parts[2];
    if (req.method === "GET") {
      const f = await getFriendship(me, other);
      if (f?.status !== "accepted") return send(403, { error: "You can only see chats with friends." }), true;
      const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
      const messages = (await dmThread(me, other, before)).map((m) => ({ id: m.id, from: m.from_pid, to: m.to_pid, text: m.text, at: m.at }));
      await markRead(me, other);
      return send(200, { messages }), true;
    }
    if (req.method === "POST") {
      const r = await sendDm(me, other, body!.text);
      return send(r.ok ? 200 : 400, r.ok ? r.msg : { error: r.error }), true;
    }
  }

  // ---------------- find people by username or name
  if (req.method === "GET" && parts[1] === "players" && parts[2] === "search") {
    const q = clean(url.searchParams.get("q"), 30);
    if (q.length < 2) return send(200, { players: [] }), true;
    const rows = await searchPlayers(q, me);
    const blocked = new Set(await blocksOf(me));
    const out = rows
      .filter((p) => !blocked.has(p.pid))
      .map((p) => ({ pid: p.pid, name: p.name, username: p.username, look: p.profile_json ? JSON.parse(p.profile_json) : null, online: isOnline(p.pid) }));
    return send(200, { players: out }), true;
  }

  // ---------------- public profile card
  if (req.method === "GET" && parts[1] === "players" && parts.length === 3 && PID.test(parts[2])) {
    const info = await look(parts[2]);
    if (!info) return send(404, { error: "not found" }), true;
    const f = await getFriendship(me, parts[2]);
    return send(200, { ...info, online: isOnline(parts[2]), level: f?.status === "accepted" ? f.level : undefined, friendship: f ? (f.status === "accepted" ? "friends" : f.requester === me ? "sent" : "received") : "none", blocked: (await blocksOf(me)).includes(parts[2]) }), true;
  }
  return send(404, { error: "not found" }), true;
}
