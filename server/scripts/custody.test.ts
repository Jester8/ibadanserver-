// server/scripts/custody.test.ts: npm test. Police cases, booking, custody, bail and fines, with no network and no server: the functions are
// called directly with an injected `now`, a throw-away PGlite directory and fake sockets. LOCAL_DB_DIR is set BEFORE the database modules load.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { WebSocket } from "ws";
import { CELL_SPAWNS, HOUR, INTERIOR_SCALE, MIN, PRISON_ROOM, REASONS, RULES, STATE, bailFor, holdMsFor } from "../../src/lib/custodyRules";
import type { S2C } from "../../src/lib/protocol";
import type { Result } from "../../src/lib/socialRules";
import type { Client } from "../presence";

const dir = mkdtempSync(join(tmpdir(), "omo-custody-"));
process.env.LOCAL_DB_DIR = dir;
delete process.env.DATABASE_URL;

type Mods = { db: typeof import("../db"); repo: typeof import("../db/repo"); rc: typeof import("../db/repoCustody"); custody: typeof import("../custody"); presence: typeof import("../presence"); config: typeof import("../config") };
let M: Mods;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => M.db.db.query<T>(sql, params);

before(async () => {
  M = { db: await import("../db"), repo: await import("../db/repo"), rc: await import("../db/repoCustody"), custody: await import("../custody"), presence: await import("../presence"), config: await import("../config") };
  await M.db.migrate();
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(async () => {
  M.config.config.custody = true;
  M.config.config.custodyEfcc = false;
  M.config.config.custodyBooking = "station";
  M.config.config.custodyBailAnyone = false;
  M.presence.clients.clear();
  await q("UPDATE cases SET status = 'dismissed', closed_at = 0 WHERE status IN ('filed', 'held')");
  await M.custody.initCustody(T0);
});

const T0 = Date.UTC(2026, 9, 9, 10, 0, 0);
let counter = 0;

async function player(ageMin = 120): Promise<string> {
  const n = ++counter;
  const pid = `copid${String(n).padStart(5, "0")}`;
  await M.repo.createVerifiedPlayer(pid, `Cop${n}`, `${pid}@example.test`, null, `cuser${n}`, null);
  await q("UPDATE players SET created_at = $2 WHERE pid = $1", [pid, T0 - ageMin * MIN]);
  return pid;
}
function connect(pid: string, room = "streets", x = 0, z = 0) {
  const sent: S2C[] = [];
  const ws = { readyState: 1, send: (d: string) => void sent.push(JSON.parse(d)) } as unknown as WebSocket;
  const id = `cc${++counter}`;
  const client: Client = {
    ...M.presence.socialFields(), ws, info: { id, pid, name: pid, look: {} as never, room, x, z, ry: 0 }, moved: false, speed: 0, voiceRoom: null,
    lastChat: 0, lastPhoto: 0, lastImg: 0, lastListen: 0, lastInvite: 0, lastKnock: 0, sit: null, doing: null, lastTyping: 0, lastServe: 0, verified: true,
  };
  M.presence.clients.set(id, client);
  return { sent, id, client };
}
const of = <K extends S2C["t"]>(sent: S2C[], t: K) => sent.filter((m): m is Extract<S2C, { t: K }> => m.t === t);
const ledger = (pid: string) => q<{ from_pid: string; to_pid: string; amount: number; kind: string; debited: number; claimed: number; note: string }>("SELECT * FROM transfers WHERE from_pid = $1 OR to_pid = $1 ORDER BY id", [pid]);
const friends = async (a: string, b: string) => {
  await M.repo.requestFriend(a, b);
  await M.repo.acceptFriend(a, b);
};
const ok = <T,>(r: Result<T>): T => {
  assert.ok(r.ok, r.ok ? "" : `${r.code}: ${r.error}`);
  return r.data;
};
const refused = (r: Result<unknown>, code: string) => {
  assert.ok(!r.ok, "expected a refusal");
  assert.equal(r.code, code, r.error);
};

/** Two people standing together in the street (the reporter and the accused), plus a case filed at T0. */
async function scene(o: { reason?: "disturbance" | "loitering" | "harassment" } = {}) {
  const reporter = await player();
  const accused = await player();
  const r = connect(reporter);
  const a = connect(accused);
  const filed = ok(await M.custody.fileCase(reporter, { accused, reason: o.reason ?? "disturbance" }, T0));
  return { reporter, accused, r, a, filed };
}
const atStation = (c: { client: Client }) => void (c.client.info.room = "in:place:police-dugbe");

describe("filing a report", () => {
  test("is refused for every reason in the policy, with a code each", async () => {
    const reporter = await player();
    const accused = await player();
    const r = connect(reporter);
    const a = connect(accused, "streets", 40, 40);
    M.config.config.custody = false;
    refused(await M.custody.fileCase(reporter, { accused, reason: "disturbance" }, T0), "OFF");
    M.config.config.custody = true;
    refused(await M.custody.fileCase(reporter, { accused: "", reason: "disturbance" }, T0), "BAD");
    refused(await M.custody.fileCase(reporter, { accused, reason: "nonsense" as never }, T0), "BAD");
    refused(await M.custody.fileCase(reporter, { accused: reporter, reason: "disturbance" }, T0), "NO_SUCH_PLAYER");
    refused(await M.custody.fileCase(reporter, { accused: "nobody-here", reason: "disturbance" }, T0), "NO_SUCH_PLAYER");
    refused(await M.custody.fileCase(reporter, { accused, reason: "disturbance" }, T0), "NOT_NEARBY");
    refused(await M.custody.fileCase(reporter, { accused, reason: "scam" }, T0), "OFF");
    const newbie = await player(30);
    refused(await M.custody.fileCase(newbie, { accused, reason: "disturbance" }, T0), "TOO_NEW");
    a.client.info.x = 3;
    a.client.info.z = 3;
    await M.repo.addBlock(accused, reporter);
    refused(await M.custody.fileCase(reporter, { accused, reason: "disturbance" }, T0), "BLOCKED");
    void r;
  });

  test("assault needs a hit the game recorded", async () => {
    const reporter = await player();
    const accused = await player();
    connect(reporter);
    connect(accused);
    refused(await M.custody.fileCase(reporter, { accused, reason: "assault" }, T0), "NO_EVIDENCE");
    await M.rc.insertHit(T0 - 2 * MIN, accused, reporter, "streets");
    assert.equal(ok(await M.custody.fileCase(reporter, { accused, reason: "assault", via: "poke" }, T0)).case.reason, "assault");
  });

  test("charges the fee, tells the accused, and keeps one open case per pair", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    assert.equal(filed.held, false);
    assert.equal(filed.fee, REASONS.disturbance.fee);
    assert.equal(filed.case.status, "filed");
    assert.equal(filed.case.role, "reporter");
    const debit = of(r.sent, "debit").at(-1)!;
    assert.deepEqual([debit.amount, debit.to], [REASONS.disturbance.fee, "Nigeria Police Force"]);
    const row = (await ledger(reporter)).find((l) => l.kind === "fee")!;
    assert.deepEqual([row.from_pid, row.to_pid, row.debited], [reporter, STATE.police, 0], "the fee is a ledger row the client takes once");
    const told = of(a.sent, "caseUpdate").at(-1)!;
    assert.deepEqual([told.c.role, told.c.status, told.c.fine > 0], ["accused", "filed", true]);
    refused(await M.custody.fileCase(reporter, { accused, reason: "loitering" }, T0 + 2 * MIN), "OPEN_PAIR");
  });

  test("the reporter is limited: a minute between reports, and same-direction cooldown", async () => {
    const reporter = await player();
    const x = await player();
    const y = await player();
    connect(reporter);
    connect(x);
    connect(y);
    ok(await M.custody.fileCase(reporter, { accused: x, reason: "loitering" }, T0));
    refused(await M.custody.fileCase(reporter, { accused: y, reason: "loitering" }, T0 + 30_000), "RATE");
    ok(await M.custody.fileCase(reporter, { accused: y, reason: "loitering" }, T0 + 61_000));
  });
});

describe("booking", () => {
  test("only at a station: the accused is pinned to a cell and told", async () => {
    const { r, a, filed } = await scene();
    const bystander = connect(await player(), "streets", 1, 1);
    refused(await M.custody.confirmCase(r.client.info.pid, filed.case.id, T0 + 10_000), "WRONG_PLACE");
    atStation(r);
    const booked = ok(await M.custody.confirmCase(r.client.info.pid, filed.case.id, T0 + 10_000));
    assert.equal(booked.case.status, "held");
    const view = of(a.sent, "custody").at(-1)!.c!;
    assert.deepEqual([view.kind, view.reason, view.place, view.cell, view.bail], ["police", "disturbance", "prison", 0, REASONS.disturbance.bail]);
    assert.equal(view.releaseAt - view.heldAt, holdMsFor("disturbance", 0));
    assert.equal(a.client.info.room, PRISON_ROOM);
    assert.deepEqual([a.client.info.x, a.client.info.z], [CELL_SPAWNS[0][0] * INTERIOR_SCALE, CELL_SPAWNS[0][1] * INTERIOR_SCALE]);
    assert.ok(M.custody.isHeld(a.client.info.pid));
    assert.equal(M.custody.forcedRoom(a.client.info.pid), PRISON_ROOM);
    assert.equal(of(bystander.sent, "arrestNote").length, 1, "someone standing nearby is told");
    assert.equal(of(r.sent, "caseUpdate").at(-1)!.c.status, "held");
    assert.equal(of(a.sent, "caseUpdate").at(-1)!.c.status, "held");
    // a second tap on Book is not an error
    assert.equal(ok(await M.custody.confirmCase(r.client.info.pid, filed.case.id, T0 + 11_000)).case.status, "held");
  });

  test("not someone else's case, not offline, not after the window", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    atStation(r);
    refused(await M.custody.confirmCase(accused, filed.case.id, T0 + 1000), "NOT_YOURS");
    refused(await M.custody.confirmCase(reporter, filed.case.id, T0 + RULES.confirmWindowMs + 1), "GONE");
    M.presence.clients.delete(a.id);
    refused(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000), "OFFLINE");
  });

  test("a second held case for the same person is merged; the cells fill evenly", async () => {
    const reporter1 = await player();
    const reporter2 = await player();
    const a1 = await player();
    const a2 = await player();
    const r1 = connect(reporter1);
    const r2 = connect(reporter2);
    const c1 = connect(a1);
    const c2 = connect(a2);
    const f1 = ok(await M.custody.fileCase(reporter1, { accused: a1, reason: "disturbance" }, T0));
    const f2 = ok(await M.custody.fileCase(reporter2, { accused: a2, reason: "disturbance" }, T0));
    atStation(r1);
    atStation(r2);
    ok(await M.custody.confirmCase(reporter1, f1.case.id, T0 + 1000));
    ok(await M.custody.confirmCase(reporter2, f2.case.id, T0 + 1000));
    assert.deepEqual([c1, c2].map((c) => of(c.sent, "custody").at(-1)!.c!.cell).sort(), [0, 1], "the second prisoner gets the next cell");
  });

  test("a repeat offender is booked on the first report; 'instant' books at once", async () => {
    const accused = await player();
    const a = connect(accused);
    for (let i = 0; i < RULES.fastTrackPriors; i++) {
      const at = T0 + i * 40 * MIN;
      const rep = await player();
      const rc = connect(rep);
      const f = ok(await M.custody.fileCase(rep, { accused, reason: "loitering" }, at));
      assert.equal(f.held, false);
      atStation(rc);
      ok(await M.custody.confirmCase(rep, f.case.id, at + 1000));
      await M.custody.tickCustody(at + 16 * MIN);
      assert.equal(of(a.sent, "custody").at(-1)!.c, null, "served and free again");
      a.client.info.room = "streets";
      rc.client.info.room = "streets";
    }
    const third = await player();
    connect(third);
    const f3 = ok(await M.custody.fileCase(third, { accused, reason: "loitering" }, T0 + 2 * HOUR));
    assert.equal(f3.held, true, "two holds in a day: the third report books at once");
    // switch the immunity aside and try instant booking for a clean player
    M.config.config.custodyBooking = "instant";
    const clean = await player();
    const cleanC = connect(clean);
    const rep4 = await player();
    connect(rep4);
    const f4 = ok(await M.custody.fileCase(rep4, { accused: clean, reason: "disturbance" }, T0 + 3 * HOUR));
    assert.equal(f4.held, true);
    assert.equal(cleanC.client.info.room, PRISON_ROOM);
  });
});

