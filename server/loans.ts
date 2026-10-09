import { MIN, STATE, stateName } from "../src/lib/custodyRules";
import { LOAN, applyPayment, collateralOf, creditLimit, newLoan, owedNow, paidValue, titleIndexOf, type LoanMath } from "../src/lib/moneyRules";
import type { LoanView, LoanWhy } from "../src/lib/protocol";
import type { Result, SocialErrorCode } from "../src/lib/socialRules";
import { config } from "./config";
import { accountCreatedAt, activeLoan, activeLoans, closeLoan, cloudRep, insertLoan, lastClosedLoan, loansWithNames, payLoanRow, setPlotSeized, updateLoan, type LoanRow, type SaleRows } from "./db/repoMoney";
import { broadcast, isOnline, plots, sendToPid, type Client } from "./presence";

/*
 * Bank loans. The server keeps the loan (one row per borrower) and the clock; the cash arrives as a ledger credit and each
 * repayment leaves as a ledger debit, so money moves exactly once even if the tab closes. What a cheating client cannot dodge
 * is what the server owns: the loan row, the lien on a property, the lockout. Numbers and arithmetic: moneyRules.ts.
 */

/* ------------------------------------------------ small shared helpers (property.ts uses them too) ------------------------------------------------ */

export const naira = (n: number) => `₦${Math.round(n).toLocaleString("en-US")}`;
export const fail = (status: number, code: SocialErrorCode, error: string): Result<never> => ({ ok: false, status, code, error });
export const done = <T,>(data: T): Result<T> => ({ ok: true, data });

/** Run one thing at a time per player, so two requests (or a request and the clock) never work from the same stale loan. Do not nest. */
const locks = new Map<string, Promise<void>>();
export function withPidLock<T>(pid: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(pid) ?? Promise.resolve()).then(fn);
  const tail = run.then(() => undefined, () => undefined);
  locks.set(pid, tail);
  void tail.then(() => {
    if (locks.get(pid) === tail) locks.delete(pid);
  });
  return run;
}

/** True when this player did `kind` less than `gapMs` ago; otherwise it remembers `now` as the last time. */
const gaps = new Map<string, number>();
export function tooSoon(kind: string, pid: string, gapMs: number, now: number): boolean {
  const key = `${kind}|${pid}`;
  const last = gaps.get(key);
  if (last !== undefined && now - last < gapMs) return true;
  gaps.set(key, now);
  if (gaps.size > 2000) for (const [k, t] of gaps) if (now - t > 60_000) gaps.delete(k);
  return false;
}

const CLOSED = "The bank is closed for now.";
const termText = (min: number) => (min % 60 === 0 ? `${min / 60} hour${min === 60 ? "" : "s"}` : `${min} minutes`);

/* ------------------------------------------------ one loan as the rules and the player see it ------------------------------------------------ */

export const mathOf = (r: LoanRow): LoanMath => ({ principal: r.principal, left: r.unpaid, interest: r.interest, at: r.accrued_at, dueAt: r.due_at, rateBpm: r.rate_bpm, lateFee: r.late_fee === 1 });

/** The loan as the player sees it. The interest is the stored base ("as of `at`"); the player's screen brings it up to date with the same rules. */
export const viewOf = (r: LoanRow, now: number): LoanView => ({
  id: r.id,
  principal: r.principal,
  left: r.unpaid,
  interest: r.interest,
  at: r.accrued_at,
  takenAt: r.taken_at,
  dueAt: r.due_at,
  rateBpm: r.rate_bpm,
  lateFee: r.late_fee === 1,
  stage: r.seized_plot ? "seized" : r.notice_at != null ? "notice" : now > r.due_at ? "overdue" : "active",
  noticeAt: r.notice_at,
  seizedPlot: r.seized_plot,
});

const pushLoan = (pid: string, row: LoanRow | null, why: LoanWhy, now: number) => sendToPid(pid, { t: "loan", loan: row ? viewOf(row, now) : null, now, why });

/** Put a lien on a plot (or lift it): in memory, in the database, and tell everyone who can see the plot. */
async function markPlot(plotId: string, on: boolean): Promise<void> {
  const p = plots[plotId];
  if (!p || !!p.seized === on) return;
  if (on) p.seized = true;
  else delete p.seized;
  await setPlotSeized(plotId, on);
  broadcast({ t: "plot", plotId, plot: p });
}
const liftLien = async (plotId: string | null) => {
  if (plotId) await markPlot(plotId, false);
};

