import type { CaseKind, CaseReason, CaseStatus } from "../../src/lib/protocol";
import { db } from "./index";

/*
 * SQL for police and EFCC cases, pokes and hits, and the ledger questions the EFCC asks. Times are epoch milliseconds.
 * Nothing here decides anything: the rules are in custodyRules.ts and socialRules.ts, the policy is in custody.ts.
 */

const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];

export type CaseRow = {
  id: number;
  kind: CaseKind;
  reason: CaseReason;
  reporter: string;
  accused: string;
  pair: string;
  reporter_name: string;
  accused_name: string;
  status: CaseStatus;
  via: string;
  filed_at: number;
  confirm_by: number;
  held_at: number | null;
  release_at: number | null;
  closed_at: number | null;
  bail: number;
  fine: number;
  fee: number;
  fee_state: "paid" | "refunded" | "kept";
  prior: number;
  disputed: number;
  retaliation: number;
  cell: number | null;
  paid_by: string | null;
  paid_amount: number | null;
  asked_at: number | null;
  asks: number;
  merged_into: number | null;
  evidence_json: string | null;
  note: string | null;
};

export type NewCase = Pick<CaseRow, "kind" | "reason" | "reporter" | "accused" | "reporter_name" | "accused_name" | "via" | "filed_at" | "confirm_by" | "bail" | "fine" | "fee" | "prior" | "disputed" | "retaliation" | "evidence_json">;
export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Insert a filed case. Throws code 23505 when the pair already has an open case (the database is the referee in a race). */
export async function insertCase(c: NewCase): Promise<CaseRow> {
  const r = await one<CaseRow>(
    `INSERT INTO cases (kind, reason, reporter, accused, pair, reporter_name, accused_name, status, via, filed_at, confirm_by, bail, fine, fee, prior, disputed, retaliation, evidence_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'filed', $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
    [c.kind, c.reason, c.reporter, c.accused, pairKey(c.reporter, c.accused), c.reporter_name, c.accused_name, c.via, c.filed_at, c.confirm_by, c.bail, c.fine, c.fee, c.prior, c.disputed, c.retaliation, c.evidence_json],
  );
  return r!;
}

export const getCase = (id: number) => one<CaseRow>("SELECT * FROM cases WHERE id = $1", [id]);
export const casesFor = (pid: string, limit = 20) => db.query<CaseRow>("SELECT * FROM cases WHERE reporter = $1 OR accused = $1 ORDER BY id DESC LIMIT $2", [pid, limit]);
export const loadHeld = () => db.query<CaseRow>("SELECT * FROM cases WHERE status = 'held'");
export const loadFiled = () => db.query<CaseRow>("SELECT * FROM cases WHERE status = 'filed'");
export const casesByStatus = (status: string, limit = 100) => db.query<CaseRow>("SELECT * FROM cases WHERE status = $1 ORDER BY id DESC LIMIT $2", [status, limit]);

type Patch = Partial<Pick<CaseRow, "held_at" | "release_at" | "closed_at" | "cell" | "paid_by" | "paid_amount" | "fee_state" | "merged_into" | "note" | "asked_at" | "asks" | "bail" | "disputed">>;

/** Atomic: only moves a case that is still in one of `from`. Returns the new row, or undefined when someone got there first. */
export async function transition(id: number, from: string[], to: string, patch: Patch = {}): Promise<CaseRow | undefined> {
  const sets = ["status = $2"];
  const params: unknown[] = [id, to];
  for (const [k, v] of Object.entries(patch)) {
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  const marks = from.map((s) => {
    params.push(s);
    return `$${params.length}`;
  });
  return one<CaseRow>(`UPDATE cases SET ${sets.join(", ")} WHERE id = $1 AND status IN (${marks.join(", ")}) RETURNING *`, params);
}

/** Counters for the reporter's limits. */
export const countFiledBy = async (pid: string, since: number) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM cases WHERE reporter = $1 AND filed_at > $2", [pid, since]))?.n ?? 0;
export const countOpenFiledBy = async (pid: string) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM cases WHERE reporter = $1 AND status = 'filed'", [pid]))?.n ?? 0;
export const lastFiledBy = async (pid: string) => Number((await one<{ at: number | null }>("SELECT MAX(filed_at) AS at FROM cases WHERE reporter = $1", [pid]))?.at ?? 0);
/** Cases that went nowhere: they lapsed, or were dropped with the fee kept. Too many in a day and the reporter cools off. */
export const countExpiredOrKeptBy = async (pid: string, since: number) =>
  (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM cases WHERE reporter = $1 AND filed_at > $2 AND (status = 'expired' OR (status = 'withdrawn' AND fee_state = 'kept'))", [pid, since]))?.n ?? 0;
/** How many times this player has been held since then. */
export const priorHolds = async (accused: string, since: number) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM cases WHERE accused = $1 AND held_at IS NOT NULL AND held_at > $2", [accused, since]))?.n ?? 0;
/** When this player was last let out of a hold, whatever the cause (0 = never). */
export const lastReleaseOf = async (accused: string) => Number((await one<{ at: number | null }>("SELECT MAX(closed_at) AS at FROM cases WHERE accused = $1 AND held_at IS NOT NULL AND closed_at IS NOT NULL", [accused]))?.at ?? 0);
/** When the last case from this reporter against this player closed (0 = none). */
export const lastClosedSameDirection = async (reporter: string, accused: string) => Number((await one<{ at: number | null }>("SELECT MAX(closed_at) AS at FROM cases WHERE reporter = $1 AND accused = $2 AND closed_at IS NOT NULL", [reporter, accused]))?.at ?? 0);
/** Cases still waiting to be booked against this player. */
export const filedAgainst = (accused: string, since: number) => db.query<CaseRow>("SELECT * FROM cases WHERE accused = $1 AND status = 'filed' AND filed_at > $2 ORDER BY id", [accused, since]);
/** A `filed` or `held` case between the two (either way round), or one that closed after `since`. */
export const caseBetweenRecent = (reporter: string, accused: string, since: number) =>
  one<CaseRow>("SELECT * FROM cases WHERE reporter = $1 AND accused = $2 AND (status IN ('filed', 'held') OR closed_at > $3) ORDER BY id DESC LIMIT 1", [reporter, accused, since]);
/** The last few things a player said in the open (server-trusted: these were filtered on the way in). */
export const recentLinesBy = (pid: string, since: number, limit = 3) =>
  db.query<{ room: string; text: string; at: number }>("SELECT room, text, at FROM room_messages WHERE from_pid = $1 AND at > $2 ORDER BY id DESC LIMIT $3", [pid, since, limit]);

/** Ledger questions for the EFCC (only plain transfers between players count). */
export const sentBetween = async (from: string, to: string, since: number) => {
  const r = await one<{ n: number; total: string | null; first_at: number | null }>("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount), 0) AS total, MIN(at) AS first_at FROM transfers WHERE from_pid = $1 AND to_pid = $2 AND at > $3 AND kind = 'transfer'", [from, to, since]);
  return { n: r?.n ?? 0, total: Number(r?.total ?? 0), firstAt: Number(r?.first_at ?? 0) };
};
export const receivedDistinct = async (pid: string, since: number) => {
  const r = await one<{ senders: number; total: string | null }>("SELECT COUNT(DISTINCT from_pid)::int AS senders, COALESCE(SUM(amount), 0) AS total FROM transfers WHERE to_pid = $1 AND at > $2 AND kind = 'transfer'", [pid, since]);
  return { senders: r?.senders ?? 0, total: Number(r?.total ?? 0) };
};
export const payeesOf = async (pid: string, since: number) =>
  (await db.query<{ to_pid: string; n: number; total: string; last_at: number }>("SELECT to_pid, COUNT(*)::int AS n, SUM(amount) AS total, MAX(at) AS last_at FROM transfers WHERE from_pid = $1 AND at > $2 AND kind = 'transfer' AND to_pid NOT LIKE 'state:%' GROUP BY to_pid ORDER BY MAX(at) DESC LIMIT 20", [pid, since])).map((r) => ({ to_pid: r.to_pid, n: r.n, total: Number(r.total), last_at: Number(r.last_at) }));

/** The account's flags: its age, and whether reporting is suspended or the account is watched. */
export const playerFlags = (pid: string) => one<{ created_at: number; police_ban_until: number | null; watch_until: number | null }>("SELECT created_at, police_ban_until, watch_until FROM players WHERE pid = $1", [pid]);
export const setPoliceBan = (pid: string, until: number | null) => db.query("UPDATE players SET police_ban_until = $2 WHERE pid = $1", [pid, until]);
export const setWatch = (pid: string, until: number | null) => db.query("UPDATE players SET watch_until = $2 WHERE pid = $1", [pid, until]);

/* ---- pokes and hits ---- */
export const playerMeta = (pid: string) => one<{ created_at: number; poke_mode: string | null }>("SELECT created_at, poke_mode FROM players WHERE pid = $1", [pid]);
export const setPokeModeRow = (pid: string, mode: string) => db.query("UPDATE players SET poke_mode = $2 WHERE pid = $1", [pid, mode]);
export const insertHit = (at: number, from: string, to: string, room: string) => db.query("INSERT INTO pokes (at, from_pid, to_pid, kind, room) VALUES ($1, $2, $3, 'hit', $4)", [at, from, to, room]);
export const countHits = async (from: string, to: string, since: number) => (await one<{ n: number }>("SELECT COUNT(*)::int AS n FROM pokes WHERE from_pid = $1 AND to_pid = $2 AND at > $3", [from, to, since]))?.n ?? 0;
/** How many hits each person has taken from this one in the window, grouped by who was hit (for the "Recent" list). */
export const hitsOn = async (to: string, since: number) =>
  (await db.query<{ from_pid: string; n: number }>("SELECT from_pid, COUNT(*)::int AS n FROM pokes WHERE to_pid = $1 AND at > $2 GROUP BY from_pid", [to, since])).map((r) => ({ from: r.from_pid, n: r.n }));
export const purgeHits = (before: number) => db.query("DELETE FROM pokes WHERE at < $1", [before]);