describe("leaving custody", () => {
  test("a friend pays bail: the prisoner is free, the payer is charged, the reporter's fee comes back", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    const friend = await player();
    const f = connect(friend);
    await friends(accused, friend);
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    refused(await M.custody.payBail(await player(), filed.case.id, T0 + 2000), "NOT_ALLOWED");
    const paid = ok(await M.custody.payBail(friend, filed.case.id, T0 + 2000));
    assert.deepEqual([paid.by, paid.amount], ["friend", REASONS.disturbance.bail]);
    assert.equal(of(a.sent, "custody").at(-1)!.c, null);
    assert.equal(M.custody.isHeld(accused), false);
    assert.equal(of(f.sent, "debit").at(-1)!.amount, REASONS.disturbance.bail);
    const refund = (await ledger(reporter)).find((l) => l.kind === "refund")!;
    assert.deepEqual([refund.from_pid, refund.amount, refund.claimed], [STATE.police, REASONS.disturbance.fee, 0]);
    assert.equal(of(r.sent, "credit").at(-1)!.amount, REASONS.disturbance.fee);
    const bail = (await ledger(friend)).find((l) => l.kind === "bail")!;
    assert.deepEqual([bail.to_pid, bail.debited], [STATE.treasury, 0]);
    assert.equal(of(a.sent, "caseUpdate").at(-1)!.c.paidBy, (await M.repo.getPlayer(friend))!.name);
    // the same friend tapping again is fine; someone else gets 'not held'
    assert.equal(ok(await M.custody.payBail(friend, filed.case.id, T0 + 3000)).amount, REASONS.disturbance.bail);
    refused(await M.custody.payBail(accused, filed.case.id, T0 + 3000), "NOT_HELD");
  });

  test("two people paying at once are charged once", async () => {
    const { reporter, accused, r, filed } = await scene();
    const f1 = await player();
    const f2 = await player();
    await friends(accused, f1);
    await friends(accused, f2);
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    const [x, y] = await Promise.all([M.custody.payBail(f1, filed.case.id, T0 + 2000), M.custody.payBail(f2, filed.case.id, T0 + 2000)]);
    assert.equal([x, y].filter((z) => z.ok).length, 1, "one of them is told someone else got there first");
    const charged = await q("SELECT 1 FROM transfers WHERE kind = 'bail' AND from_pid IN ($1, $2)", [f1, f2]);
    assert.equal(charged.length, 1, "and only one of them is charged");
  });

  test("the prisoner pays their own bail; anyone can with CUSTODY_BAIL_ANYONE", async () => {
    const { reporter, accused, r, filed } = await scene();
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    assert.equal(ok(await M.custody.payBail(accused, filed.case.id, T0 + 2000)).by, "self");
    const second = await scene();
    atStation(second.r);
    ok(await M.custody.confirmCase(second.reporter, second.filed.case.id, T0 + 1000));
    M.config.config.custodyBailAnyone = true;
    assert.equal(ok(await M.custody.payBail(await player(), second.filed.case.id, T0 + 2000)).by, "other");
  });

  test("the time runs out: served, the fee comes back", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    atStation(r);
    const booked = ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    await M.custody.tickCustody(T0 + 1000 + holdMsFor("disturbance", 0) - 1);
    assert.equal(M.custody.isHeld(accused), true, "not yet");
    await M.custody.tickCustody(booked.case.releaseAt! + 1);
    assert.equal(M.custody.isHeld(accused), false);
    assert.equal(of(a.sent, "custody").at(-1)!.c, null);
    assert.equal((await M.rc.getCase(filed.case.id))!.status, "served");
    assert.equal((await ledger(reporter)).filter((l) => l.kind === "refund").length, 1);
  });

  test("after a release nobody can hold that person again for ten minutes", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    ok(await M.custody.payBail(accused, filed.case.id, T0 + 2000));
    const other = await player();
    connect(other);
    // released at T0 + 2 s: inside ten minutes it is refused, after that it is allowed again
    refused(await M.custody.fileCase(other, { accused, reason: "loitering" }, T0 + 2000 + 5 * MIN), "IMMUNE");
    a.client.info.room = "streets"; // out of the prison, as the client would be
    a.client.info.x = a.client.info.z = 0;
    ok(await M.custody.fileCase(other, { accused, reason: "loitering" }, T0 + 2000 + 11 * MIN));
  });
});

