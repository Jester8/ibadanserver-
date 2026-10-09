// server/scripts/money.test.ts: npm test. Loans, liens and selling land, with no network and no server: the functions are called
// directly with an injected `now`, a throw-away PGlite directory and fake sockets. LOCAL_DB_DIR is set BEFORE the database modules load.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { after, before, beforeEach, describe, test } from "node:test";
import type { WebSocket } from "ws";
import { MIN, STATE } from "../../src/lib/custodyRules";
import { LOAN, owedAfter, owedNow, saleValue } from "../../src/lib/moneyRules";
import type { LoanView, PlotState, S2C } from "../../src/lib/protocol";
import type { Result } from "../../src/lib/socialRules";
import type { Client } from "../presence";
import type { SaleDeps } from "../property";

const dir = mkdtempSync(join(tmpdir(), "omo-money-"));
process.env.LOCAL_DB_DIR = dir;
process.env.LOANS = "1";
process.env.PLOT_SALES = "1";
delete process.env.DATABASE_URL;

type Mods = {
  db: typeof import("../db");
  repo: typeof import("../db/repo");
  rm: typeof import("../db/repoMoney");
  loans: typeof import("../loans");
  property: typeof import("../property");
  http: typeof import("../http/loans");
  auth: typeof import("../http/auth");
  presence: typeof import("../presence");
  config: typeof import("../config");
};
let M: Mods;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => M.db.db.query<T>(sql, params);

before(async () => {
  M = {
    db: await import("../db"), repo: await import("../db/repo"), rm: await import("../db/repoMoney"), loans: await import("../loans"),
    property: await import("../property"), http: await import("../http/loans"), auth: await import("../http/auth"),
    presence: await import("../presence"), config: await import("../config"),
  };
  await M.db.migrate();
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  M.config.config.loans = true;
  M.config.config.plotSales = true;
  M.presence.clients.clear();
  await q("UPDATE loans SET status = 'closed', closed_at = 0, closed_by = 'paid' WHERE status = 'active'");
});

/* ------------------------------------------------------------ fixtures ------------------------------------------------------------ */

/** A whole minute, so every time below is easy to read. */
const T0 = Date.UTC(2026, 9, 9, 10, 0, 0);
let counter = 0;

/** A real account that is `ageMin` minutes old at `at`, whose last cloud save says `rep`. */
async function player(o: { rep?: number; ageMin?: number; at?: number } = {}): Promise<string> {
  const n = ++counter;
  const pid = `testpid${String(n).padStart(4, "0")}`;
  await M.repo.createVerifiedPlayer(pid, `Player${n}`, `${pid}@example.test`, null, `user${n}`, null);
  await q("UPDATE players SET created_at = $2 WHERE pid = $1", [pid, (o.at ?? T0) - (o.ageMin ?? 120) * MIN]);
  if (o.rep !== undefined) await M.repo.putState(pid, `Player${n}`, { rep: o.rep });
  return pid;
}

/** A fake connection, registered like a real one. */
function connect(pid: string, room = "streets") {
  const sent: S2C[] = [];
  const ws = { readyState: 1, send: (d: string) => void sent.push(JSON.parse(d)) } as unknown as WebSocket;
  const id = `conn${++counter}`;
  const client: Client = {
    ...M.presence.socialFields(), ws, info: { id, pid, name: pid, look: {} as never, room, x: 0, z: 0, ry: 0 }, moved: false, speed: 0, voiceRoom: null,
    lastChat: 0, lastPhoto: 0, lastImg: 0, lastListen: 0, lastInvite: 0, lastKnock: 0, sit: null, doing: null, lastTyping: 0, lastServe: 0, verified: true,
  };
  M.presence.clients.set(id, client);
  return { sent, id, client, drop: () => void M.presence.clients.delete(id), enter: (r: string) => void (client.info.room = r) };
}
const of = <K extends S2C["t"]>(sent: S2C[], t: K) => sent.filter((m): m is Extract<S2C, { t: K }> => m.t === t);
const last = <K extends S2C["t"]>(sent: S2C[], t: K) => of(sent, t).at(-1);
const quiet = (c: { sent: S2C[] }) => void (c.sent.length = 0);

/** A plot in memory and in the database. */
let plotN = 100;
async function plot(owner: string, district: string, o: Partial<PlotState> = {}): Promise<string> {
  const id = `${district}-${++plotN}`;
  const p: PlotState = { ownerId: owner, ownerName: "Owner", tier: 1, collectedAt: T0, visit: "ask", ...o };
  M.presence.plots[id] = p;
  await M.repo.savePlot(id, p);
  return id;
}
const plotRow = async (id: string) => (await q<{ owner_pid: string; seized: number }>("SELECT owner_pid, seized FROM plots WHERE plot_id = $1", [id]))[0];
const ledger = (pid: string) => q<{ id: number; from_pid: string; to_pid: string; amount: number; note: string; kind: string; debited: number; claimed: number; plot: string | null; at: number }>("SELECT * FROM transfers WHERE from_pid = $1 OR to_pid = $1 ORDER BY id", [pid]);
const loanRows = (pid: string) => q<{ id: number; status: string; stage: string; unpaid: number; interest: number; notice_at: number | null; seized_plot: string | null; closed_by: string | null; closed_at: number | null }>("SELECT * FROM loans WHERE pid = $1 ORDER BY id", [pid]);

