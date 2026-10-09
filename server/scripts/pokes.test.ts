// server/scripts/pokes.test.ts: npm test. Pokes and hits, with no network and no server: handlePoke is called directly with an injected
// `now`, a throw-away PGlite directory and fake sockets. LOCAL_DB_DIR is set BEFORE the database modules load.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { WebSocket } from "ws";
import { MIN, PRISON_ROOM } from "../../src/lib/custodyRules";
import type { PokeDeny, PokeKind, S2C } from "../../src/lib/protocol";
import { POKE } from "../../src/lib/socialRules";
import type { Client } from "../presence";

const dir = mkdtempSync(join(tmpdir(), "omo-pokes-"));
process.env.LOCAL_DB_DIR = dir;
delete process.env.DATABASE_URL;

type Mods = { db: typeof import("../db"); repo: typeof import("../db/repo"); rc: typeof import("../db/repoCustody"); pokes: typeof import("../pokes"); presence: typeof import("../presence"); config: typeof import("../config") };
let M: Mods;
const q = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => M.db.db.query<T>(sql, params);

before(async () => {
  M = { db: await import("../db"), repo: await import("../db/repo"), rc: await import("../db/repoCustody"), pokes: await import("../pokes"), presence: await import("../presence"), config: await import("../config") };
  await M.db.migrate();
});
after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  M.config.config.pokes = true;
  M.config.config.custody = false;
  M.presence.clients.clear();
  M.pokes.forgetPokes();
});

const T0 = Date.UTC(2026, 9, 9, 10, 0, 0);
let counter = 0;

async function player(ageMin = 120): Promise<string> {
  const n = ++counter;
  const pid = `pokepid${String(n).padStart(4, "0")}`;
  await M.repo.createVerifiedPlayer(pid, `Player${n}`, `${pid}@example.test`, null, `puser${n}`, null);
  await q("UPDATE players SET created_at = $2 WHERE pid = $1", [pid, T0 - ageMin * MIN]);
  return pid;
}

/** A fake connection in a room, standing at (x, z), who got there long enough ago. */
function connect(pid: string, o: { room?: string; x?: number; z?: number; age?: number } = {}) {
  const sent: S2C[] = [];
  const ws = { readyState: 1, send: (d: string) => void sent.push(JSON.parse(d)) } as unknown as WebSocket;
  const id = `pc${++counter}`;
  const client: Client = {
    ...M.presence.socialFields(), ws, info: { id, pid, name: `Name${counter}`, look: {} as never, room: o.room ?? "streets", x: o.x ?? 0, z: o.z ?? 0, ry: 0 }, moved: false, speed: 0, voiceRoom: null,
    lastChat: 0, lastPhoto: 0, lastImg: 0, lastListen: 0, lastInvite: 0, lastKnock: 0, sit: null, doing: null, lastTyping: 0, lastServe: 0, verified: true,
  };
  client.roomAt = T0 - 60_000;
  client.createdAt = o.age === undefined ? T0 - 120 * MIN : T0 - o.age * MIN;
  M.presence.clients.set(id, client);
  return { sent, id, client };
}
const of = <K extends S2C["t"]>(sent: S2C[], t: K) => sent.filter((m): m is Extract<S2C, { t: K }> => m.t === t);
const ack = (sent: S2C[]) => of(sent, "pokeAck").at(-1)!;

const poke = (a: ReturnType<typeof connect>, b: ReturnType<typeof connect>, kind: PokeKind, now: number) => M.pokes.handlePoke(a.client, { t: "poke", to: b.id, kind }, now);

async function pair(opts: { a?: Parameters<typeof connect>[1]; b?: Parameters<typeof connect>[1] } = {}) {
  const a = connect(await player(), { x: 0, z: 0, ...opts.a });
  const b = connect(await player(), { x: 1, z: 0, ...opts.b });
  return { a, b };
}
const denied = (sent: S2C[], deny: PokeDeny) => {
  const r = ack(sent);
  assert.equal(r.ok, false);
  assert.equal(r.deny, deny);
  return r;
};

