import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PlotState } from "../../src/lib/protocol";
import { db } from "./index";

/* All SQL lives here. Every function is async (PostgreSQL). Times are epoch milliseconds. */

const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];

/* ------------------------------------ land ------------------------------------ */

type PlotRow = { plot_id: string; owner_pid: string; owner_name: string; tier: number; collected_at: number; decor_json: string | null; biz: string | null; visit: string | null; price: number | null; wage: number | null; staff_json: string | null };

export async function loadPlots(): Promise<Record<string, PlotState>> {
  const out: Record<string, PlotState> = {};
  for (const r of await db.query<PlotRow>("SELECT * FROM plots")) {
    out[r.plot_id] = { ownerId: r.owner_pid, ownerName: r.owner_name, tier: r.tier, collectedAt: r.collected_at, decor: r.decor_json ? JSON.parse(r.decor_json) : undefined, biz: r.biz ?? undefined, visit: (r.visit as PlotState["visit"]) ?? undefined, price: r.price ?? undefined, wage: r.wage ?? undefined, staff: r.staff_json ? JSON.parse(r.staff_json) : undefined };
  }
  return out;
}

export async function savePlot(id: string, p: PlotState) {
  await db.query(
    `INSERT INTO plots (plot_id, owner_pid, owner_name, tier, collected_at, decor_json, biz, visit, price, wage, staff_json) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (plot_id) DO UPDATE SET owner_pid = EXCLUDED.owner_pid, owner_name = EXCLUDED.owner_name, tier = EXCLUDED.tier, collected_at = EXCLUDED.collected_at, decor_json = EXCLUDED.decor_json, biz = EXCLUDED.biz, visit = EXCLUDED.visit, price = EXCLUDED.price, wage = EXCLUDED.wage, staff_json = EXCLUDED.staff_json`,
    [id, p.ownerId, p.ownerName, p.tier, p.collectedAt, p.decor ? JSON.stringify(p.decor) : null, p.biz ?? null, p.visit ?? null, p.price ?? null, p.wage ?? null, p.staff ? JSON.stringify(p.staff) : null],
  );
}