/* ------------------------------------------------ what a player may borrow ------------------------------------------------ */

export type LoanBlock = { code: SocialErrorCode; text: string; until?: number };
export type Offer = { limit: number; titleBase: number; collateral: number; titleIdx: number; blocked: LoanBlock | null; now: number };
const BLOCK_STATUS: Partial<Record<SocialErrorCode, number>> = { OFF: 503, TOO_NEW: 403, LOAN_ACTIVE: 409, LOAN_LOCKED: 403 };

/** Why this player cannot borrow right now, in the order the rules check it; null when they can. */
async function blockOf(pid: string, now: number): Promise<LoanBlock | null> {
  if (!config.loans) return { code: "OFF", text: CLOSED };
  const created = await accountCreatedAt(pid);
  if (created === null || now - created < LOAN.minAccountAgeMs) {
    return { code: "TOO_NEW", text: `The bank lends to accounts that are at least ${LOAN.minAccountAgeMs / MIN} minutes old.`, ...(created === null ? {} : { until: created + LOAN.minAccountAgeMs }) };
  }
  if (await activeLoan(pid)) return { code: "LOAN_ACTIVE", text: "You already have a loan. Pay it off first." };
  const last = await lastClosedLoan(pid);
  if (last?.closed_at != null && last.closed_by !== "forgiven") {
    const until = last.closed_at + (last.stage === "seized" ? LOAN.lockoutAfterSeizureMs : LOAN.cooldownMs);
    if (now < until) return { code: "LOAN_LOCKED", text: `You can borrow again in ${Math.ceil((until - now) / MIN)} minutes.`, until };
  }
  return null;
}

/** The credit limit from the title the player's last cloud save earned and the property they own now. */
export async function offerFor(pid: string, now = Date.now()): Promise<Offer> {
  const titleIdx = titleIndexOf(await cloudRep(pid));
  const collateral = collateralOf(plots, pid);
  return { limit: creditLimit(titleIdx, collateral), titleBase: LOAN.titleBase[titleIdx], collateral, titleIdx, blocked: await blockOf(pid, now), now };
}

export async function getLoan(pid: string, now = Date.now()): Promise<Result<{ loan: LoanView | null; now: number }>> {
  if (!config.loans) return fail(503, "OFF", CLOSED);
  const row = await activeLoan(pid);
  return done({ loan: row ? viewOf(row, now) : null, now });
}

/* ------------------------------------------------ take and repay ------------------------------------------------ */

export function takeLoan(pid: string, amountIn: unknown, termIn: unknown, now = Date.now()): Promise<Result<{ loan: LoanView; now: number }>> {
  return withPidLock(pid, async () => {
    if (!config.loans) return fail(503, "OFF", CLOSED);
    if (tooSoon("loan", pid, LOAN.minGapMs, now)) return fail(429, "RATE", "Slow down a little.");
    if (typeof amountIn !== "number" || !Number.isInteger(amountIn)) return fail(400, "BAD", "Choose how much to borrow.");
    if (amountIn < LOAN.minAmount) return fail(400, "LOAN_MIN", `The smallest loan is ${naira(LOAN.minAmount)}.`);
    if (amountIn % LOAN.step !== 0) return fail(400, "BAD", `Loans come in steps of ${naira(LOAN.step)}.`);
    if (typeof termIn !== "number" || !(LOAN.terms as readonly number[]).includes(termIn)) return fail(400, "LOAN_TERM", "Choose 1, 3 or 6 hours to repay.");
    const offer = await offerFor(pid, now);
    if (offer.blocked) return fail(BLOCK_STATUS[offer.blocked.code] ?? 400, offer.blocked.code, offer.blocked.text);
    if (amountIn > offer.limit) return fail(422, "LOAN_LIMIT", `The most you can borrow right now is ${naira(offer.limit)}.`);

    const fresh = newLoan(amountIn, termIn, now);
    const note = `Loan: ${naira(amountIn)} for ${termText(termIn)}`;
    const made = await insertLoan({ pid, amount: amountIn, accruedAt: fresh.at, takenAt: fresh.takenAt, dueAt: fresh.dueAt, rateBpm: fresh.rateBpm, note });
    if (!made) return fail(409, "LOAN_ACTIVE", "You already have a loan. Pay it off first.");
    sendToPid(pid, { t: "credit", id: made.creditId, from: stateName(STATE.bank) ?? "Bank", username: "", amount: amountIn, note });
    pushLoan(pid, made.loan, "take", now);
    return done({ loan: viewOf(made.loan, now), now });
  });
}

