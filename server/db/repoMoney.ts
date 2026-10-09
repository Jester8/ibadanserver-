import type { LoanStage } from "../../src/lib/protocol";
import { STATE } from "../../src/lib/custodyRules";
import { db } from "./index";
import { getState } from "./repo";

/*
 * SQL for bank loans and for selling land back to the city (loans.ts, property.ts). Times are epoch milliseconds.
 * Every change that moves money is ONE statement (a data-modifying CTE), so a loan and its ledger row, or a sold plot and
 * its cash, either both happen or neither does. Nothing here decides anything: the rules are in moneyRules.ts.
 */

const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params))[0];

export type LoanRow = {
  id: number;
  pid: string;
  principal: number;
  unpaid: number;
  interest: number;
  accrued_at: number;
  taken_at: number;
  due_at: number;
  rate_bpm: number;
  late_fee: number;
  status: "active" | "closed";
  stage: LoanStage;
  notice_at: number | null;
  seized_plot: string | null;
  closed_at: number | null;
  closed_by: "paid" | "sale" | "forgiven" | null;
  /** 1 once the bank has put a lien on a property for this loan; it stays 1 after the lien is gone (it decides the borrowing lockout) */
  was_seized: number;
};

/* ------------------------------------ loans ------------------------------------ */

export const activeLoan = (pid: string) => one<LoanRow>("SELECT * FROM loans WHERE pid = $1 AND status = 'active'", [pid]);
export const lastClosedLoan = (pid: string) => one<LoanRow>("SELECT * FROM loans WHERE pid = $1 AND status = 'closed' ORDER BY closed_at DESC, id DESC LIMIT 1", [pid]);
export const activeLoans = () => db.query<LoanRow>("SELECT * FROM loans WHERE status = 'active' ORDER BY id");
/** The moderator list: loans with the borrower's name, newest first. */
export const loansWithNames = (status: "active" | "closed", limit = 200) =>
  db.query<LoanRow & { name: string | null }>("SELECT l.*, p.name FROM loans l LEFT JOIN players p ON p.pid = l.pid WHERE l.status = $1 ORDER BY l.id DESC LIMIT $2", [status, limit]);

/**
 * A new loan and the cash it pays out (a ledger credit from the bank), in one statement. The database allows one active loan per
 * player: a second one returns null (Postgres 23505) and writes nothing.
 */