/** One-time import of an old plots.json, if it is still lying around and the table is empty. */
export async function importLegacyPlots(dir: string) {
  const file = join(dir, "plots.json");
  const n = (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM plots"))?.n ?? 0;
  if (n > 0 || !existsSync(file)) return;
  const legacy = JSON.parse(readFileSync(file, "utf8")) as Record<string, PlotState>;
  for (const [id, p] of Object.entries(legacy)) await savePlot(id, p);
  console.log(`[db] imported ${Object.keys(legacy).length} plots from plots.json`);
}

/* ------------------------------------ players ------------------------------------ */

export type PlayerRow = { pid: string; name: string; username: string | null; email: string | null; email_verified: number; profile_json: string | null; password_hash: string | null };
const PLAYER = "pid, name, username, email, email_verified, profile_json, password_hash";

/** Players whose username starts with the text, or whose name contains it. Never includes you. */
export async function searchPlayers(q: string, me: string) {
  const esc = q.toLowerCase().replace(/[\\%_]/g, "\\$&");
  return db.query<PlayerRow>(`SELECT ${PLAYER} FROM players WHERE pid <> $1 AND (LOWER(username) LIKE $2 OR LOWER(name) LIKE $3) ORDER BY LOWER(username) LIMIT 8`, [me, `${esc}%`, `%${esc}%`]);
}

export const getPlayerByUsername = (username: string) => one<PlayerRow>(`SELECT ${PLAYER} FROM players WHERE LOWER(username) = LOWER($1)`, [username]);

export async function touchPlayer(pid: string, name: string) {
  const now = Date.now();
  await db.query(
    `INSERT INTO players (pid, name, created_at, last_seen) VALUES ($1, $2, $3, $3)
     ON CONFLICT (pid) DO UPDATE SET name = EXCLUDED.name, last_seen = EXCLUDED.last_seen`,
    [pid, name, now],
  );
}

export const getPlayer = (pid: string) => one<PlayerRow>(`SELECT ${PLAYER} FROM players WHERE pid = $1`, [pid]);
export const getPlayerByEmail = (email: string) => one<PlayerRow>(`SELECT ${PLAYER} FROM players WHERE email = $1`, [email]);
export const hasEmail = async (pid: string) => !!(await one<{ email: string | null }>("SELECT email FROM players WHERE pid = $1", [pid]))?.email;

export async function createVerifiedPlayer(pid: string, name: string, email: string, look: unknown, username: string | null = null, passwordHash: string | null = null) {
  const now = Date.now();
  await db.query("INSERT INTO players (pid, name, created_at, last_seen, email, email_verified, profile_json, username, password_hash) VALUES ($1, $2, $3, $3, $4, 1, $5, $6, $7)", [pid, name, now, email, look ? JSON.stringify(look) : null, username, passwordHash]);
}

export async function getState(pid: string): Promise<{ state: unknown; updatedAt: number } | null> {
  const r = await one<{ state_json: string | null; state_updated: number | null }>("SELECT state_json, state_updated FROM players WHERE pid = $1", [pid]);
  if (!r?.state_json) return null;
  return { state: JSON.parse(r.state_json), updatedAt: r.state_updated ?? 0 };
}

export async function putState(pid: string, name: string, state: unknown, look?: unknown) {
  await touchPlayer(pid, name);
  await db.query("UPDATE players SET state_json = $1, state_updated = $2, profile_json = COALESCE($3, profile_json) WHERE pid = $4", [JSON.stringify(state), Date.now(), look ? JSON.stringify(look) : null, pid]);
}

export const addReport = (reporter: string, target: string, reason: string) =>
  db.query("INSERT INTO reports (at, reporter, target, reason) VALUES ($1, $2, $3, $4)", [Date.now(), reporter, target, reason]);

export const recordElection = (term: number, winner: { pid: string; name: string; slogan: string; votes: number } | null) =>
  db.query(
    `INSERT INTO elections (term, winner_pid, winner_name, slogan, votes, ended_at) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (term) DO UPDATE SET winner_pid = EXCLUDED.winner_pid, winner_name = EXCLUDED.winner_name, slogan = EXCLUDED.slogan, votes = EXCLUDED.votes, ended_at = EXCLUDED.ended_at`,
    [term, winner?.pid ?? null, winner?.name ?? null, winner?.slogan ?? null, winner?.votes ?? 0, Date.now()],
  );

/* ------------------------------------ one-time codes ------------------------------------ */

export type CodeRow = { email: string; code_hash: string; expires_at: number; attempts: number; sent_at: number; sends_window: number; window_start: number };
export const getCode = (email: string) => one<CodeRow>("SELECT * FROM auth_codes WHERE email = $1", [email]);

export const saveCode = (email: string, hash: string, expiresAt: number, now: number) =>
  db.query(
    `INSERT INTO auth_codes (email, code_hash, expires_at, attempts, sent_at, sends_window, window_start) VALUES ($1, $2, $3, 0, $4, 1, $4)
     ON CONFLICT (email) DO UPDATE SET code_hash = EXCLUDED.code_hash, expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at,
       sends_window = CASE WHEN EXCLUDED.sent_at - auth_codes.window_start > 3600000 THEN 1 ELSE auth_codes.sends_window + 1 END,
       window_start = CASE WHEN EXCLUDED.sent_at - auth_codes.window_start > 3600000 THEN EXCLUDED.sent_at ELSE auth_codes.window_start END`,
    [email, hash, expiresAt, now],
  );
export const bumpAttempts = (email: string) => db.query("UPDATE auth_codes SET attempts = attempts + 1 WHERE email = $1", [email]);
export const deleteCode = (email: string) => db.query("DELETE FROM auth_codes WHERE email = $1", [email]);

/* ------------------------------------ friends and blocks ------------------------------------ */

const pair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);
export type FriendRow = { a: string; b: string; requester: string; status: "pending" | "accepted"; created_at: number; level: string };

export function getFriendship(x: string, y: string) {
  const [a, b] = pair(x, y);
  return one<FriendRow>("SELECT * FROM friendships WHERE a = $1 AND b = $2", [a, b]);
}
export async function setFriendLevel(x: string, y: string, level: string) {
  const [a, b] = pair(x, y);
  await db.query("UPDATE friendships SET level = $3 WHERE a = $1 AND b = $2 AND status = 'accepted'", [a, b, level]);
}
/** How many of this player's friendships are at one of these levels (leaving out one friend). */
export async function countLevel(pid: string, levels: string[], exceptOther?: string) {
  const rows = await db.query<FriendRow>("SELECT * FROM friendships WHERE (a = $1 OR b = $1) AND status = 'accepted'", [pid]);
  return rows.filter((f) => levels.includes(f.level) && (f.a === pid ? f.b : f.a) !== exceptOther).length;
}
export const friendshipsOf = (pid: string) => db.query<FriendRow>("SELECT * FROM friendships WHERE a = $1 OR b = $1", [pid]);
export function requestFriend(from: string, to: string) {
  const [a, b] = pair(from, to);
  return db.query("INSERT INTO friendships (a, b, requester, status, created_at) VALUES ($1, $2, $3, 'pending', $4)", [a, b, from, Date.now()]);
}
export function acceptFriend(x: string, y: string) {
  const [a, b] = pair(x, y);
  return db.query("UPDATE friendships SET status = 'accepted' WHERE a = $1 AND b = $2", [a, b]);
}
export function removeFriendship(x: string, y: string) {
  const [a, b] = pair(x, y);
  return db.query("DELETE FROM friendships WHERE a = $1 AND b = $2", [a, b]);
}
export const countFriends = async (pid: string) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM friendships WHERE (a = $1 OR b = $1) AND status = 'accepted'", [pid]))?.n ?? 0;