describe("a poke that is allowed", () => {
  test("is delivered to the one poked, acknowledged, and drawn for the room", async () => {
    const { a, b } = await pair();
    const watcher = connect(await player(), { x: 6, z: 0 });
    const faraway = connect(await player(), { x: 30, z: 0 });
    await poke(a, b, "poke", T0);
    assert.equal(ack(a.sent).ok, true);
    const got = of(b.sent, "poked");
    assert.equal(got.length, 1);
    assert.deepEqual([got[0].kind, got[0].from, got[0].fromPid, got[0].recent, got[0].canReport], ["poke", a.id, a.client.info.pid, 1, false]);
    for (const c of [a, b, watcher]) assert.equal(of(c.sent, "pokeFx").length, 1, "within 12 units everyone sees the bubble");
    assert.equal(of(faraway.sent, "pokeFx").length, 0, "far away nobody does");
    assert.equal(await M.rc.countHits(a.client.info.pid, b.client.info.pid, 0), 0, "pokes are not written down");
  });

  test("a hit is written down as evidence and can be reported when the police are open", async () => {
    M.config.config.custody = true;
    const { a, b } = await pair();
    await poke(a, b, "hit", T0);
    assert.equal(ack(a.sent).ok, true);
    assert.equal(of(b.sent, "poked")[0].canReport, true);
    assert.equal(await M.rc.countHits(a.client.info.pid, b.client.info.pid, T0 - POKE.evidenceMs), 1);
    M.config.config.custody = false;
    const c = connect(await player(), { x: 1, z: 1 });
    await poke(a, c, "hit", T0 + 40_000);
    assert.equal(of(c.sent, "poked")[0].canReport, false, "nothing to report to while the police are closed");
  });

  test("three pokes in ten minutes make a report possible", async () => {
    M.config.config.custody = true;
    const { a, b } = await pair();
    for (let i = 0; i < 3; i++) await poke(a, b, "poke", T0 + i * 7_000);
    const got = of(b.sent, "poked");
    assert.deepEqual(got.map((g) => [g.recent, g.canReport]), [[1, false], [2, false], [3, true]]);
  });
});

describe("a poke that is refused", () => {
  test("off, or not a real target", async () => {
    const { a, b } = await pair();
    M.config.config.pokes = false;
    await poke(a, b, "poke", T0);
    denied(a.sent, "off");
    M.config.config.pokes = true;
    await M.pokes.handlePoke(a.client, { t: "poke", to: "nobody", kind: "poke" }, T0);
    denied(a.sent, "far");
    await M.pokes.handlePoke(a.client, { t: "poke", to: a.id, kind: "poke" }, T0);
    denied(a.sent, "far");
    await M.pokes.handlePoke(a.client, { t: "poke", to: b.id, kind: "slap" as never }, T0);
    assert.equal(of(a.sent, "pokeAck").length, 3, "an unknown kind gets no answer at all");
  });

  test("too far, in another room, or only just arrived", async () => {
    const { a, b } = await pair({ b: { x: POKE.range + 0.5 } });
    await poke(a, b, "poke", T0);
    denied(a.sent, "far");
    const c = connect(await player(), { x: 1, room: "in:place:mokola-mall" });
    await poke(a, c, "poke", T0);
    denied(a.sent, "far");
    const d = connect(await player(), { x: 1 });
    d.client.roomAt = T0 - 500;
    await poke(a, d, "poke", T0);
    denied(a.sent, "far");
    await poke(a, d, "poke", T0 + POKE.inRoomMs);
    assert.equal(ack(a.sent).ok, true, "a moment later it is fine");
  });

  test("no pokes in the prison, and none for or by someone held", async () => {
    const a = connect(await player(), { room: PRISON_ROOM });
    const b = connect(await player(), { room: PRISON_ROOM, x: 1 });
    await poke(a, b, "poke", T0);
    denied(a.sent, "prison");
  });

  test("declined: switched off, friends only, or blocked all read the same", async () => {
    const { a, b } = await pair();
    b.client.pokeMode = "off";
    await poke(a, b, "poke", T0);
    denied(a.sent, "declined");
    b.client.pokeMode = "friends";
    await poke(a, b, "poke", T0 + 1000);
    denied(a.sent, "declined");
    await M.repo.requestFriend(a.client.info.pid, b.client.info.pid);
    await M.repo.acceptFriend(a.client.info.pid, b.client.info.pid);
    await poke(a, b, "poke", T0 + 2000);
    assert.equal(ack(a.sent).ok, true, "a friend may");
    await M.repo.addBlock(b.client.info.pid, a.client.info.pid);
    b.client.pokeMode = "all";
    await poke(a, b, "poke", T0 + 20_000);
    denied(a.sent, "declined");
    assert.equal(of(b.sent, "poked").length, 1, "the blocked one's poke never reached them");
  });

  test("someone who has just reported you cannot be poked or hit by you", async () => {
    M.config.config.custody = true;
    const { a, b } = await pair();
    await M.rc.insertCase({ kind: "police", reason: "disturbance", reporter: b.client.info.pid, accused: a.client.info.pid, reporter_name: "B", accused_name: "A", via: "player", filed_at: T0 - 1000, confirm_by: T0 + 600_000, bail: 5000, fine: 2500, fee: 1000, prior: 0, disputed: 0, retaliation: 0, evidence_json: null });
    await poke(a, b, "poke", T0);
    denied(a.sent, "reported");
  });

  test("a hit needs an account that is ten minutes old", async () => {
    const { a, b } = await pair({ a: { age: 3 } });
    await poke(a, b, "hit", T0);
    denied(a.sent, "young");
    await poke(a, b, "poke", T0);
    assert.equal(ack(a.sent).ok, true, "a poke does not");
    a.client.createdAt = 0;
    await poke(a, b, "hit", T0 + 40_000);
    assert.equal(ack(a.sent).ok, true, "an account of unknown age is old enough");
  });
});