export async function insertLoan(l: { pid: string; amount: number; accruedAt: number; takenAt: number; dueAt: number; rateBpm: number; note: string }): Promise<{ loan: LoanRow; creditId: number } | null> {
  try {
    const r = await one<LoanRow & { credit_id: number }>(
      `WITH l AS (
         INSERT INTO loans (pid, principal, unpaid, interest, accrued_at, taken_at, due_at, rate_bpm)
         VALUES ($1::text, $2::int, $2::int, 0, $3::float8, $4::float8, $5::float8, $6::int) RETURNING *
       ), t AS (
         INSERT INTO transfers (from_pid, to_pid, amount, note, at, kind, debited, plot)
         SELECT $7::text, $1::text, $2::int, $8::text, $4::float8, 'loan', 1, NULL FROM l RETURNING id
       )
       SELECT l.*, t.id AS credit_id FROM l, t`,
      [l.pid, l.amount, l.accruedAt, l.takenAt, l.dueAt, l.rateBpm, STATE.bank, l.note],
    );
    const { credit_id, ...loan } = r!;
    return { loan, creditId: credit_id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return null;
    throw e;
  }
}

/** The columns a payment changes. */
export type LoanPayment = { unpaid: number; interest: number; accruedAt: number; lateFee: boolean };

/**
 * A repayment in cash: bring the loan to its new numbers and write the ledger debit (player to bank, not yet taken from the
 * player's balance), in one statement. `before` is the row the numbers were worked out from; if it has changed since, nothing
 * is written and null comes back.
 */
export async function payLoanRow(before: LoanRow, after: LoanPayment, paid: number, closed: "paid" | null, now: number, note: string): Promise<{ debitId: number } | null> {
  const r = await one<{ id: number }>(
    `WITH u AS (
       UPDATE loans SET unpaid = $3::int, interest = $4::int, accrued_at = $5::float8, late_fee = $6::int,
         status = CASE WHEN $7::text IS NULL THEN status ELSE 'closed' END, closed_at = $8::float8, closed_by = $7::text
       WHERE id = $1::int AND status = 'active' AND unpaid = $9::int AND interest = $10::int AND accrued_at = $11::float8
       RETURNING id
     )
     INSERT INTO transfers (from_pid, to_pid, amount, note, at, kind, debited, plot)
     SELECT $2::text, $12::text, $13::int, $14::text, $15::float8, 'repay', 0, NULL FROM u RETURNING id`,
    [before.id, before.pid, after.unpaid, after.interest, after.accruedAt, after.lateFee ? 1 : 0, closed, closed ? now : null, before.unpaid, before.interest, before.accrued_at, STATE.bank, paid, note, now],
  );
  return r ? { debitId: r.id } : null;
}

/** Change the bookkeeping of an active loan (never the money columns). Returns the new row, or undefined if the loan is no longer active. */
export async function updateLoan(id: number, patch: Partial<Pick<LoanRow, "stage" | "notice_at" | "seized_plot" | "was_seized">>): Promise<LoanRow | undefined> {
  const keys = (["stage", "notice_at", "seized_plot", "was_seized"] as const).filter((k) => k in patch);
  if (!keys.length) return activeLoanById(id);
  const set = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  return one<LoanRow>(`UPDATE loans SET ${set} WHERE id = $1 AND status = 'active' RETURNING *`, [id, ...keys.map((k) => patch[k])]);
}
const activeLoanById = (id: number) => one<LoanRow>("SELECT * FROM loans WHERE id = $1 AND status = 'active'", [id]);

/** Close an active loan without any money moving (a moderator forgave it). Returns the closed row, or undefined if it was not active. */
export const closeLoan = (id: number, by: "paid" | "sale" | "forgiven", now: number) =>
  one<LoanRow>("UPDATE loans SET status = 'closed', closed_at = $2, closed_by = $3 WHERE id = $1 AND status = 'active' RETURNING *", [id, now, by]);

/* ------------------------------------ plots ------------------------------------ */

export const setPlotSeized = (plotId: string, seized: boolean) => db.query("UPDATE plots SET seized = $2 WHERE plot_id = $1", [plotId, seized ? 1 : 0]);

export const loadReleases = () => db.query<{ plot_id: string; by_pid: string; at: number }>("SELECT plot_id, by_pid, at FROM plot_releases");

export type SaleRows = {
  plotId: string;
  pid: string;
  now: number;
  /** cash the city pays the player (0: none) and the ledger note */
  net: number;
  creditNote: string;
  /** what the sale pays towards the loan (0: no loan or nothing owed) */
  loanPaid: number;
  repayNote: string;
  /** the loan row the numbers were worked out from, and what it becomes */
  loanBefore: LoanRow | null;
  loanAfter: (LoanPayment & { closed: boolean; stage: LoanStage; noticeAt: number | null; seizedPlot: string | null }) | null;
};

/**
 * Sell a plot back to the city: delete the plot row, remember the release (the stale-claim tombstone), write the cash credit and
 * the loan repayment rows, and bring the loan to its new numbers, all in ONE statement. If the plot is no longer the player's, or
 * the loan has changed since its numbers were worked out, nothing is written and `freed` is false.
 */
export async function sellPlotRows(s: SaleRows): Promise<{ freed: boolean; creditId: number | null; repayId: number | null }> {
  const lb = s.loanBefore;
  const la = s.loanAfter;
  const r = await one<{ freed: number; credit_id: number | null; repay_id: number | null }>(
    `WITH d AS (
       DELETE FROM plots
       WHERE plot_id = $1::text AND owner_pid = $2::text
         AND ($4::int = 0 OR EXISTS (SELECT 1 FROM loans WHERE id = $5::int AND status = 'active' AND unpaid = $6::int AND interest = $7::int AND accrued_at = $8::float8))
       RETURNING plot_id
     ), r AS (
       INSERT INTO plot_releases (plot_id, by_pid, at) SELECT plot_id, $2::text, $3::float8 FROM d
       ON CONFLICT (plot_id) DO UPDATE SET by_pid = EXCLUDED.by_pid, at = EXCLUDED.at RETURNING plot_id
     ), c AS (
       INSERT INTO transfers (from_pid, to_pid, amount, note, at, kind, debited, plot)
       SELECT $9::text, $2::text, $10::int, $11::text, $3::float8, 'landsale', 1, $1::text FROM d WHERE $10::int > 0 RETURNING id
     ), p AS (
       INSERT INTO transfers (from_pid, to_pid, amount, note, at, kind, debited, plot)
       SELECT $2::text, $12::text, $4::int, $13::text, $3::float8, 'repay', 1, $1::text FROM d WHERE $4::int > 0 RETURNING id
     ), l AS (
       UPDATE loans SET unpaid = $14::int, interest = $15::int, accrued_at = $16::float8, late_fee = $17::int,
         status = CASE WHEN $18::int = 1 THEN 'closed' ELSE status END, closed_at = CASE WHEN $18::int = 1 THEN $3::float8 ELSE closed_at END,
         closed_by = CASE WHEN $18::int = 1 THEN 'sale' ELSE closed_by END, stage = $19::text, notice_at = $20::float8, seized_plot = $21::text
       WHERE id = $5::int AND status = 'active' AND $4::int > 0 AND EXISTS (SELECT 1 FROM d) RETURNING id
     )
     SELECT (SELECT COUNT(*) FROM d)::int AS freed, (SELECT id FROM c) AS credit_id, (SELECT id FROM p) AS repay_id`,
    [
      s.plotId, s.pid, s.now, s.loanPaid, lb?.id ?? 0, lb?.unpaid ?? 0, lb?.interest ?? 0, lb?.accrued_at ?? 0,
      STATE.city, s.net, s.creditNote, STATE.bank, s.repayNote,
      la?.unpaid ?? 0, la?.interest ?? 0, la?.accruedAt ?? 0, la?.lateFee ? 1 : 0, la?.closed ? 1 : 0, la?.stage ?? "active", la?.noticeAt ?? null, la?.seizedPlot ?? null,
    ],
  );
  return { freed: (r?.freed ?? 0) === 1, creditId: r?.credit_id ?? null, repayId: r?.repay_id ?? null };
}

/* ------------------------------------ players ------------------------------------ */

/** The reputation the player's last cloud save says they have (0 if they have never saved). The server holds no other copy of it. */
export async function cloudRep(pid: string): Promise<number> {
  const rep = (((await getState(pid))?.state ?? {}) as { rep?: unknown }).rep;
  return typeof rep === "number" && Number.isFinite(rep) ? Math.max(0, rep) : 0;
}
/** When the account was created, or null if there is no such account. */
export const accountCreatedAt = async (pid: string) => (await one<{ created_at: number }>("SELECT created_at FROM players WHERE pid = $1", [pid]))?.created_at ?? null;
