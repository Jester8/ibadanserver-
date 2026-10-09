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
const loanRows = (pid: string) => q<{ id: number; status: string; stage: string; unpaid: number; interest: number; notice_at: number | null; seized_plot: string | null; closed_by: string | null; closed_at: number | null; was_seized: number }>("SELECT * FROM loans WHERE pid = $1 ORDER BY id", [pid]);

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
    refused(await M.loans.repayLoan(pid, 1_000, now + 1_999 + 3_000 - 3_000), 429, "RATE");
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