const take = async (pid: string, amount: number, term: number, now: number) => {
  const r = await M.loans.takeLoan(pid, amount, term, now);
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.error}`);
  return r.data;
};
const refused = (r: Result<unknown>, status: number, code: string) => {
  assert.ok(!r.ok, "expected a refusal");
  assert.deepEqual([r.status, r.code], [status, code], r.error);
};

/** Move a real-time loan back, the way manual QA does with SQL. */
const shiftLoan = (pid: string, cols: { dueAgoMin?: number; noticeAgoMin?: number }) => {
  const now = Date.now();
  return q("UPDATE loans SET due_at = COALESCE($2, due_at), notice_at = COALESCE($3, notice_at), stage = CASE WHEN $3::float8 IS NOT NULL THEN 'notice' ELSE stage END WHERE pid = $1 AND status = 'active'", [
    pid, cols.dueAgoMin === undefined ? null : now - cols.dueAgoMin * MIN, cols.noticeAgoMin === undefined ? null : now - cols.noticeAgoMin * MIN,
  ]);
};

/* ------------------------------------------------------------ the database ------------------------------------------------------------ */

describe("loan rows", () => {
  test("a second active loan is refused by the database and writes nothing; a closed loan lets a new one in", async () => {
    const pid = await player();
    const mk = (note: string) => M.rm.insertLoan({ pid, amount: 5_000, accruedAt: T0, takenAt: T0, dueAt: T0 + 60 * MIN, rateBpm: 10, note });
    const [a, b] = await Promise.all([mk("one"), mk("two")]);
    assert.equal([a, b].filter(Boolean).length, 1, "exactly one of two simultaneous loans is written");
    assert.equal((await loanRows(pid)).length, 1);
    assert.equal((await ledger(pid)).length, 1, "the refused loan paid out nothing");
    const won = (a ?? b)!;
    await M.rm.closeLoan(won.loan.id, "paid", T0 + MIN);
    const again = await mk("three");
    assert.ok(again, "after a loan is closed a new one is allowed");
    assert.equal((await loanRows(pid)).length, 2);
  });

  test("a payment that works from a stale row writes nothing", async () => {
    const pid = await player();
    const made = (await M.rm.insertLoan({ pid, amount: 10_000, accruedAt: T0, takenAt: T0, dueAt: T0 + 60 * MIN, rateBpm: 10, note: "x" }))!;
    const stale = { ...made.loan, unpaid: made.loan.unpaid + 1 };
    assert.equal(await M.rm.payLoanRow(stale, { unpaid: 0, interest: 0, accruedAt: T0, lateFee: false }, 10_001, "paid", T0, "Loan repayment"), null);
    assert.equal((await loanRows(pid))[0].status, "active");
    assert.equal((await ledger(pid)).length, 1);
  });
});

/* ------------------------------------------------------------ what a player may borrow ------------------------------------------------------------ */

describe("the offer", () => {
  test("limits follow the title and the property, as in the plan", async () => {
    const none = await player({ rep: 0 });
    assert.equal((await M.loans.offerFor(none, T0)).limit, 10_000);
    const jagun = await player({ rep: 70 });
    const o1 = await M.loans.offerFor(jagun, T0);
    assert.deepEqual([o1.limit, o1.titleBase, o1.collateral, o1.titleIdx, o1.blocked], [50_000, 50_000, 0, 2, null]);
    const withHouse = await player({ rep: 70 });
    await plot(withHouse, "bodija-estate", { tier: 1 });
    const o2 = await M.loans.offerFor(withHouse, T0);
    assert.deepEqual([o2.limit, o2.collateral], [128_000, 195_000]);
    const rich = await player({ rep: 800 });
    await plot(rich, "dugbe", { biz: "mart", tier: 1 });
    await plot(rich, "dugbe", { biz: "mart", tier: 1 });
    await plot(rich, "jericho-gra", { tier: 3 });
    assert.equal((await M.loans.offerFor(rich, T0)).limit, 400_000);
    const noSave = await player();
    assert.equal((await M.loans.offerFor(noSave, T0)).limit, 10_000, "no cloud save counts as no reputation");
  });

  test("a plot under lien is not collateral", async () => {
    const pid = await player({ rep: 70 });
    const id = await plot(pid, "bodija-estate", { tier: 1 });
    assert.equal((await M.loans.offerFor(pid, T0)).limit, 128_000);
    M.presence.plots[id].seized = true;
    assert.equal((await M.loans.offerFor(pid, T0)).limit, 50_000);
  });

  test("the reasons it is blocked, in the order the rules check them", async () => {
    const pid = await player({ rep: 70, ageMin: 10 });
    const young = await M.loans.offerFor(pid, T0);
    assert.equal(young.blocked?.code, "TOO_NEW");
    assert.equal(young.blocked?.until, T0 - 10 * MIN + LOAN.minAccountAgeMs);
    assert.equal((await M.loans.offerFor(pid, T0 + 20 * MIN)).blocked, null, "old enough exactly 30 minutes after sign-up");
    assert.equal((await M.loans.offerFor(pid, T0 + 20 * MIN - 1)).blocked?.code, "TOO_NEW");
    M.config.config.loans = false;
    assert.equal((await M.loans.offerFor(pid, T0)).blocked?.code, "OFF", "the switch is checked before anything else");
    M.config.config.loans = true;
    const old = await player({ rep: 70 });
    await take(old, 5_000, 60, T0);
    assert.equal((await M.loans.offerFor(old, T0 + 10 * MIN)).blocked?.code, "LOAN_ACTIVE");
  });

  test("the worked example in the plan: 50,000 for 3 hours", () => {
    assert.deepEqual([0, 60, 180, 181, 240, 100_000].map((m) => owedAfter(50_000, 180, m)), [50_000, 53_000, 59_000, 61_600, 67_500, 100_000]);
  });
});

/* ------------------------------------------------------------ taking a loan ------------------------------------------------------------ */

describe("taking a loan", () => {
  test("the cash is a ledger credit from the bank, the loan is saved, the player is told", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const r = await take(pid, 50_000, 180, T0 + 30_000);
    assert.equal(r.loan.principal, 50_000);
    assert.equal(r.loan.left, 50_000);
    assert.equal(r.loan.interest, 0);
    assert.equal(r.loan.takenAt, T0 + 30_000);
    assert.equal(r.loan.at, T0 + MIN, "interest starts at the next whole minute");
    assert.equal(r.loan.dueAt, T0 + 30_000 + 180 * MIN);
    assert.equal(r.loan.stage, "active");
    assert.equal(r.loan.rateBpm, LOAN.rateBpm);
    const rows = await ledger(pid);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].from_pid, rows[0].to_pid, rows[0].amount, rows[0].kind, rows[0].debited, rows[0].claimed], [STATE.bank, pid, 50_000, "loan", 1, 0]);
    assert.equal(rows[0].note, "Loan: ₦50,000 for 3 hours");
    const credit = last(me.sent, "credit")!;
    assert.deepEqual([credit.id, credit.amount, credit.from, credit.note], [rows[0].id, 50_000, "Omo'badan Bank", rows[0].note]);
    const pushed = last(me.sent, "loan")!;
    assert.equal(pushed.why, "take");
    assert.deepEqual(pushed.loan, r.loan);
    const stored = (await loanRows(pid))[0];
    assert.deepEqual([stored.status, stored.unpaid, stored.stage], ["active", 50_000, "active"]);
  });


  test("every refusal has its status and code, and no money moves", async () => {
    const pid = await player({ rep: 70 });
    let now = T0;
    const t = (a: unknown, term: unknown) => M.loans.takeLoan(pid, a, term, (now += 3_000));
    refused(await t(4_000, 180), 400, "LOAN_MIN");
    refused(await t(-5_000, 180), 400, "LOAN_MIN");
    refused(await t(5_500, 180), 400, "BAD");
    refused(await t("50000", 180), 400, "BAD");
    refused(await t(5_000.5, 180), 400, "BAD");
    refused(await t(null, 180), 400, "BAD");
    refused(await t(5_000, 120), 400, "LOAN_TERM");
    refused(await t(5_000, "180"), 400, "LOAN_TERM");
    refused(await t(51_000, 180), 422, "LOAN_LIMIT");
    refused(await t(1e21, 180), 422, "LOAN_LIMIT");
    assert.equal((await ledger(pid)).length, 0);
    assert.equal((await loanRows(pid)).length, 0);
    M.config.config.loans = false;
    refused(await t(5_000, 180), 503, "OFF");
    M.config.config.loans = true;
    refused(await M.loans.takeLoan(await player({ rep: 70, ageMin: 29 }), 5_000, 180, T0), 403, "TOO_NEW");
    refused(await M.loans.takeLoan("nosuchplayer1", 5_000, 180, T0), 403, "TOO_NEW");
    await take(pid, 50_000, 180, (now += 3_000)); // exactly the limit is allowed
    refused(await t(5_000, 180), 409, "LOAN_ACTIVE");
    assert.equal((await ledger(pid)).length, 1);
  });

  test("two requests less than 2 seconds apart: the second is RATE, whatever the first was", async () => {
    const pid = await player({ rep: 70 });
    refused(await M.loans.takeLoan(pid, 4_000, 180, T0), 400, "LOAN_MIN");
    refused(await M.loans.takeLoan(pid, 5_000, 180, T0 + 1_999), 429, "RATE");
    assert.ok((await M.loans.takeLoan(pid, 5_000, 180, T0 + 2_000)).ok);
  });

  test("two simultaneous requests make one loan and one payout", async () => {
    const pid = await player({ rep: 70 });
    const [a, b] = await Promise.all([M.loans.takeLoan(pid, 50_000, 180, T0), M.loans.takeLoan(pid, 50_000, 180, T0 + 5_000)]);
    assert.ok(a.ok);
    refused(b, 409, "LOAN_ACTIVE");
    assert.equal((await ledger(pid)).length, 1);
  });

  test("the loan cash is claimed once, like any credit", async () => {
    const pid = await player({ rep: 70 });
    await take(pid, 10_000, 60, T0);
    const row = (await ledger(pid))[0];
    assert.equal(await M.repo.claimTransfer(row.id, pid), true);
    assert.equal(await M.repo.claimTransfer(row.id, pid), false);
  });
});

/* ------------------------------------------------------------ repaying ------------------------------------------------------------ */

describe("repaying", () => {
  test("interest first, then principal; each payment is one ledger debit that the device takes once", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    await take(pid, 50_000, 180, T0);
    quiet(me);
    const r1 = await M.loans.repayLoan(pid, 20_000, T0 + 60 * MIN);
    assert.ok(r1.ok);
    assert.equal(r1.data.paid, 20_000);
    assert.deepEqual([r1.data.loan?.left, r1.data.loan?.interest, r1.data.loan?.at], [33_000, 0, T0 + 60 * MIN]);
    const deb = (await ledger(pid)).at(-1)!;
    assert.deepEqual([deb.from_pid, deb.to_pid, deb.amount, deb.kind, deb.debited, deb.note], [pid, STATE.bank, 20_000, "repay", 0, "Loan repayment"]);
    assert.deepEqual(last(me.sent, "debit"), { t: "debit", id: deb.id, to: "Omo'badan Bank", amount: 20_000, note: "Loan repayment" });
    assert.equal(last(me.sent, "loan")?.why, "repay");
    assert.equal(last(me.sent, "loan")?.loan?.left, 33_000);
    assert.deepEqual((await loanRows(pid))[0].unpaid, 33_000);

    // an hour later it owes 33,000 and 1,980 interest: asking for far more takes only that
    const r2 = await M.loans.repayLoan(pid, 1_000_000, T0 + 120 * MIN);
    assert.ok(r2.ok);
    assert.equal(r2.data.paid, 34_980);
    assert.equal(r2.data.loan, null);
    assert.equal((await ledger(pid)).at(-1)!.amount, 34_980);
    const done = last(me.sent, "loan")!;
    assert.deepEqual([done.loan, done.why], [null, "cleared"]);
    const stored = (await loanRows(pid))[0];
    assert.deepEqual([stored.status, stored.closed_by, stored.closed_at], ["closed", "paid", T0 + 120 * MIN]);
    assert.equal(await M.repo.markDebited(deb.id, pid), true);
    assert.equal(await M.repo.markDebited(deb.id, pid), false, "the debit is taken from the balance once");
  });

  test("a late loan costs what the rules say: pay-all includes the late fee", async () => {
    const pid = await player({ rep: 70 });
    await take(pid, 50_000, 60, T0);
    const r = await M.loans.repayLoan(pid, 10_000_000, T0 + 61 * MIN);
    assert.ok(r.ok);
    assert.equal(r.data.paid, owedAfter(50_000, 60, 61));
    assert.ok(r.data.paid > 50_000 + 3_000 + 2_500, "one hour of interest, the late fee and a late minute");
    assert.equal(r.data.loan, null);
  });

  test("refusals", async () => {
    const pid = await player({ rep: 70 });
    let now = T0;
    const pay = (a: unknown) => M.loans.repayLoan(pid, a, (now += 3_000));
    refused(await pay(1_000), 404, "LOAN_NONE");
    await take(pid, 20_000, 180, (now += 3_000));
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.5, "5000", null, undefined]) refused(await pay(bad), 400, "BAD");
    M.config.config.loans = false;
    refused(await pay(1_000), 503, "OFF");
    M.config.config.loans = true;
    assert.equal((await ledger(pid)).length, 1, "nothing was charged");
    const good = (now += 3_000);
    assert.ok((await M.loans.repayLoan(pid, 1_000, good)).ok);
    refused(await M.loans.repayLoan(pid, 1_000, good + 1_999), 429, "RATE");
    assert.ok((await M.loans.repayLoan(pid, 1_000, good + 2_000)).ok);
    assert.equal((await ledger(pid)).length, 3, "the loan and the two payments that were accepted");
  });

  test("two pay-alls at once charge the debt once", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    await take(pid, 20_000, 180, T0);
    const [a, b] = await Promise.all([M.loans.repayLoan(pid, 1_000_000, T0 + 10 * MIN), M.loans.repayLoan(pid, 1_000_000, T0 + 10 * MIN + 5_000)]);
    assert.ok(a.ok);
    refused(b, 404, "LOAN_NONE");
    const repays = (await ledger(pid)).filter((r) => r.kind === "repay");
    assert.equal(repays.length, 1);
    assert.equal(of(me.sent, "debit").length, 1);
  });

  test("after paying off there is a 5 minute wait; after a lien there are 60", async () => {
    const pid = await player({ rep: 70 });
    await take(pid, 5_000, 60, T0);
    const paidAt = T0 + MIN;
    assert.ok((await M.loans.repayLoan(pid, 1_000_000, paidAt)).ok);
    const early = await M.loans.takeLoan(pid, 5_000, 60, paidAt + 4 * MIN);
    refused(early, 403, "LOAN_LOCKED");
    assert.equal((await M.loans.offerFor(pid, paidAt + 4 * MIN)).blocked?.until, paidAt + LOAN.cooldownMs);
    assert.ok((await M.loans.takeLoan(pid, 5_000, 60, paidAt + 5 * MIN)).ok);

    const liened = await player({ rep: 70 });
    const home = await plot(liened, "bodija-estate", { tier: 1 });
    connect(liened);
    await take(liened, 50_000, 60, T0);
    const due = T0 + 60 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    assert.equal(M.presence.plots[home].seized, true);
    const cleared = due + 70 * MIN;
    assert.ok((await M.loans.repayLoan(liened, 10_000_000, cleared)).ok);
    refused(await M.loans.takeLoan(liened, 5_000, 60, cleared + 59 * MIN), 403, "LOAN_LOCKED");
    assert.ok((await M.loans.takeLoan(liened, 5_000, 60, cleared + 60 * MIN)).ok);
  });
});

/* ------------------------------------------------------------ the clock ------------------------------------------------------------ */

describe("the clock", () => {
  const tick = (now?: number) => M.loans.tickLoans(now);
  const loanOf = async (pid: string) => (await loanRows(pid))[0];
  /** Walk a 3 hour loan taken at T0 to the moment the lien falls due; returns that moment. */
  async function toLien(pid: string, term = 180) {
    const due = T0 + term * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await tick(t);
    return due + 60 * MIN;
  }

  test("overdue, then the final notice, then the lien: one stage per tick, and a business goes first", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const house = await plot(pid, "bodija-estate", { tier: 3 });
    const salon = await plot(pid, "agbowo", { biz: "salon", tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    quiet(me);

    await tick(due);
    assert.equal(me.sent.length, 0, "on the dot is not late");
    await tick(due + MIN);
    assert.equal(of(me.sent, "loan").length, 1);
    assert.deepEqual([last(me.sent, "loan")!.why, last(me.sent, "loan")!.loan!.stage], ["overdue", "overdue"]);
    assert.equal((await loanOf(pid)).stage, "overdue");
    await tick(due + MIN + 15_000);
    await tick(due + 29 * MIN);
    assert.equal(of(me.sent, "loan").length, 1, "quiet until the notice is due");
    await tick(due + 30 * MIN);
    const n = last(me.sent, "loan")!;
    assert.deepEqual([n.why, n.loan!.stage, n.loan!.noticeAt], ["notice", "notice", due + 30 * MIN]);
    assert.equal((await loanOf(pid)).notice_at, due + 30 * MIN);
    await tick(due + 59 * MIN);
    assert.equal(M.presence.plots[salon].seized, undefined);

    quiet(me);
    await tick(due + 60 * MIN);
    const s = last(me.sent, "loan")!;
    assert.deepEqual([s.why, s.loan!.stage, s.loan!.seizedPlot], ["seized", "seized", salon]);
    assert.equal(M.presence.plots[salon].seized, true);
    assert.equal(M.presence.plots[house].seized, undefined);
    assert.equal((await plotRow(salon)).seized, 1);
    assert.equal((await plotRow(house)).seized, 0);
    const shown = last(me.sent, "plot")!;
    assert.deepEqual([shown.plotId, shown.plot.seized], [salon, true]);
    const row = await loanOf(pid);
    assert.deepEqual([row.stage, row.seized_plot], ["seized", salon]);
    quiet(me);
    await tick(due + 90 * MIN);
    assert.equal(me.sent.length, 0, "one lien, never more");
  });

  test("a player who is offline gets neither a notice nor a lien until they are back", async () => {
    const pid = await player({ rep: 70 });
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    await tick(due + MIN);
    assert.equal((await loanOf(pid)).stage, "overdue", "lateness is recorded whether or not they are watching");
    const away = due + 24 * 60 * MIN;
    await tick(due + 30 * MIN);
    await tick(away);
    assert.equal((await loanOf(pid)).notice_at, null);

    const back = connect(pid);
    await tick(away + 15_000);
    assert.equal(last(back.sent, "loan")!.why, "notice");
    back.drop();
    await tick(away + 15_000 + 30 * MIN);
    assert.equal(M.presence.plots[home].seized, undefined, "offline when the lien fell due: no lien");
    const again = connect(pid);
    await tick(away + 15_000 + 31 * MIN);
    assert.equal(last(again.sent, "loan")!.why, "seized");
    assert.equal(M.presence.plots[home].seized, true);
  });

  test("no lien over a debt of 2,000 or less; one naira more and there is one", async () => {
    for (const [leave, lien] of [[LOAN.seizeFloor, false], [LOAN.seizeFloor + 1, true]] as const) {
      const pid = await player({ rep: 70 });
      connect(pid);
      const home = await plot(pid, "bodija-estate", { tier: 1 });
      await take(pid, 50_000, 60, T0);
      const due = T0 + 60 * MIN;
      await tick(due + MIN);
      await tick(due + 30 * MIN);
      const at = due + 60 * MIN;
      const owed = owedNow(M.loans.mathOf((await M.rm.activeLoan(pid))!), at);
      assert.ok((await M.loans.repayLoan(pid, owed - leave, at)).ok);
      await tick(at);
      assert.equal(M.presence.plots[home].seized, lien ? true : undefined, `owing ${leave}`);
      assert.equal((await loanOf(pid)).stage, lien ? "seized" : "notice");
    }
  });

  test("with nothing to take the loan waits at the notice; the bank never takes the plots of someone else", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const stranger = await player();
    const theirs = await plot(stranger, "bodija-estate", { tier: 3 });
    await take(pid, 50_000, 180, T0);
    const at = await toLien(pid);
    await tick(at + MIN);
    assert.equal(M.presence.plots[theirs].seized, undefined);
    const row = await loanOf(pid);
    assert.deepEqual([row.stage, row.seized_plot], ["notice", null]);
    assert.equal(last(me.sent, "loan")!.why, "notice");
  });

  test("a part payment keeps the lien; paying it all lifts it at once and tells everyone", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const watcher = connect(await player());
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const at = await toLien(pid);
    assert.equal(M.presence.plots[home].seized, true);
    quiet(me);
    quiet(watcher);

    const part = await M.loans.repayLoan(pid, 1_000, at + MIN);
    assert.ok(part.ok);
    assert.equal(part.data.loan?.stage, "seized");
    assert.equal(M.presence.plots[home].seized, true);
    assert.equal(of(watcher.sent, "plot").length, 0);

    const all = await M.loans.repayLoan(pid, 10_000_000, at + 2 * MIN);
    assert.ok(all.ok);
    assert.equal(M.presence.plots[home].seized, undefined);
    assert.equal((await plotRow(home)).seized, 0);
    const shown = last(watcher.sent, "plot")!;
    assert.deepEqual([shown.plotId, shown.plot.seized], [home, undefined]);
    const told = last(me.sent, "loan")!;
    assert.deepEqual([told.loan, told.why], [null, "cleared"]);
    const row = await loanOf(pid);
    assert.deepEqual([row.status, row.closed_by, row.stage], ["closed", "paid", "seized"]);
  });

  test("each tick keeps the lien true to the loan", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const at = await toLien(pid);

    // a flag that was lost (the owner's own update replaced the plot) is put back
    M.presence.plots[home] = { ...M.presence.plots[home], seized: undefined };
    await tick(at + 15_000);
    assert.equal(M.presence.plots[home].seized, true);
    assert.equal((await plotRow(home)).seized, 1);

    // a plot that no longer exists ends the lien and starts the countdown again
    delete M.presence.plots[home];
    quiet(me);
    await tick(at + 30_000);
    const row = await loanOf(pid);
    assert.deepEqual([row.stage, row.seized_plot, row.notice_at], ["seized", null, at + 30_000]);
    assert.deepEqual([last(me.sent, "loan")!.why, last(me.sent, "loan")!.loan!.stage], ["notice", "notice"]);
    quiet(me);
    await tick(at + 45_000);
    assert.equal(me.sent.length, 0);
  });

  test("with LOANS off the clock stands still and nothing is under lien; switching it on again restores the liens", async () => {
    const pid = await player({ rep: 70 });
    connect(pid);
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const at = await toLien(pid);
    assert.equal(M.presence.plots[home].seized, true);

    M.config.config.loans = false;
    await tick(at + 1000 * MIN);
    assert.equal((await loanOf(pid)).stage, "seized");
    await M.loans.initLoans();
    assert.equal(M.presence.plots[home].seized, undefined);
    assert.equal((await plotRow(home)).seized, 0);

    M.config.config.loans = true;
    await M.loans.initLoans();
    assert.equal(M.presence.plots[home].seized, true);
    assert.equal((await plotRow(home)).seized, 1);
  });

  test("at boot the liens match the loans: a stray flag goes, a missing one comes back", async () => {
    const pid = await player({ rep: 70 });
    const stray = await plot(pid, "bodija-estate", { tier: 1, seized: true });
    await M.rm.setPlotSeized(stray, true);
    const lost = await plot(pid, "bodija-estate", { tier: 1 });
    const made = await take(pid, 50_000, 180, T0);
    await M.rm.updateLoan(made.loan.id, { stage: "seized", seized_plot: lost });
    await M.loans.initLoans();
    assert.equal(M.presence.plots[stray].seized, undefined);
    assert.equal((await plotRow(stray)).seized, 0);
    assert.equal(M.presence.plots[lost].seized, true);
    assert.equal((await plotRow(lost)).seized, 1);
  });

  test("manual QA: set due_at back with SQL and tick twice with an online client: overdue, then the final notice, then a lien", async () => {
    const pid = await player({ rep: 70, at: Date.now() });
    const me = connect(pid);
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, Date.now());
    await shiftLoan(pid, { dueAgoMin: 31 });
    quiet(me);
    await tick();
    await tick();
    assert.deepEqual(of(me.sent, "loan").map((m) => m.why), ["overdue", "notice"]);
    await shiftLoan(pid, { noticeAgoMin: 31 });
    await tick();
    assert.equal(last(me.sent, "loan")!.why, "seized");
    assert.equal(M.presence.plots[home].seized, true);
  });
});

/* ------------------------------------------------------------ connecting ------------------------------------------------------------ */

describe("connecting", () => {
  test("the player is told their loan, or that they have none", async () => {
    const none = connect(await player({ rep: 70 }));
    await M.loans.onLoanConnect(none.client);
    assert.deepEqual(of(none.sent, "loan").map((m) => [m.loan, m.why]), [[null, "sync"]]);

    const pid = await player({ rep: 70, at: Date.now() });
    const made = await take(pid, 20_000, 180, Date.now());
    const me = connect(pid);
    await M.loans.onLoanConnect(me.client);
    const m = last(me.sent, "loan")!;
    assert.equal(m.why, "sync");
    assert.deepEqual(m.loan, M.loans.viewOf((await M.rm.activeLoan(pid))!, m.now));
    assert.equal(m.loan!.id, made.loan.id);
  });

  test("lateness is recorded on connect; a final notice that fell due while they were away is served once", async () => {
    const pid = await player({ rep: 70, at: Date.now() });
    await take(pid, 20_000, 180, Date.now());
    await shiftLoan(pid, { dueAgoMin: 10 });
    const first = connect(pid);
    await M.loans.onLoanConnect(first.client);
    assert.deepEqual([last(first.sent, "loan")!.why, last(first.sent, "loan")!.loan!.stage], ["sync", "overdue"]);
    assert.equal((await loanRows(pid))[0].stage, "overdue");
    first.drop();

    await shiftLoan(pid, { dueAgoMin: 45 });
    const second = connect(pid);
    const before = Date.now();
    await M.loans.onLoanConnect(second.client);
    const served = last(second.sent, "loan")!;
    assert.deepEqual([served.why, served.loan!.stage], ["notice", "notice"]);
    const noticeAt = (await loanRows(pid))[0].notice_at!;
    assert.ok(noticeAt >= before && noticeAt <= Date.now());
    second.drop();

    const third = connect(pid);
    await M.loans.onLoanConnect(third.client);
    assert.equal(last(third.sent, "loan")!.why, "sync", "served once");
    assert.equal(last(third.sent, "loan")!.loan!.noticeAt, noticeAt);
  });

  test("with LOANS off nothing is sent", async () => {
    M.config.config.loans = false;
    const me = connect(await player({ rep: 70 }));
    await M.loans.onLoanConnect(me.client);
    assert.equal(me.sent.length, 0);
  });
});

/* ------------------------------------------------------------ selling land ------------------------------------------------------------ */

describe("selling land", () => {
  const sell = (pid: string, id: string, now = T0, deps?: SaleDeps) => M.property.sellPlot(pid, id, now, deps);
  const gone = async (id: string) => assert.ok(!(id in M.presence.plots) && (await plotRow(id)) === undefined, "the plot is free land");
  /** Nothing happened: the plot is still its owner's, no money moved, nobody was told, and it can still be claimed by its owner. */
  async function untouched(pid: string, id: string, watchers: { sent: S2C[] }[] = []) {
    assert.equal(M.presence.plots[id]?.ownerId !== undefined, true);
    assert.equal((await plotRow(id))?.owner_pid !== undefined, true);
    assert.equal((await ledger(pid)).filter((r) => r.kind === "landsale" || r.kind === "repay").length, 0);
    assert.equal(M.property.claimBlocked(id, pid, 0), false);
    for (const w of watchers) assert.equal(of(w.sent, "plotFree").length, 0);
  }

  test("the price comes from the shared tables; with no loan the player gets all of it, and everyone learns the plot is free", async () => {
    const pid = await player();
    const me = connect(pid);
    const other = connect(await player());
    const id = await plot(pid, "bodija-estate", { tier: 3, decor: ["plant", "plant", "plant"] });
    const expected = saleValue(id, M.presence.plots[id]);
    assert.equal(expected.gross, 240_000);
    const r = await sell(pid, id);
    assert.ok(r.ok);
    assert.deepEqual(r.data, { plotId: id, gross: 240_000, loanPaid: 0, net: 240_000, repBack: 58, now: T0 });
    await gone(id);
    const rows = await ledger(pid);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].from_pid, rows[0].to_pid, rows[0].amount, rows[0].kind, rows[0].debited, rows[0].note, rows[0].plot], [STATE.city, pid, 240_000, "landsale", 1, "Land sale: Bodija Estate", id]);
    const credit = last(me.sent, "credit")!;
    assert.deepEqual([credit.id, credit.amount, credit.from, credit.note], [rows[0].id, 240_000, "Ibadan City Council", "Land sale: Bodija Estate"]);
    assert.deepEqual(of(me.sent, "plotFree"), [{ t: "plotFree", plotId: id }]);
    assert.deepEqual(of(other.sent, "plotFree"), [{ t: "plotFree", plotId: id }]);
    assert.equal(of(me.sent, "loan").length, 0, "no loan, no loan message");
    assert.deepEqual(await q("SELECT by_pid, at FROM plot_releases WHERE plot_id = $1", [id]), [{ by_pid: pid, at: T0 }]);
  });

  test("with a loan the bank is paid first; clearing the debt lifts a lien on another property", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const big = await plot(pid, "jericho-gra", { tier: 3 });
    const sold = await plot(pid, "bodija-estate", { tier: 3, decor: ["plant", "plant", "plant"] });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    assert.equal(M.presence.plots[big].seized, true, "the bank took the more expensive one");
    quiet(me);

    const at = due + 70 * MIN;
    const owed = owedNow(M.loans.mathOf((await M.rm.activeLoan(pid))!), at);
    const r = await sell(pid, sold, at);
    assert.ok(r.ok);
    assert.deepEqual([r.data.gross, r.data.loanPaid, r.data.net], [240_000, owed, 240_000 - owed]);
    const rows = (await ledger(pid)).filter((x) => x.kind === "landsale" || x.kind === "repay");
    assert.deepEqual(rows.map((x) => [x.from_pid, x.to_pid, x.amount, x.kind, x.debited, x.note]), [
      [STATE.city, pid, 240_000 - owed, "landsale", 1, "Land sale: Bodija Estate"],
      [pid, STATE.bank, owed, "repay", 1, "Loan repaid from the sale of Bodija Estate"],
    ]);
    const row = (await loanRows(pid))[0];
    assert.deepEqual([row.status, row.closed_by, row.closed_at], ["closed", "sale", at]);
    assert.equal(M.presence.plots[big].seized, undefined, "the debt is paid, so the lien goes");
    assert.equal((await plotRow(big)).seized, 0);
    assert.equal(last(me.sent, "credit")!.amount, 240_000 - owed);
    assert.deepEqual([last(me.sent, "loan")!.loan, last(me.sent, "loan")!.why], [null, "sale"]);
    assert.equal(of(me.sent, "debit").length, 0, "no cash moves for the part that goes to the bank");
  });

  test("selling the property under lien pays the bank what it can; the debt left starts 30 new minutes before another property is touched", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const mansion = await plot(pid, "bodija-estate", { tier: 3 });
    const salon = await plot(pid, "agbowo", { biz: "salon", tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    assert.equal(M.presence.plots[salon].seized, true);
    quiet(me);

    const at = due + 65 * MIN;
    const before = owedNow(M.loans.mathOf((await M.rm.activeLoan(pid))!), at);
    const r = await sell(pid, salon, at);
    assert.ok(r.ok);
    assert.deepEqual([r.data.gross, r.data.loanPaid, r.data.net, r.data.repBack], [49_500, 49_500, 0, 20]);
    assert.deepEqual((await ledger(pid)).map((x) => x.kind), ["loan", "repay"], "nothing was left to pay the player");
    const row = (await loanRows(pid))[0];
    assert.deepEqual([row.status, row.stage, row.notice_at, row.seized_plot], ["active", "seized", at, null], "the stage is the furthest reached; the player is shown the notice");
    assert.equal(owedNow(M.loans.mathOf((await M.rm.activeLoan(pid))!), at), before - 49_500);
    const told = last(me.sent, "loan")!;
    assert.deepEqual([told.why, told.loan!.stage, told.loan!.noticeAt, told.loan!.seizedPlot], ["sale", "notice", at, null]);
    assert.equal(of(me.sent, "credit").length, 0);

    await M.loans.tickLoans(at + 29 * MIN);
    assert.equal(M.presence.plots[mansion].seized, undefined);
    await M.loans.tickLoans(at + 30 * MIN);
    assert.equal(M.presence.plots[mansion].seized, true);
    assert.equal(last(me.sent, "loan")!.why, "seized");
  });

  test("a loan that once went to a lien keeps its 60 minute lockout even if a sale lifted that lien", async () => {
    const pid = await player({ rep: 70 });
    connect(pid);
    const salon = await plot(pid, "agbowo", { biz: "salon", tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    assert.ok((await sell(pid, salon, due + 61 * MIN)).ok);
    const cleared = due + 65 * MIN;
    assert.ok((await M.loans.repayLoan(pid, 10_000_000, cleared)).ok);
    refused(await M.loans.takeLoan(pid, 5_000, 60, cleared + 59 * MIN), 403, "LOAN_LOCKED");
    assert.ok((await M.loans.takeLoan(pid, 5_000, 60, cleared + 60 * MIN)).ok);
  });

  test("a business is sold with its staff let go", async () => {
    const pid = await player();
    const staffPid = await player();
    const staff = connect(staffPid);
    const watcher = connect(await player());
    const id = await plot(pid, "oje", { biz: "cafe", tier: 1, staff: [{ pid: staffPid, name: "Staff" }] });
    const r = await sell(pid, id);
    assert.ok(r.ok);
    assert.deepEqual([r.data.gross, r.data.repBack], [75_000, 20]);
    assert.deepEqual(of(staff.sent, "fired"), [{ t: "fired", plotId: id, owner: "Owner", business: "Cafe" }]);
    assert.equal(of(watcher.sent, "fired").length, 0);
    assert.equal(of(staff.sent, "plotFree").length, 1);
  });

  test("every refusal has its status and code, and leaves everything as it was", async () => {
    const pid = await player();
    const me = connect(pid);
    const watcher = connect(await player());
    let now = T0;
    const go = (id: string, deps?: SaleDeps) => sell(pid, id, (now += 5_000), deps);

    const mine = await plot(pid, "bodija-estate", { tier: 1 });
    refused(await go("bodija-estate-9999"), 404, "NO_PLOT");
    refused(await go("__proto__"), 404, "NO_PLOT");
    const theirs = await plot(await player(), "bodija-estate", { tier: 1 });
    refused(await go(theirs), 403, "NOT_OWNER");
    refused(await go(mine, { isHeld: (p) => p === pid }), 403, "FROZEN");
    const unpriced = await plot(pid, "nowhere", { tier: 0 });
    refused(await go(unpriced), 400, "BAD");

    me.enter(`in:home:${mine}`);
    refused(await go(mine), 409, "INSIDE");
    me.enter("streets");
    watcher.enter(`in:home:${mine}`);
    refused(await go(mine), 409, "INSIDE");
    watcher.enter(`in:home:${theirs}`);

    M.config.config.plotSales = false;
    refused(await go(mine), 503, "OFF");
    M.config.config.plotSales = true;

    await untouched(pid, mine, [me, watcher]);
    await untouched(pid, unpriced);
    assert.equal(M.presence.plots[theirs].ownerId !== pid, true);
    assert.ok((await go(mine)).ok, "and with the obstacles gone the sale goes through");
  });

  test("two sales less than 3 seconds apart: the second is RATE", async () => {
    const pid = await player();
    const a = await plot(pid, "moniya", { tier: 1 });
    const b = await plot(pid, "moniya", { tier: 1 });
    assert.ok((await sell(pid, a, T0)).ok);
    refused(await sell(pid, b, T0 + 2_999), 429, "RATE");
    assert.ok((await sell(pid, b, T0 + 3_000)).ok);
  });

  test("two simultaneous sales of one plot pay once", async () => {
    const pid = await player();
    const id = await plot(pid, "moniya", { tier: 1 });
    const [a, b] = await Promise.all([sell(pid, id, T0), sell(pid, id, T0 + 5_000)]);
    assert.ok(a.ok);
    refused(b, 404, "NO_PLOT");
    assert.equal((await ledger(pid)).filter((r) => r.kind === "landsale").length, 1);
  });

  test("a sale the database does not complete is undone in memory too", async () => {
    const pid = await player();
    const me = connect(pid);
    const ghost = "moniya-4242";
    M.presence.plots[ghost] = { ownerId: pid, ownerName: "Owner", tier: 1, collectedAt: T0 };
    refused(await sell(pid, ghost), 409, "BAD");
    assert.equal(M.presence.plots[ghost]?.ownerId, pid);
    assert.equal(M.property.claimBlocked(ghost, pid, 0), false);
    assert.equal((await ledger(pid)).length, 0);
    assert.equal(of(me.sent, "plotFree").length, 0);
  });

  test("a sale worked out from a loan that has since changed writes nothing", async () => {
    const pid = await player({ rep: 70 });
    const id = await plot(pid, "moniya", { tier: 1 });
    const made = await take(pid, 20_000, 180, T0);
    const row = (await M.rm.activeLoan(pid))!;
    const plan = M.loans.planSalePayment(row, 31_500, id, T0 + 5 * MIN);
    assert.ok((await M.loans.repayLoan(pid, 1_000, T0 + 6 * MIN)).ok, "the loan moves on before the sale is written");
    const rows = await M.rm.sellPlotRows({ plotId: id, pid, now: T0 + 7 * MIN, net: 31_500 - plan.paid, creditNote: "c", loanPaid: plan.paid, repayNote: "r", loanBefore: row, loanAfter: plan.after });
    assert.equal(rows.freed, false);
    assert.equal((await plotRow(id)).owner_pid, pid);
    assert.equal((await ledger(pid)).filter((r) => r.kind === "landsale").length, 0);
    assert.equal((await loanRows(pid))[0].id, made.loan.id);
    assert.equal((await loanRows(pid))[0].unpaid, 19_120, "the loan is as the payment left it: 120 of interest, then principal");
  });

  test("the quote shows what the sale would pay, and why it cannot be done", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const id = await plot(pid, "bodija-estate", { tier: 3, decor: ["plant", "plant", "plant"] });
    const q1 = await M.property.quoteSale(pid, id, T0);
    assert.ok(q1.ok);
    assert.deepEqual(q1.data, { plotId: id, gross: 240_000, parts: { land: 108_000, built: 127_500, decor: 4_500 }, loanPaid: 0, net: 240_000, repBack: 58, blocked: null, now: T0 });

    await take(pid, 50_000, 180, T0);
    const owed = owedNow(M.loans.mathOf((await M.rm.activeLoan(pid))!), T0 + 60 * MIN);
    const q2 = await M.property.quoteSale(pid, id, T0 + 60 * MIN);
    assert.ok(q2.ok);
    assert.deepEqual([q2.data.loanPaid, q2.data.net, owed], [53_000, 187_000, 53_000]);
    const sold = await sell(pid, id, T0 + 60 * MIN);
    assert.ok(sold.ok);
    assert.deepEqual([sold.data.gross, sold.data.loanPaid, sold.data.net, sold.data.repBack], [q2.data.gross, q2.data.loanPaid, q2.data.net, q2.data.repBack], "the quote and the sale agree");

    const again = await plot(pid, "bodija-estate", { tier: 1 });
    me.enter(`in:home:${again}`);
    const q3 = await M.property.quoteSale(pid, again, T0);
    assert.ok(q3.ok);
    assert.deepEqual([q3.data.blocked?.code, q3.data.gross], ["INSIDE", saleValue(again, M.presence.plots[again]).gross]);
    const q4 = await M.property.quoteSale(pid, again, T0, { isHeld: () => true });
    assert.equal(q4.ok && q4.data.blocked?.code, "FROZEN");
    const q5 = await M.property.quoteSale(await player(), again, T0);
    assert.ok(q5.ok);
    assert.deepEqual([q5.data.blocked?.code, q5.data.gross, q5.data.net], ["NOT_OWNER", 0, 0]);
    refused(await M.property.quoteSale(pid, "bodija-estate-9999", T0), 404, "NO_PLOT");
    M.config.config.plotSales = false;
    refused(await M.property.quoteSale(pid, again, T0), 503, "OFF");
  });

  test("a device that still remembers a sold plot cannot claim it back; a real purchase can", async () => {
    const pid = await player();
    const rival = await player();
    const id = await plot(pid, "moniya", { tier: 1 });
    const stale = T0 - 5 * MIN;
    assert.equal(M.property.claimBlocked(id, pid, stale), false, "before the sale nothing is blocked");
    assert.ok((await sell(pid, id, T0)).ok);
    assert.equal(M.property.claimBlocked(id, pid, stale), true, "a claim older than the sale is refused");
    assert.equal(M.property.claimBlocked(id, pid, T0), true, "so is one made at the very moment of the sale");
    assert.equal(M.property.claimBlocked(id, pid, T0 + 1), false, "a purchase after the sale goes through");
    assert.equal(M.property.claimBlocked(id, rival, stale), false, "someone else may take the land");
    assert.equal(M.property.claimBlocked("moniya-9999", pid, stale), false, "other plots are not affected");
    await M.property.initProperty();
    assert.equal(M.property.claimBlocked(id, pid, stale), true, "the record survives a restart");
    assert.equal(M.property.claimBlocked(id, rival, stale), false);
  });
});

/* ------------------------------------------------------------ moderators ------------------------------------------------------------ */

describe("moderators", () => {
  test("forgiving closes the loan, lifts the lien, tells the player, and does not lock them out", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    quiet(me);

    const at = due + 61 * MIN;
    const r = await M.loans.forgiveLoan(pid, at);
    assert.ok(r.ok);
    const row = (await loanRows(pid))[0];
    assert.deepEqual([row.status, row.closed_by, row.closed_at, row.stage], ["closed", "forgiven", at, "seized"]);
    assert.equal(M.presence.plots[home].seized, undefined);
    assert.equal((await plotRow(home)).seized, 0);
    assert.deepEqual([last(me.sent, "loan")!.loan, last(me.sent, "loan")!.why], [null, "forgiven"]);
    assert.ok((await M.loans.takeLoan(pid, 5_000, 60, at + 5_000)).ok, "forgiven means a clean slate, with no lockout");
    refused(await M.loans.forgiveLoan(await player(), at), 404, "LOAN_NONE");
  });

  test("the list shows active and closed loans with what is owed", async () => {
    const a = await player({ rep: 70 });
    const b = await player({ rep: 70 });
    await take(a, 50_000, 180, T0);
    await take(b, 10_000, 60, T0);
    await M.loans.repayLoan(b, 10_000_000, T0 + 10 * MIN);
    const active = (await M.loans.adminLoans("active", T0 + 60 * MIN)).filter((l) => [a, b].includes(l.pid));
    assert.deepEqual(active.map((l) => [l.pid, l.name, l.principal, l.owed, l.stage, l.status]), [[a, (await M.repo.getPlayer(a))!.name, 50_000, 53_000, "active", "active"]]);
    const closed = (await M.loans.adminLoans("closed", T0 + 60 * MIN)).filter((l) => l.pid === b);
    assert.deepEqual(closed.map((l) => [l.closedBy, l.owed]), [["paid", 0]]);
  });

  test("lifting a lien gives the player a new 30 minutes", async () => {
    const pid = await player({ rep: 70 });
    const me = connect(pid);
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 50_000, 180, T0);
    const due = T0 + 180 * MIN;
    for (const t of [due + MIN, due + 30 * MIN, due + 60 * MIN]) await M.loans.tickLoans(t);
    quiet(me);
    const at = due + 61 * MIN;
    assert.ok((await M.loans.unseizePlot(home, at)).ok);
    assert.equal(M.presence.plots[home].seized, undefined);
    assert.equal((await plotRow(home)).seized, 0);
    const row = (await loanRows(pid))[0];
    assert.deepEqual([row.status, row.stage, row.notice_at, row.seized_plot], ["active", "seized", at, null]);
    assert.deepEqual([last(me.sent, "loan")!.why, last(me.sent, "loan")!.loan!.stage], ["notice", "notice"]);
    await M.loans.tickLoans(at + 29 * MIN);
    assert.equal(M.presence.plots[home].seized, undefined);
    await M.loans.tickLoans(at + 30 * MIN);
    assert.equal(M.presence.plots[home].seized, true);
    refused(await M.loans.unseizePlot("bodija-estate-9999", at), 404, "NO_PLOT");
  });
});

/* ------------------------------------------------------------ the routes ------------------------------------------------------------ */

describe("the routes", () => {
  /** A request handed straight to the handler: no sockets, no server. */
  async function call(method: string, path: string, o: { pid?: string; admin?: string; body?: unknown; raw?: string } = {}) {
    const body = o.raw ?? (o.body === undefined ? "" : JSON.stringify(o.body));
    const headers: Record<string, string> = {};
    if (o.pid) headers.authorization = `Bearer ${M.auth.issueToken(o.pid)}`;
    if (o.admin) headers["x-admin-token"] = o.admin;
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: path, headers }) as unknown as IncomingMessage;
    let status = 0;
    let text = "";
    const res = { writeHead: (s: number) => ((status = s), res), end: (t: string) => void (text = t) } as unknown as ServerResponse;
    const handled = await M.http.handleLoans(req, res, new URL(path, "http://localhost"));
    return { handled, status, json: text ? JSON.parse(text) : null };
  }
  const admin = () => M.config.config.adminToken;
  const real = (rep = 70) => player({ rep, at: Date.now() });
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  test("paths that are not ours are left alone", async () => {
    for (const p of ["/api/bank/send", "/api/loans", "/api/plot", "/api/plots", "/api/admin/cases", "/api/admin/tracks", "/health"]) assert.equal((await call("GET", p)).handled, false, p);
  });

  test("every route needs a sign-in; the moderator routes need the admin token", async () => {
    for (const [m, p] of [["GET", "/api/loan"], ["GET", "/api/loan/offer"], ["POST", "/api/loan/take"], ["POST", "/api/loan/repay"], ["GET", "/api/plots/quote?plotId=moniya-1"], ["POST", "/api/plots/sell"]] as const) {
      const r = await call(m, p, { body: {} });
      assert.deepEqual([r.handled, r.status, r.json.code], [true, 401, "AUTH"], p);
    }
    const pid = await real();
    for (const [m, p] of [["GET", "/api/admin/loans"], ["POST", "/api/admin/loans/forgive"], ["POST", "/api/admin/plots/unseize"]] as const) {
      assert.equal((await call(m, p, { pid, body: {} })).status, 401, `${p}: a player's token is not enough`);
      assert.equal((await call(m, p, { admin: "wrong", body: {} })).status, 401, `${p}: wrong admin token`);
    }
  });

  test("offer, take, read and repay", async () => {
    const pid = await real();
    const offer = await call("GET", "/api/loan/offer", { pid });
    assert.equal(offer.status, 200);
    assert.deepEqual({ ...offer.json, now: 0 }, { limit: 50_000, titleBase: 50_000, collateral: 0, titleIdx: 2, blocked: null, now: 0 });
    const quick = await call("GET", "/api/loan/offer", { pid });
    assert.deepEqual([quick.status, quick.json.code], [429, "RATE"]);

    const none = await call("GET", "/api/loan", { pid });
    assert.deepEqual([none.status, none.json.loan], [200, null]);
    const took = await call("POST", "/api/loan/take", { pid, body: { amount: 20_000, termMin: 180 } });
    assert.equal(took.status, 200);
    assert.deepEqual([took.json.loan.principal, took.json.loan.left, took.json.loan.stage], [20_000, 20_000, "active"]);
    const again = await call("POST", "/api/loan/take", { pid, body: { amount: 5_000, termMin: 60 } });
    assert.deepEqual([again.status, again.json.code], [429, "RATE"]);
    await sleep(520);
    const read = await call("GET", "/api/loan", { pid });
    assert.equal(read.json.loan.id, took.json.loan.id);

    const bad = await call("POST", "/api/loan/repay", { pid, body: { amount: "all" } });
    assert.equal(bad.json.code, "RATE", "the gap between money requests applies to bad ones too");
    await sleep(1_600);
    const paid = await call("POST", "/api/loan/repay", { pid, body: { amount: 1_000_000_000 } });
    assert.equal(paid.status, 200);
    assert.deepEqual([paid.json.loan, paid.json.paid >= 20_000 && paid.json.paid <= 20_100], [null, true]);
    assert.deepEqual((await call("POST", "/api/loan/repay", { pid: await real(), body: { amount: 5_000 } })).json.code, "LOAN_NONE");
  });

  test("every refusal is { error, code } with the status in the contract", async () => {
    const young = await player({ rep: 70, ageMin: 5, at: Date.now() });
    const r = await call("POST", "/api/loan/take", { pid: young, body: { amount: 5_000, termMin: 60 } });
    assert.deepEqual([r.status, r.json.code, typeof r.json.error], [403, "TOO_NEW", "string"]);
    const lim = await call("POST", "/api/loan/take", { pid: await real(), body: { amount: 51_000, termMin: 60 } });
    assert.deepEqual([lim.status, lim.json.code], [422, "LOAN_LIMIT"]);
    const term = await call("POST", "/api/loan/take", { pid: await real(), body: { amount: 5_000, termMin: 7 } });
    assert.deepEqual([term.status, term.json.code], [400, "LOAN_TERM"]);
    M.config.config.loans = false;
    assert.deepEqual((await call("GET", "/api/loan", { pid: await real() })).json.code, "OFF");
    assert.equal((await call("GET", "/api/loan/offer", { pid: await real() })).json.blocked.code, "OFF");
    M.config.config.loans = true;
  });

  test("bad bodies are refused before anything happens", async () => {
    const pid = await real();
    assert.deepEqual((await call("POST", "/api/loan/take", { pid, raw: "{nope" })).json.code, "BAD");
    assert.deepEqual((await call("POST", "/api/loan/take", { pid, raw: "[1,2]" })).json.code, "BAD");
    assert.deepEqual((await call("POST", "/api/loan/take", { pid, raw: JSON.stringify({ amount: 5_000, termMin: 60, pad: "x".repeat(5_000) }) })).json.code, "BAD");
    assert.deepEqual((await call("POST", "/api/loan/take", { pid, body: {} })).json.code, "BAD");
    assert.deepEqual((await call("POST", "/api/plots/sell", { pid, body: { plotId: "Bad Id" } })).json.code, "BAD");
    assert.deepEqual((await call("POST", "/api/plots/sell", { pid, body: { plotId: 5 } })).json.code, "BAD");
    assert.deepEqual((await call("GET", "/api/plots/quote?plotId=../x", { pid })).json.code, "BAD");
    assert.equal((await call("DELETE", "/api/loan", { pid })).status, 404);
    assert.equal((await call("GET", "/api/loan/nope", { pid })).status, 404);
    assert.equal((await ledger(pid)).length, 0);
  });

  test("quote and sell", async () => {
    const pid = await real(0);
    const id = await plot(pid, "bodija-estate", { tier: 3, decor: ["plant", "plant", "plant"] });
    const quote = await call("GET", `/api/plots/quote?plotId=${id}`, { pid });
    assert.equal(quote.status, 200);
    assert.deepEqual({ ...quote.json, now: 0 }, { plotId: id, gross: 240_000, parts: { land: 108_000, built: 127_500, decor: 4_500 }, loanPaid: 0, net: 240_000, repBack: 58, blocked: null, now: 0 });
    const notMine = await call("GET", `/api/plots/quote?plotId=${id}`, { pid: await real() });
    assert.equal(notMine.json.blocked.code, "NOT_OWNER");
    assert.equal((await call("GET", "/api/plots/quote?plotId=bodija-estate-9999", { pid: await real() })).status, 404);

    const stranger = await call("POST", "/api/plots/sell", { pid: await real(), body: { plotId: id } });
    assert.deepEqual([stranger.status, stranger.json.code], [403, "NOT_OWNER"]);
    const sold = await call("POST", "/api/plots/sell", { pid, body: { plotId: id } });
    assert.equal(sold.status, 200);
    assert.deepEqual({ ...sold.json, now: 0 }, { ok: true, plotId: id, gross: 240_000, loanPaid: 0, net: 240_000, repBack: 58, now: 0 });
    assert.equal((await call("POST", "/api/plots/sell", { pid: await real(), body: { plotId: id } })).json.code, "NO_PLOT");
  });

  test("moderator routes", async () => {
    const pid = await real();
    const home = await plot(pid, "bodija-estate", { tier: 1 });
    await take(pid, 20_000, 60, Date.now());
    const list = await call("GET", "/api/admin/loans?status=active", { admin: admin() });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.loans.filter((l: { pid: string }) => l.pid === pid).map((l: { principal: number; stage: string }) => [l.principal, l.stage]), [[20_000, "active"]]);
    assert.equal((await call("GET", "/api/admin/loans?status=closed", { admin: admin() })).status, 200);

    assert.equal((await call("POST", "/api/admin/loans/forgive", { admin: admin(), body: { pid: "no" } })).json.code, "BAD");
    assert.equal((await call("POST", "/api/admin/loans/forgive", { admin: admin(), body: { pid: "nosuchplayer1" } })).json.code, "LOAN_NONE");
    await M.rm.setPlotSeized(home, true);
    M.presence.plots[home].seized = true;
    await M.rm.updateLoan((await M.rm.activeLoan(pid))!.id, { stage: "seized", seized_plot: home });
    const un = await call("POST", "/api/admin/plots/unseize", { admin: admin(), body: { plotId: home } });
    assert.deepEqual([un.status, un.json], [200, { ok: true, plotId: home }]);
    assert.equal(M.presence.plots[home].seized, undefined);
    assert.equal((await call("POST", "/api/admin/plots/unseize", { admin: admin(), body: { plotId: "bodija-estate-9999" } })).json.code, "NO_PLOT");
    assert.equal((await call("POST", "/api/admin/plots/unseize", { admin: admin(), body: { plotId: "Bad Id" } })).json.code, "BAD");

    const forgiven = await call("POST", "/api/admin/loans/forgive", { admin: admin(), body: { pid, note: "a mistake\nby us" } });
    assert.equal(forgiven.status, 200);
    assert.equal(forgiven.json.ok, true);
    assert.equal((await loanRows(pid))[0].closed_by, "forgiven");
    assert.equal((await call("POST", "/api/admin/loans/nothing", { admin: admin(), body: {} })).status, 404);
  });
});