/* ------------------------------------ family ------------------------------------ */

export type FamilyRow = { a: string; b: string; requester: string; role: string; status: "pending" | "accepted"; created_at: number };

export function getFamilyLink(x: string, y: string) {
  const [a, b] = pair(x, y);
  return one<FamilyRow>("SELECT * FROM family WHERE a = $1 AND b = $2", [a, b]);
}
export const familyOf = (pid: string) => db.query<FamilyRow>("SELECT * FROM family WHERE a = $1 OR b = $1 ORDER BY created_at", [pid]);
export function requestFamily(from: string, to: string, role: string) {
  const [a, b] = pair(from, to);
  return db.query("INSERT INTO family (a, b, requester, role, status, created_at) VALUES ($1, $2, $3, $4, 'pending', $5)", [a, b, from, role, Date.now()]);
}
export function acceptFamily(x: string, y: string) {
  const [a, b] = pair(x, y);
  return db.query("UPDATE family SET status = 'accepted' WHERE a = $1 AND b = $2", [a, b]);
}
export function removeFamily(x: string, y: string) {
  const [a, b] = pair(x, y);
  return db.query("DELETE FROM family WHERE a = $1 AND b = $2", [a, b]);
}

export const blockedEither = async (x: string, y: string) => !!(await one("SELECT 1 AS x FROM blocks WHERE (blocker = $1 AND blocked = $2) OR (blocker = $2 AND blocked = $1)", [x, y]));
export const blocksOf = async (pid: string) => (await db.query<{ blocked: string }>("SELECT blocked FROM blocks WHERE blocker = $1", [pid])).map((r) => r.blocked);
export const addBlock = (blocker: string, blocked: string) => db.query("INSERT INTO blocks (blocker, blocked, at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", [blocker, blocked, Date.now()]);
export const removeBlock = (blocker: string, blocked: string) => db.query("DELETE FROM blocks WHERE blocker = $1 AND blocked = $2", [blocker, blocked]);

/* ------------------------------------ messages ------------------------------------ */

export type DmRow = { id: number; from_pid: string; to_pid: string; text: string; at: number; read_at: number | null };

export async function addDm(from: string, to: string, text: string, at: number) {
  const r = await one<{ id: number }>("INSERT INTO dms (from_pid, to_pid, text, at) VALUES ($1, $2, $3, $4) RETURNING id", [from, to, text, at]);
  return r!.id;
}
export async function dmThread(x: string, y: string, before: number, limit = 50) {
  const rows = await db.query<DmRow>(
    "SELECT * FROM dms WHERE ((from_pid = $1 AND to_pid = $2) OR (from_pid = $2 AND to_pid = $1)) AND id < $3 ORDER BY id DESC LIMIT $4",
    [x, y, Math.min(before, 2147483647), limit],
  );
  return rows.reverse();
}
export const markRead = (me: string, other: string) => db.query("UPDATE dms SET read_at = $1 WHERE to_pid = $2 AND from_pid = $3 AND read_at IS NULL", [Date.now(), me, other]);
export const dmThreads = (pid: string) =>
  db.query<{ other: string; last_id: number; unread: number }>(
    `SELECT other, MAX(id) AS last_id, SUM(CASE WHEN to_pid = $1 AND read_at IS NULL THEN 1 ELSE 0 END)::int AS unread FROM (
       SELECT id, CASE WHEN from_pid = $1 THEN to_pid ELSE from_pid END AS other, to_pid, read_at FROM dms WHERE from_pid = $1 OR to_pid = $1
     ) t GROUP BY other ORDER BY last_id DESC LIMIT 100`,
    [pid],
  );
export const getDm = (id: number) => one<DmRow>("SELECT * FROM dms WHERE id = $1", [id]);

export async function addRoomMessage(room: string, pid: string, name: string, text: string, at: number) {
  await db.query("INSERT INTO room_messages (room, from_pid, from_name, text, at) VALUES ($1, $2, $3, $4, $5)", [room, pid, name, text, at]);
  // keep the table small: drop anything older than a day
  if (Math.random() < 0.02) await db.query("DELETE FROM room_messages WHERE at < $1", [at - 24 * 3600_000]);
}
export async function roomHistory(room: string, limit = 30) {
  const rows = await db.query<{ from_pid: string; from_name: string; text: string; at: number }>("SELECT from_pid, from_name, text, at FROM room_messages WHERE room = $1 ORDER BY id DESC LIMIT $2", [room, limit]);
  return rows.reverse();
}