export function repayLoan(pid: string, amountIn: unknown, now = Date.now()): Promise<Result<{ loan: LoanView | null; paid: number; now: number }>> {
  return withPidLock(pid, async () => {
    if (!config.loans) return fail(503, "OFF", CLOSED);
    if (tooSoon("loan", pid, LOAN.minGapMs, now)) return fail(429, "RATE", "Slow down a little.");
    if (typeof amountIn !== "number" || !Number.isFinite(amountIn) || amountIn < 1) return fail(400, "BAD", "Enter how much to pay.");
    const row = await activeLoan(pid);
    if (!row) return fail(404, "LOAN_NONE", "You have no loan.");
    const r = applyPayment(mathOf(row), amountIn, now);
    const note = "Loan repayment";
    const paid = await payLoanRow(row, { unpaid: r.loan.left, interest: r.loan.interest, accruedAt: r.loan.at, lateFee: r.loan.lateFee }, r.paid, r.closed ? "paid" : null, now, note);
    if (!paid) return fail(409, "BAD", "Your loan just changed. Try again.");
    sendToPid(pid, { t: "debit", id: paid.debitId, to: stateName(STATE.bank) ?? "Bank", amount: r.paid, note });
    if (r.closed) {
      await liftLien(row.seized_plot);
      pushLoan(pid, null, "cleared", now);
      return done({ loan: null, paid: r.paid, now });
    }
    const left = (await activeLoan(pid))!;
    pushLoan(pid, left, "repay", now);
    return done({ loan: viewOf(left, now), paid: r.paid, now });
  });
}

/* ------------------------------------------------ a sale pays the bank first (property.ts) ------------------------------------------------ */

export type SalePlan = { paid: number; after: NonNullable<SaleRows["loanAfter"]> };

/** What selling `soldPlotId` for `gross` does to this loan: the bank is paid first. If the plot under lien is the one sold and debt remains, the loan goes back to the notice stage with a fresh countdown. */
export function planSalePayment(row: LoanRow, gross: number, soldPlotId: string, now: number): SalePlan {
  const r = applyPayment(mathOf(row), gross, now);
  const liened = row.seized_plot === soldPlotId;
  return {
    paid: r.paid,
    after: {
      unpaid: r.loan.left,
      interest: r.loan.interest,
      accruedAt: r.loan.at,
      lateFee: r.loan.lateFee,
      closed: r.closed,
      noticeAt: liened && !r.closed ? now : row.notice_at,
      seizedPlot: liened ? null : row.seized_plot,
    },
  };
}

/** After the sale was written: lift a lien that is no longer needed and tell the player where the loan stands. */
export async function settleSale(pid: string, before: LoanRow, plan: SalePlan, now: number): Promise<void> {
  if (plan.after.closed) {
    await liftLien(before.seized_plot);
    pushLoan(pid, null, "sale", now);
    return;
  }
  const row = await activeLoan(pid);
  if (row) pushLoan(pid, row, "sale", now);
}

/* ------------------------------------------------ the clock ------------------------------------------------ */

const noticeDue = (r: LoanRow, now: number) => r.notice_at == null && !r.seized_plot && now >= r.due_at + LOAN.noticeAfterDueMin * MIN;

/** The property the bank takes: a business before a house, and the one that cost the most first. Plots already under lien are left alone. */
function lienPick(pid: string): string | null {
  const mine = Object.entries(plots).filter(([, p]) => p.ownerId === pid && !p.seized);
  mine.sort(([ia, a], [ib, b]) => Number(!!b.biz) - Number(!!a.biz) || paidValue(ib, b) - paidValue(ia, a) || (ia < ib ? -1 : 1));
  return mine[0]?.[0] ?? null;
}

/** One step for one loan: at most one change of stage per call, so each is its own message to the player. */
async function step(id: number, pid: string, now: number): Promise<void> {
  let row = await activeLoan(pid);
  if (!row || row.id !== id) return;

  if (row.seized_plot) {
    // keep the lien true to the loan: a plot that is gone ends it (the countdown starts again), a flag that was lost is put back
    const p = plots[row.seized_plot];
    if (!p || p.ownerId !== pid) {
      row = (await updateLoan(id, { notice_at: now, seized_plot: null })) ?? row;
      pushLoan(pid, row, "notice", now);
    } else await markPlot(row.seized_plot, true);
    return;
  }
  if (row.stage === "active" && now > row.due_at) {
    row = (await updateLoan(id, { stage: "overdue" })) ?? row;
    pushLoan(pid, row, "overdue", now);
    return;
  }
  // a notice or a lien only reaches a player who is online: offline time does not count
  if (!isOnline(pid)) return;
  if (noticeDue(row, now)) {
    row = (await updateLoan(id, { stage: "notice", notice_at: now })) ?? row;
    pushLoan(pid, row, "notice", now);
    return;
  }
  if (row.notice_at != null && now >= row.notice_at + LOAN.seizeAfterNoticeMin * MIN && owedNow(mathOf(row), now) > LOAN.seizeFloor) {
    const pick = lienPick(pid);
    if (!pick) return;
    row = (await updateLoan(id, { stage: "seized", seized_plot: pick })) ?? row;
    await markPlot(pick, true);
    pushLoan(pid, row, "seized", now);
  }
}