describe("the limits", () => {
  test("cooldowns: to anyone, then to the same person, with how long to wait", async () => {
    const { a, b } = await pair();
    const c = connect(await player(), { x: 0, z: 1 });
    await poke(a, b, "poke", T0);
    await poke(a, c, "poke", T0 + 1_000);
    assert.equal(denied(a.sent, "cooldown").retryMs, POKE.gapMs.poke - 1_000, "two pokes to anyone need 2 seconds");
    await poke(a, c, "poke", T0 + POKE.gapMs.poke);
    assert.equal(ack(a.sent).ok, true);
    await poke(a, b, "poke", T0 + 4_000);
    assert.equal(denied(a.sent, "cooldown").retryMs, POKE.pairGapMs.poke - 4_000, "the same person needs 6 seconds");
    await poke(a, b, "hit", T0 + 4_000);
    assert.equal(ack(a.sent).ok, true, "a hit has its own clock");
    await poke(a, b, "hit", T0 + 9_000);
    assert.equal(denied(a.sent, "cooldown").retryMs, POKE.pairGapMs.hit - 5_000);
  });

  test("at most 5 pokes and 3 hits to one person in ten minutes", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < POKE.pairMax.poke; i++) {
      await poke(a, b, "poke", T0 + i * 7_000);
      assert.equal(ack(a.sent).ok, true, `poke ${i + 1}`);
    }
    await poke(a, b, "poke", T0 + 40_000);
    denied(a.sent, "limit");
    assert.equal(of(b.sent, "poked").length, POKE.pairMax.poke, "the one poked is told nothing about the sixth");
    const hitAt = (i: number) => T0 + 100_000 + i * 31_000;
    for (let i = 0; i < POKE.pairMax.hit; i++) {
      await poke(a, b, "hit", hitAt(i));
      assert.equal(ack(a.sent).ok, true, `hit ${i + 1}`);
    }
    await poke(a, b, "hit", hitAt(POKE.pairMax.hit));
    denied(a.sent, "limit");
    await poke(a, b, "poke", T0 + 11 * MIN);
    assert.equal(ack(a.sent).ok, true, "ten minutes later the window has moved on");
  });

  test("at most 20 of anything in five minutes, and 6 hits in ten", async () => {
    const a = connect(await player(), { x: 0, z: 0 });
    const targets = [];
    for (let i = 0; i < 12; i++) targets.push(connect(await player(), { x: 1, z: 0 }));
    let n = 0;
    for (const t of targets) {
      await poke(a, t, "poke", T0 + n * 2_100);
      n++;
      assert.equal(ack(a.sent).ok, true);
    }
    // 12 so far; spread 8 more over the other targets (each person only once so far, the pair gap is over)
    for (let i = 0; i < 8; i++) {
      await poke(a, targets[i], "poke", T0 + n * 2_100 + 5_000);
      n++;
      assert.equal(ack(a.sent).ok, true, `poke ${n}`);
    }
    await poke(a, targets[8], "poke", T0 + n * 2_100 + 6_000);
    denied(a.sent, "limit");
    // hits: 6 in ten minutes to anyone, a long time after the pokes
    const base = T0 + 20 * MIN;
    for (let i = 0; i < POKE.hitMax; i++) {
      await poke(a, targets[i], "hit", base + i * 11_000);
      assert.equal(ack(a.sent).ok, true, `hit ${i + 1}`);
    }
    await poke(a, targets[6], "hit", base + 7 * 11_000);
    denied(a.sent, "limit");
  });

  test("cooldown beats limit when both apply", async () => {
    const { a, b } = await pair();
    for (let i = 0; i < POKE.pairMax.poke; i++) await poke(a, b, "poke", T0 + i * 7_000);
    await poke(a, b, "poke", T0 + 4 * 7_000 + 1_000);
    denied(a.sent, "cooldown");
  });
});

describe("the poke setting", () => {
  test("is saved with the account, echoed back, and read on connect", async () => {
    const pid = await player();
    const c = connect(pid);
    await M.pokes.handlePokeMode(c.client, "friends");
    assert.equal(c.client.pokeMode, "friends");
    assert.deepEqual(of(c.sent, "pokeMode").at(-1), { t: "pokeMode", mode: "friends" });
    await M.pokes.handlePokeMode(c.client, "everybody" as never);
    assert.equal(c.client.pokeMode, "friends", "a nonsense value changes nothing");
    const again = connect(pid);
    again.client.pokeMode = "all";
    await M.pokes.onPokeConnect(again.client);
    assert.equal(again.client.pokeMode, "friends");
    assert.equal(again.client.createdAt, T0 - 120 * MIN, "the account's age is read too");
    assert.deepEqual(of(again.sent, "pokeMode").at(-1), { t: "pokeMode", mode: "friends" });
  });
});