/* ------------------------------------ artist tracks ------------------------------------ */

export type TrackRow = {
  id: string;
  title: string;
  artist: string;
  owner_pid: string;
  rights_holder: string;
  rights_statement: string;
  license: string;
  status: "pending" | "approved" | "rejected";
  mime: string | null;
  size: number | null;
  file: string | null;
  created_at: number;
  reviewed_at: number | null;
  review_note: string | null;
};

export const createTrack = (t: { id: string; title: string; artist: string; ownerPid: string; rightsHolder: string; statement: string }) =>
  db.query("INSERT INTO tracks (id, title, artist, owner_pid, rights_holder, rights_statement, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)", [t.id, t.title, t.artist, t.ownerPid, t.rightsHolder, t.statement, Date.now()]);
export const getTrack = (id: string) => one<TrackRow>("SELECT * FROM tracks WHERE id = $1", [id]);
export const listTracks = (status: string) => db.query<TrackRow>("SELECT * FROM tracks WHERE status = $1 ORDER BY created_at DESC", [status]);
export const tracksOf = (pid: string) => db.query<TrackRow>("SELECT * FROM tracks WHERE owner_pid = $1 ORDER BY created_at DESC", [pid]);
export const countRecentTracks = async (pid: string, since: number) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM tracks WHERE owner_pid = $1 AND created_at > $2", [pid, since]))?.n ?? 0;
export const setTrackFile = (id: string, file: string, mime: string, size: number) => db.query("UPDATE tracks SET file = $1, mime = $2, size = $3, status = 'pending' WHERE id = $4", [file, mime, size, id]);
export const reviewTrack = (id: string, status: "approved" | "rejected", note: string) => db.query("UPDATE tracks SET status = $1, review_note = $2, reviewed_at = $3 WHERE id = $4", [status, note, Date.now(), id]);
export const deleteTrackRow = (id: string) => db.query("DELETE FROM tracks WHERE id = $1", [id]);

/* ---------------------------------- bank transfers ---------------------------------- */

export type TransferRow = { id: number; from_pid: string; to_pid: string; amount: number; note: string; at: number; claimed: number };

export async function addTransfer(from: string, to: string, amount: number, note: string, kind = "transfer", debited = 1, plot: string | null = null) {
  const r = await db.query<{ id: number }>("INSERT INTO transfers (from_pid, to_pid, amount, note, at, kind, debited, plot) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id", [from, to, amount, note, Date.now(), kind, debited, plot]);
  return r[0].id;
}
export const sentSince = async (pid: string, since: number) => Number((await db.query<{ n: string | null }>("SELECT COALESCE(SUM(amount), 0) AS n FROM transfers WHERE from_pid = $1 AND at > $2", [pid, since]))[0]?.n ?? 0);
export const pendingFor = (pid: string) => db.query<TransferRow>("SELECT * FROM transfers WHERE to_pid = $1 AND claimed = 0 ORDER BY id LIMIT 50", [pid]);
/** Marks a credit as received. True only the first time, so money is added exactly once. */
export async function claimTransfer(id: number, pid: string) {
  const r = await db.query<{ id: number }>("UPDATE transfers SET claimed = 1 WHERE id = $1 AND to_pid = $2 AND claimed = 0 RETURNING id", [id, pid]);
  return r.length > 0;
}
export const getTransfer = (id: number) => one<TransferRow>("SELECT * FROM transfers WHERE id = $1", [id]);
export const transfersOf = (pid: string) => db.query<TransferRow>("SELECT * FROM transfers WHERE from_pid = $1 OR to_pid = $1 ORDER BY id DESC LIMIT 25", [pid]);

/** Wages owed by an employer who was offline when the shift was worked. */
export const pendingDebits = (pid: string) => db.query<TransferRow>("SELECT * FROM transfers WHERE from_pid = $1 AND debited = 0 ORDER BY id LIMIT 50", [pid]);
export async function markDebited(id: number, pid: string) {
  const r = await db.query<{ id: number }>("UPDATE transfers SET debited = 1 WHERE id = $1 AND from_pid = $2 AND debited = 0 RETURNING id", [id, pid]);
  return r.length > 0;
}
/** Recent sales a business has made, newest first. */
export const salesOf = (plot: string) => db.query<TransferRow & { plot: string }>("SELECT * FROM transfers WHERE plot = $1 AND kind = 'sale' ORDER BY id DESC LIMIT 25", [plot]);
export const lastShift = async (worker: string, plot: string) => Number((await db.query<{ at: number | null }>("SELECT MAX(at) AS at FROM transfers WHERE to_pid = $1 AND plot = $2 AND kind = 'wage'", [worker, plot]))[0]?.at ?? 0);