/** Every 15 seconds: late stages, final notices and liens. */
export async function tickLoans(now = Date.now()): Promise<void> {
  if (!config.loans) return;
  for (const l of await activeLoans()) {
    try {
      await withPidLock(l.pid, () => step(l.id, l.pid, now));
    } catch (e) {
      console.error("[loans] tick", l.id, e);
    }
  }
}

/* ------------------------------------------------ boot and connect ------------------------------------------------ */

/** Make the liens on the plots match the loan rows (the loan is the record). With LOANS off no plot is under lien. */
export async function initLoans(): Promise<void> {
  const want = new Set<string>();
  if (config.loans) for (const l of await activeLoans()) if (l.seized_plot) want.add(l.seized_plot);
  for (const [id, p] of Object.entries(plots)) {
    if (!!p.seized === want.has(id)) continue;
    if (want.has(id)) p.seized = true;
    else delete p.seized;
    await setPlotSeized(id, want.has(id));
  }
}

/** First connect: the player's loan (or null) replaces whatever their device remembers; a final notice that fell due while they were away is served now. */
export async function onLoanConnect(c: Client): Promise<void> {
  if (!config.loans) return;
  const pid = c.info.pid;
  const now = Date.now();
  try {
    await withPidLock(pid, async () => {
      let row = await activeLoan(pid);
      let why: LoanWhy = "sync";
      if (row && row.stage === "active" && now > row.due_at) row = (await updateLoan(row.id, { stage: "overdue" })) ?? row;
      if (row && noticeDue(row, now)) {
        row = (await updateLoan(row.id, { stage: "notice", notice_at: now })) ?? row;
        why = "notice";
      }
      pushLoan(pid, row ?? null, why, now);
    });
  } catch (e) {
    console.error("[loans] connect", pid, e);
  }
}

/* ------------------------------------------------ moderators ------------------------------------------------ */

export async function adminLoans(status: "active" | "closed", now = Date.now()) {
  return (await loansWithNames(status)).map((r) => ({
    id: r.id, pid: r.pid, name: r.name, status: r.status, principal: r.principal, left: r.unpaid, interest: r.interest,
    owed: r.status === "active" ? owedNow(mathOf(r), now) : 0, takenAt: r.taken_at, dueAt: r.due_at, stage: viewOf(r, now).stage,
    noticeAt: r.notice_at, seizedPlot: r.seized_plot, closedAt: r.closed_at, closedBy: r.closed_by,
  }));
}

/** Close a player's loan without payment, lift the lien, and tell them. */
export function forgiveLoan(pid: string, now = Date.now()): Promise<Result<{ id: number }>> {
  return withPidLock(pid, async () => {
    const row = await activeLoan(pid);
    if (!row) return fail(404, "LOAN_NONE", "That player has no loan.");
    await closeLoan(row.id, "forgiven", now);
    await liftLien(row.seized_plot);
    pushLoan(pid, null, "forgiven", now);
    return done({ id: row.id });
  });
}

/** Take a lien off a plot. The loan goes back to the notice stage with a fresh countdown, so the bank does not take another property at once. */
export async function unseizePlot(plotId: string, now = Date.now()): Promise<Result<{ plotId: string }>> {
  const owner = Object.hasOwn(plots, plotId) ? plots[plotId].ownerId : null;
  if (!owner) return fail(404, "NO_PLOT", "There is no such plot.");
  return withPidLock(owner, async () => {
    await markPlot(plotId, false);
    const row = await activeLoan(owner);
    if (row?.seized_plot === plotId) {
      const next = await updateLoan(row.id, { notice_at: now, seized_plot: null });
      if (next) pushLoan(owner, next, "notice", now);
    }
    return done({ plotId });
  });
}