describe("dropping a case, fines and lapses", () => {
  test("withdraw within a minute: refunded. Later: kept. A hold dropped after a minute: refunded", async () => {
    const quick = await scene();
    ok(await M.custody.withdrawCase(quick.reporter, quick.filed.case.id, T0 + 30_000));
    assert.equal((await ledger(quick.reporter)).filter((l) => l.kind === "refund").length, 1);
    const slow = await scene();
    const dropped = ok(await M.custody.withdrawCase(slow.reporter, slow.filed.case.id, T0 + 5 * MIN));
    assert.equal(dropped.refund, 0);
    assert.equal((await ledger(slow.reporter)).filter((l) => l.kind === "refund").length, 0);
    const held = await scene();
    atStation(held.r);
    ok(await M.custody.confirmCase(held.reporter, held.filed.case.id, T0 + 1000));
    const back = ok(await M.custody.withdrawCase(held.reporter, held.filed.case.id, T0 + 3 * MIN));
    assert.equal(back.refund, REASONS.disturbance.fee);
    assert.equal(M.custody.isHeld(held.accused), false);
    assert.equal(of(held.a.sent, "custody").at(-1)!.c, null);
  });

  test("the accused can settle a filed police case with a fine at a station", async () => {
    const { reporter, accused, a, filed } = await scene();
    refused(await M.custody.payFine(accused, filed.case.id, T0 + 1000), "WRONG_PLACE");
    atStation(a);
    const done = ok(await M.custody.payFine(accused, filed.case.id, T0 + 1000));
    assert.equal(done.case.status, "settled");
    assert.equal((await ledger(accused)).find((l) => l.kind === "fine")!.to_pid, STATE.treasury);
    assert.equal((await ledger(reporter)).filter((l) => l.kind === "refund").length, 1, "the reporter's fee comes back");
    refused(await M.custody.payFine(reporter, filed.case.id, T0 + 2000), "NOT_YOURS");
  });

  test("a case nobody books lapses and the fee is kept", async () => {
    const { reporter, accused, filed } = await scene();
    await M.custody.tickCustody(T0 + 6 * HOUR); // (the clock only moves forward: earlier tests ticked up to about an hour)
    const row = (await M.rc.getCase(filed.case.id))!;
    assert.deepEqual([row.status, row.fee_state], ["expired", "kept"]);
    assert.equal((await ledger(reporter)).filter((l) => l.kind === "refund").length, 0);
    refused(await M.custody.confirmCase(reporter, filed.case.id, T0 + 6 * HOUR + 30_000), "GONE");
    void accused;
  });
});

describe("asking friends, connecting, switching off, moderators", () => {
  test("ask friends: online ones are told, offline ones counted, with a wait and a cap", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    const on = await player();
    const off = await player();
    const onC = connect(on);
    await friends(accused, on);
    await friends(accused, off);
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    const asked = ok(await M.custody.askFriends(accused, T0 + 2000));
    assert.deepEqual([asked.notified, asked.offline], [1, 1]);
    const ask = of(onC.sent, "bailAsk")[0];
    assert.deepEqual([ask.caseId, ask.pid, ask.bail], [filed.case.id, accused, REASONS.disturbance.bail]);
    refused(await M.custody.askFriends(accused, T0 + 3000), "ASK_WAIT");
    assert.equal(of(a.sent, "custody").at(-1)!.c!.asks, 1);
    // the friend who was offline sees it when they connect
    const later = connect(off);
    await M.custody.onConnect(later.client, T0 + 4000);
    assert.equal(of(later.sent, "bailAsk").length, 1);
    // paying ends the ask for the friends
    ok(await M.custody.payBail(on, filed.case.id, T0 + 5000));
    await new Promise((done) => setTimeout(done, 100));
    assert.deepEqual(of(onC.sent, "bailAskEnd").map((m) => [m.caseId, m.why]), [[filed.case.id, "paid"]], "the friends who were asked are told it is done");
    refused(await M.custody.askFriends(accused, T0 + 60_000), "NOT_HELD");
  });

  test("a held player who reconnects is put straight back in the prison", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    M.presence.clients.delete(a.id);
    const back = connect(accused, "streets", 5, 5);
    await M.custody.onConnect(back.client, T0 + 5000);
    assert.equal(back.client.info.room, PRISON_ROOM);
    assert.equal(of(back.sent, "custody").at(-1)!.c!.caseId, filed.case.id);
    const free = connect(await player());
    await M.custody.onConnect(free.client, T0);
    assert.equal(of(free.sent, "custody").at(-1)!.c, null);
  });

  test("with CUSTODY off, a restart lets everybody out", async () => {
    const { reporter, accused, r, filed } = await scene();
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    M.config.config.custody = false;
    await M.custody.initCustody(T0 + 2000);
    assert.equal(M.custody.isHeld(accused), false);
    assert.equal((await M.rc.getCase(filed.case.id))!.status, "dismissed");
  });

  test("a moderator can dismiss a case (the fee is kept, the reporter can be barred) or release everyone", async () => {
    const { reporter, accused, r, a, filed } = await scene();
    atStation(r);
    ok(await M.custody.confirmCase(reporter, filed.case.id, T0 + 1000));
    ok(await M.custody.adminDismiss(filed.case.id, "no evidence", 24, T0 + 2000));
    assert.equal(M.custody.isHeld(accused), false);
    assert.equal(of(a.sent, "custody").at(-1)!.c, null);
    assert.equal((await ledger(reporter)).filter((l) => l.kind === "refund").length, 0);
    const flags = (await M.rc.playerFlags(reporter))!;
    assert.ok((flags.police_ban_until ?? 0) > T0 + 20 * HOUR);
    const other = await scene();
    atStation(other.r);
    ok(await M.custody.confirmCase(other.reporter, other.filed.case.id, T0 + 1000));
    assert.equal(await M.custody.adminReleaseAll("test", T0 + 3000), 1);
    assert.equal(M.custody.isHeld(other.accused), false);
  });

  test("the numbers: bail and the length of a stay grow with priors and stay capped", () => {
    assert.equal(bailFor("disturbance", 0), 5_000);
    assert.equal(bailFor("disturbance", 2), 10_000);
    assert.equal(holdMsFor("disturbance", 0), 10 * MIN);
    assert.equal(holdMsFor("harassment", 10), RULES.hold.policeCapMin * MIN);
    assert.ok(bailFor("fraud", 4, 10_000_000) <= RULES.bailCap);
  });
});
