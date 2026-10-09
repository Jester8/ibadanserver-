import type { CaseCard, CaseStatus, CustodyView, PeerInfo } from "../src/lib/protocol";
import type { HeldFriend, Payee, Recent, ReportBody, ReportResult } from "../src/lib/custodyRules";
import { CELL_SPAWNS, HOUR, INTERIOR_SCALE, MIN, PRISON_ID, PRISON_ROOM, REASONS, RULES, STATE, bailFor, fineFor, holdMsFor, stateName, stationRooms } from "../src/lib/custodyRules";
import { POKE, efccFilingOpen, type Result } from "../src/lib/socialRules";
import { config } from "./config";
import { addReport, addTransfer, blockedEither, friendshipsOf, getFriendship, getPlayer } from "./db/repo";
import * as repo from "./db/repoCustody";
import type { CaseRow } from "./db/repoCustody";
import { clients, isOnline, sendToPid, standUp, tx, broadcast, type Client } from "./presence";
import { pokedOn, pokeEvidence } from "./pokes";

/*
 * Police and EFCC cases, and who is in custody. Policy lives here, SQL in db/repoCustody.ts, the numbers in custodyRules.ts.
 * The database is the truth (one held case per accused, one open case per pair); memory only caches what is held and who
 * has been near whom. Money moves through the transfers ledger, so a fee, a fine or a bail is charged exactly once.
 */

/** index.ts sets this to its leaveVoice, so an arrest can take the player out of a voice room. */
export const hooks: { leaveVoice: ((c: Client) => void) | null } = { leaveVoice: null };

const held = new Map<string, CaseRow>();

/* ------------------------------------------------ what the clients are told ------------------------------------------------ */

export const heldCase = (pid: string) => held.get(pid);
export const isHeld = (pid: string): boolean => held.has(pid);
/** The room a held player is pinned to (the prison), or null. */
export const forcedRoom = (pid: string): string | null => (held.has(pid) ? PRISON_ROOM : null);

export const viewOf = (c: CaseRow): CustodyView => ({
  caseId: c.id,
  kind: c.kind,
  reason: c.reason,
  by: c.reporter_name,
  place: PRISON_ID,
  cell: c.cell ?? 0,
  heldAt: c.held_at ?? 0,
  releaseAt: c.release_at ?? 0,
  bail: c.bail,
  asks: c.asks,
  nextAskAt: c.asked_at ? c.asked_at + RULES.askGapMs : 0,
});

export const cardFor = (c: CaseRow, me: string): CaseCard => {
  const mine = c.reporter === me;
  return {
    id: c.id,
    kind: c.kind,
    reason: c.reason,
    role: mine ? "reporter" : "accused",
    other: mine ? { pid: c.accused, name: c.accused_name } : { pid: c.reporter, name: c.reporter_name },
    status: c.status,
    filedAt: c.filed_at,
    confirmBy: c.confirm_by,
    bookableAt: c.kind === "efcc" ? c.filed_at + RULES.efccGraceMs : c.filed_at,
    heldAt: c.held_at,
    releaseAt: c.release_at,
    closedAt: c.closed_at,
    bail: c.bail,
    fine: c.fine,
    fee: c.fee,
    feeState: c.fee_state,
    disputed: c.disputed,
    paidBy: c.paid_by,
  };
};

const tellBoth = (c: CaseRow, now: number) => {
  sendToPid(c.reporter, { t: "caseUpdate", c: cardFor(c, c.reporter), now });
  sendToPid(c.accused, { t: "caseUpdate", c: cardFor(c, c.accused), now });
};
const tellCustody = (pid: string, c: CaseRow | null, now: number) => sendToPid(pid, { t: "custody", c: c ? viewOf(c) : null, now });
const clientOf = (pid: string): Client | undefined => {
  for (const c of clients.values()) if (c.info.pid === pid && !c.lingering) return c;
  return undefined;
};

/* ----------------------------------------------------- who was near whom ----------------------------------------------------- */

const met = new Map<string, number>();
const metKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Together in the same room indoors, or both outside and within 8 world units. */
export function coPresent(a: PeerInfo, b: PeerInfo): boolean {
  if (a.room.startsWith("in:") || b.room.startsWith("in:")) return a.room === b.room;
  return Math.hypot(a.x - b.x, a.z - b.z) <= RULES.meetRange;
}

/** Every 5 seconds: remember who was close to whom (for "you can report someone you were with"). */
export function tickMeetings(now = Date.now()): void {
  const list = [...clients.values()];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[i].info.pid !== list[j].info.pid && coPresent(list[i].info, list[j].info)) met.set(metKey(list[i].info.pid, list[j].info.pid), now);
    }
  }
  for (const [k, at] of met) if (now - at > 15 * MIN) met.delete(k);
}
export const lastMet = (a: string, b: string): number => met.get(metKey(a, b)) ?? 0;

/* ---------------------------------------------------------- money ---------------------------------------------------------- */

/** Charge a player: a ledger row with debited = 0, and a `debit` push (the client takes the money once). */
async function charge(pid: string, to: string, amount: number, note: string, kind: string): Promise<void> {
  const id = await addTransfer(pid, to, amount, note, kind, 0);
  sendToPid(pid, { t: "debit", id, to: stateName(to) ?? "State", amount, note });
}
/** Pay a player from the state: a ledger row and a `credit` push. */
async function pay(pid: string, from: string, amount: number, note: string, kind: string): Promise<void> {
  const id = await addTransfer(from, pid, amount, note, kind, 1);
  sendToPid(pid, { t: "credit", id, from: stateName(from) ?? "State", username: "", amount, note });
}
const stateOf = (c: CaseRow) => (c.kind === "efcc" ? STATE.efcc : STATE.police);

/* ---------------------------------------------------------- closing ---------------------------------------------------------- */

/** What the reporter's fee does when the case ends this way (the refund matrix). */
function feeEnds(c: CaseRow, to: CaseStatus, now: number): "refunded" | "kept" {
  if (to === "bailed" || to === "served" || to === "settled" || to === "merged") return "refunded";
  if (to === "withdrawn") {
    if (c.held_at != null) return now - c.held_at >= RULES.undoWindowMs ? "refunded" : "kept";
    return now - c.filed_at <= RULES.undoWindowMs ? "refunded" : "kept";
  }
  return "kept"; // expired, dismissed
}

/** End a case: release the accused if held, settle the fee, and tell everyone. Returns the closed row, or undefined if it had already moved on. */
async function finish(c: CaseRow, to: CaseStatus, now: number, patch: Parameters<typeof repo.transition>[3] = {}): Promise<CaseRow | undefined> {
  const fee = feeEnds(c, to, now);
  const row = await repo.transition(c.id, ["filed", "held"], to, { closed_at: now, fee_state: fee, ...patch });
  if (!row) return undefined;
  const wasHeld = held.get(row.accused)?.id === row.id;
  if (wasHeld) held.delete(row.accused);
  if (fee === "refunded" && c.fee > 0) await pay(row.reporter, stateOf(row), row.fee, `Report fee refunded: case #${row.id}`, "refund").catch((e) => console.error("[custody]", e));
  if (wasHeld) {
    tellCustody(row.accused, null, now);
    askedFriends(row, (pid) => sendToPid(pid, { t: "bailAskEnd", caseId: row.id, why: to === "bailed" ? "paid" : to === "served" ? "released" : "ended", by: row.paid_by ?? undefined }));
  }
  tellBoth(row, now);
  return row;
}

/* ----------------------------------------------------------- booking ----------------------------------------------------------- */

const leastOccupiedCell = (): number => {
  const used = new Array<number>(CELL_SPAWNS.length).fill(0);
  for (const c of held.values()) used[(c.cell ?? 0) % used.length]++;
  return used.indexOf(Math.min(...used));
};

/** Put a connected, held player in their cell: out of the street and any voice room, standing, on foot, in the prison room. */
function placeInCell(c: Client, row: CaseRow, now: number) {
  if (c.voiceRoom && !c.voiceRoom.startsWith("call:")) hooks.leaveVoice?.(c);
  standUp(c);
  c.info.car = null;
  const [x, z] = CELL_SPAWNS[(row.cell ?? 0) % CELL_SPAWNS.length];
  c.info.room = PRISON_ROOM;
  c.info.x = x * INTERIOR_SCALE;
  c.info.z = z * INTERIOR_SCALE;
  c.moved = true;
  c.roomAt = now;
  broadcast({ t: "join", peer: c.info }, c.info.id);
  tx(c.ws, { t: "custody", c: viewOf(row), now });
}

/** The accused's priors in the last day, for bail and the length of the stay. */
const priorsOf = (accused: string, now: number) => repo.priorHolds(accused, now - 24 * HOUR);

/** Turn a filed case into a hold. Returns the held row, or why not. */
async function book(c: CaseRow, now: number): Promise<Result<CaseRow>> {
  if (c.status !== "filed" || now > c.confirm_by) return { ok: false, status: 409, code: "GONE", error: "That case has lapsed." };
  const target = clientOf(c.accused);
  if (!target) return { ok: false, status: 409, code: "OFFLINE", error: `${c.accused_name} is not online, so they cannot be booked.` };
  if (held.has(c.accused)) return { ok: false, status: 409, code: "ALREADY_HELD", error: `${c.accused_name} is already in custody.` };
  if (c.kind === "efcc") {
    if (await repaidEnough(c)) {
      await finish(c, "settled", now);
      return { ok: false, status: 409, code: "GONE", error: "They have repaid the money, so the case is settled." };
    }
    if (now < c.filed_at + RULES.efccGraceMs) return { ok: false, status: 409, code: "TOO_EARLY", error: "The other side has a few minutes to repay before this can be booked." };
  }
  const priors = await priorsOf(c.accused, now);
  const bail = bailFor(c.reason, priors, c.disputed);
  const row = await repo
    .transition(c.id, ["filed"], "held", { held_at: now, release_at: now + holdMsFor(c.reason, priors), cell: leastOccupiedCell(), bail })
    .catch((e: { code?: string }) => {
      if (e?.code === "23505") return null; // already held through another case
      throw e;
    });
  if (row === null) {
    await finish(c, "merged", now);
    return { ok: false, status: 409, code: "ALREADY_HELD", error: `${c.accused_name} is already in custody.` };
  }
  if (!row) return { ok: false, status: 409, code: "GONE", error: "That case is no longer open." };
  held.set(row.accused, row);
  // players close by are told before the room changes
  for (const other of clients.values()) {
    if (other.info.pid === row.accused || other.info.pid === row.reporter || !coPresent(other.info, target.info)) continue;
    void blockedEither(other.info.pid, row.accused).then((b) => !b && tx(other.ws, { t: "arrestNote", name: row.accused_name, reason: row.reason }));
  }
  placeInCell(target, row, now);
  tellBoth(row, now);
  void addReport(`${row.reporter}(${row.reporter_name})`, `${row.accused}(${row.accused_name})`, `police:held case #${row.id} ${row.reason}`).catch(() => {});
  return { ok: true, data: row };
}

/** Has the accused paid back enough of the disputed money to settle an EFCC case? */
async function repaidEnough(c: CaseRow): Promise<boolean> {
  if (c.kind !== "efcc" || c.disputed <= 0) return false;
  const back = await repo.sentBetween(c.accused, c.reporter, c.filed_at - RULES.efcc.windowMs);
  return back.total >= c.disputed * RULES.efcc.repaidShare;
}

/* ------------------------------------------------------------ filing ------------------------------------------------------------ */

const fail = <T,>(status: number, code: Extract<Result<T>, { ok: false }>["code"], error: string): Result<T> => ({ ok: false, status, code, error });

/** File a report. Policy order: switches, reporter, accused, pair, evidence, numbers; then charge and tell. */
export async function fileCase(reporter: string, body: ReportBody, now = Date.now()): Promise<Result<ReportResult>> {
  if (!config.custody) return fail(503, "OFF", "The police are not open yet.");
  const reason = body?.reason;
  const accusedPid = typeof body?.accused === "string" ? body.accused : "";
  if (!reason || !(reason in REASONS) || !accusedPid) return fail(400, "BAD", "Choose who and why.");
  const info = REASONS[reason];
  if (info.kind === "efcc") {
    if (!config.custodyEfcc) return fail(503, "OFF", "Money cases are not open yet.");
    if (!efccFilingOpen(now)) return fail(409, "OFFICE_CLOSED", "The EFCC office is closed. Money cases can be filed between 8:00 and 16:50.");
  }
  // the reporter
  const me = await repo.playerFlags(reporter);
  const myName = (await getPlayer(reporter))?.name ?? "Someone";
  if (!me || now - me.created_at < RULES.minAccountAgeMs) return fail(403, "TOO_NEW", "New players can report after their first hour in Ibadan.");
  if ((me.police_ban_until ?? 0) > now || (await repo.countExpiredOrKeptBy(reporter, now - 24 * HOUR)) >= 4) return fail(403, "BANNED", "You cannot file reports for now.");
  if (held.has(reporter)) return fail(403, "IN_CUSTODY", "You cannot report from custody.");
  // the accused
  if (accusedPid === reporter) return fail(400, "NO_SUCH_PLAYER", "You cannot report yourself.");
  const accused = await getPlayer(accusedPid);
  if (!accused) return fail(404, "NO_SUCH_PLAYER", "No such player.");
  if (await blockedEither(reporter, accusedPid)) return fail(403, "BLOCKED", "You cannot report this player.");
  if (held.has(accusedPid)) return fail(409, "ALREADY_HELD", `${accused.name} is already in custody.`);
  if (now - (await repo.lastReleaseOf(accusedPid)) < RULES.rearrestImmunityMs) return fail(409, "IMMUNE", `${accused.name} was only just let out. Try again later.`);
  const priors = await priorsOf(accusedPid, now);
  if (priors >= RULES.maxHoldsPerDay) {
    // too many holds for one day: a moderator looks at it instead
    void addReport(`${reporter}(${myName})`, `${accusedPid}(${accused.name})`, `police:referred ${reason}`).catch(() => {});
    const card: CaseCard = { id: 0, kind: info.kind, reason, role: "reporter", other: { pid: accusedPid, name: accused.name }, status: "dismissed", filedAt: now, confirmBy: now, bookableAt: now, heldAt: null, releaseAt: null, closedAt: now, bail: 0, fine: 0, fee: 0, feeState: "refunded", disputed: 0, paidBy: null };
    return { ok: true, data: { case: card, held: false, fee: 0, referred: true } };
  }
  // the reporter's limits
  if (now - (await repo.lastFiledBy(reporter)) < RULES.fileGapMs) return fail(429, "RATE", "Wait a minute before another report.");
  if ((await repo.countFiledBy(reporter, now - HOUR)) >= RULES.maxFiledPerHour) return fail(429, "RATE", "That is enough reports for one hour.");
  if ((await repo.countFiledBy(reporter, now - 24 * HOUR)) >= RULES.maxFiledPerDay) return fail(429, "DAILY", "That is enough reports for today.");
  if ((await repo.countOpenFiledBy(reporter)) >= RULES.maxOpenFiled) return fail(429, "RATE", "Book or withdraw the cases you have open first.");
  if (now - (await repo.lastClosedSameDirection(reporter, accusedPid)) < RULES.sameDirectionCooldownMs) return fail(429, "RATE", `You reported ${accused.name} a moment ago. Give it some time.`);

  // evidence the server can see for itself
  const meC = clientOf(reporter);
  const themC = clientOf(accusedPid);
  const lastSeen = lastMet(reporter, accusedPid);
  const together = !!meC && !!themC && coPresent(meC.info, themC.info);
  const evidence: Record<string, unknown> = { lastMet: together ? now : lastSeen, rooms: [meC?.info.room ?? null, themC?.info.room ?? null] };
  let disputed = 0;
  if (info.kind === "police") {
    const metRecently = together || (lastSeen > 0 && now - lastSeen <= RULES.meetWindowMs);
    if (reason === "assault") {
      if ((await repo.countHits(accusedPid, reporter, now - POKE.evidenceMs)) < 1) return fail(409, "NO_EVIDENCE", "The game did not see them hit you.");
    } else if (reason === "harassment") {
      const ev = await pokeEvidence(accusedPid, reporter, now - POKE.evidenceMs, now);
      if (!metRecently && ev.hits + ev.pokes < POKE.harassCount) return fail(409, "NOT_NEARBY", "You can report someone you were with in the last 10 minutes.");
    } else if (!metRecently) return fail(409, "NOT_NEARBY", "You can report someone you were with in the last 10 minutes.");
    evidence.lines = (await repo.recentLinesBy(accusedPid, now - 10 * MIN)).map((l) => ({ room: l.room, text: l.text, at: l.at }));
  } else {
    const since = now - RULES.efcc.windowMs;
    const sent = await repo.sentBetween(reporter, accusedPid, since);
    if (reason === "scam") {
      if (sent.total < RULES.efcc.minTransfer || now - sent.firstAt < RULES.efcc.ledgerMinAgeMs) return fail(409, "NO_EVIDENCE", "There is no transfer from you to them to report yet.");
      const back = await repo.sentBetween(accusedPid, reporter, since);
      disputed = Math.max(0, sent.total - back.total);
      if (back.total >= sent.total * RULES.efcc.repaidShare || disputed < RULES.efcc.minTransfer) return fail(409, "NO_EVIDENCE", "They have already paid most of it back.");
    } else {
      const got = await repo.receivedDistinct(accusedPid, since);
      if (sent.n < 1 || got.senders < RULES.efcc.fraudSenders || got.total < RULES.efcc.fraudTotal) return fail(409, "NO_EVIDENCE", "The money records do not show a pattern yet.");
      disputed = sent.total;
    }
    evidence.disputed = disputed;
  }

  // a report back at someone who reported you in the last hour is allowed, but costs double and cannot jump the queue
  const against = await repo.filedAgainst(reporter, now - HOUR);
  const retaliation = against.some((c) => c.reporter === accusedPid) ? 1 : 0;
  const fee = info.fee * (retaliation ? 2 : 1);
  let row: CaseRow;
  try {
    row = await repo.insertCase({
      kind: info.kind, reason, reporter, accused: accusedPid, reporter_name: myName, accused_name: accused.name, via: typeof body.via === "string" ? body.via : "player",
      filed_at: now, confirm_by: now + RULES.confirmWindowMs, bail: bailFor(reason, priors, disputed), fine: fineFor(reason), fee, prior: priors, disputed, retaliation, evidence_json: JSON.stringify(evidence),
    });
  } catch (e) {
    if ((e as { code?: string })?.code === "23505") return fail(409, "OPEN_PAIR", `You already have a case open with ${accused.name}.`);
    throw e;
  }
  await charge(reporter, stateOf(row), fee, `Report fee: case #${row.id}`, "fee");
  void addReport(`${reporter}(${myName})`, `${accusedPid}(${accused.name})`, `police:filed case #${row.id} ${reason}`).catch(() => {});
  sendToPid(accusedPid, { t: "caseUpdate", c: cardFor(row, accusedPid), now });

  // booked at once when the server is set that way, the accused is a repeat offender, or two older accounts have reported them
  let heldNow = false;
  let current = row;
  const fast = config.custodyBooking === "instant" || (!retaliation && priors >= RULES.fastTrackPriors) || (!retaliation && (await corroborated(row, now)));
  if (fast && info.kind === "police") {
    const r = await book(row, now);
    if (r.ok) {
      heldNow = true;
      current = r.data;
      await mergeOthers(current, now);
    }
  } else sendToPid(reporter, { t: "caseUpdate", c: cardFor(row, reporter), now });
  return { ok: true, data: { case: cardFor(current, reporter), held: heldNow, fee } };
}

/** A second, different reporter (both accounts older than a day) against the same person within ten minutes. */
async function corroborated(row: CaseRow, now: number): Promise<boolean> {
  if (row.kind !== "police") return false;
  const others = (await repo.filedAgainst(row.accused, now - RULES.corroborateWindowMs)).filter((c) => c.id !== row.id && c.reporter !== row.reporter && !c.retaliation && c.kind === "police");
  if (others.length + 1 < RULES.corroborateReporters) return false;
  for (const pid of [row.reporter, ...others.map((c) => c.reporter)]) {
    const f = await repo.playerFlags(pid);
    if (!f || now - f.created_at < RULES.corroboratorAgeMs) return false;
  }
  return true;
}

/** After one case booked the accused, any other open case against them is merged into it and its fee refunded. */
async function mergeOthers(booked: CaseRow, now: number) {
  for (const c of await repo.filedAgainst(booked.accused, 0)) {
    if (c.id === booked.id) continue;
    await finish(c, "merged", now, { merged_into: booked.id });
  }
}

/** The reporter takes a filed case to the counter and books it. */
export async function confirmCase(reporter: string, caseId: number, now = Date.now()): Promise<Result<{ case: CaseCard }>> {
  if (!config.custody) return fail(503, "OFF", "The police are not open yet.");
  const c = await repo.getCase(caseId);
  if (!c || c.reporter !== reporter) return fail(403, "NOT_YOURS", "That is not your case.");
  if (c.status === "held") return { ok: true, data: { case: cardFor(c, reporter) } }; // a repeated tap is not an error
  if (c.status !== "filed" || now > c.confirm_by) return fail(409, "GONE", "That case has lapsed.");
  const me = clientOf(reporter);
  if (config.custodyBooking !== "instant" && (!me || !stationRooms(c.kind).includes(me.info.room))) return fail(409, "WRONG_PLACE", c.kind === "efcc" ? "Book it at the EFCC office." : "Book it at a police station.");
  const r = await book(c, now);
  if (!r.ok) return r;
  await mergeOthers(r.data, now);
  return { ok: true, data: { case: cardFor(r.data, reporter) } };
}

/** The reporter drops a filed or held case. */
export async function withdrawCase(reporter: string, caseId: number, now = Date.now()): Promise<Result<{ case: CaseCard; refund: number }>> {
  const c = await repo.getCase(caseId);
  if (!c || c.reporter !== reporter) return fail(403, "NOT_YOURS", "That is not your case.");
  if (c.status !== "filed" && c.status !== "held") return fail(409, "GONE", "That case is already closed.");
  const row = await finish(c, "withdrawn", now);
  if (!row) return fail(409, "GONE", "That case is already closed.");
  return { ok: true, data: { case: cardFor(row, reporter), refund: row.fee_state === "refunded" ? row.fee : 0 } };
}

/** The accused settles a filed police case at a station counter, before they are booked. */
export async function payFine(accused: string, caseId: number, now = Date.now()): Promise<Result<{ case: CaseCard }>> {
  const c = await repo.getCase(caseId);
  if (!c || c.accused !== accused) return fail(403, "NOT_YOURS", "That is not your case.");
  if (c.status !== "filed" || now > c.confirm_by) return fail(409, "GONE", "That case is no longer open.");
  if (c.kind !== "police" || c.fine <= 0) return fail(403, "NOT_ALLOWED", "This case cannot be settled with a fine.");
  const me = clientOf(accused);
  if (!me || !stationRooms("police").includes(me.info.room)) return fail(409, "WRONG_PLACE", "Pay the fine at a police station.");
  const row = await finish(c, "settled", now);
  if (!row) return fail(409, "GONE", "That case is no longer open.");
  await charge(accused, STATE.treasury, row.fine, `Fine: case #${row.id}`, "fine");
  return { ok: true, data: { case: cardFor(row, accused) } };
}

/* ------------------------------------------------------------- bail ------------------------------------------------------------- */

/** The prisoner, an accepted friend, or (CUSTODY_BAIL_ANYONE) anyone pays the bail. Closing the case comes first, so two payers cannot both be charged. */
export async function payBail(payer: string, caseId: number, now = Date.now()): Promise<Result<{ case: CaseCard; amount: number; by: "self" | "friend" | "other" }>> {
  const c = await repo.getCase(caseId);
  if (!c) return fail(409, "GONE", "That case is gone.");
  if (c.status === "bailed" && c.paid_by && (await getPlayer(payer))?.name === c.paid_by) return { ok: true, data: { case: cardFor(c, payer), amount: c.paid_amount ?? c.bail, by: payer === c.accused ? "self" : "friend" } };
  if (c.status !== "held") return fail(409, "NOT_HELD", "They are not in custody.");
  let by: "self" | "friend" | "other" = "other";
  if (payer === c.accused) by = "self";
  else if ((await getFriendship(payer, c.accused))?.status === "accepted" && !(await blockedEither(payer, c.accused))) by = "friend";
  else if (!config.custodyBailAnyone || (await blockedEither(payer, c.accused))) return fail(403, "NOT_ALLOWED", "Only their friends can pay their bail.");
  const name = (await getPlayer(payer))?.name ?? "Someone";
  const row = await finish(c, "bailed", now, { paid_by: name, paid_amount: c.bail });
  if (!row) return fail(409, "GONE", "Someone else got there first.");
  await charge(payer, STATE.treasury, row.bail, payer === c.accused ? `Bail: case #${row.id}` : `Bail for ${row.accused_name} (case #${row.id})`, "bail");
  return { ok: true, data: { case: cardFor(row, payer), amount: row.bail, by } };
}

/** Accepted friends who may be asked (not blocked either way). */
async function bailFriends(pid: string): Promise<string[]> {
  const out: string[] = [];
  for (const f of await friendshipsOf(pid)) {
    if (f.status !== "accepted") continue;
    const other = f.a === pid ? f.b : f.a;
    if (!(await blockedEither(pid, other))) out.push(other);
  }
  return out;
}
/** Run `fn` for each friend who was asked about this case. */
function askedFriends(row: CaseRow, fn: (pid: string) => void) {
  if (!row.asks) return;
  void bailFriends(row.accused).then((list) => list.forEach(fn)).catch(() => {});
}
const askMessage = (row: CaseRow, now: number) => ({ t: "bailAsk" as const, caseId: row.id, pid: row.accused, name: row.accused_name, reason: row.reason, bail: row.bail, releaseAt: row.release_at ?? 0, now });

/** The prisoner asks their friends to pay. At most five asks, 45 seconds apart; offline friends see it when they log in. */
export async function askFriends(accused: string, now = Date.now()): Promise<Result<{ notified: number; offline: number; nextAskAt: number }>> {
  const c = held.get(accused);
  if (!c) return fail(409, "NOT_HELD", "You are not in custody.");
  if (c.asks >= RULES.maxAsks || (c.asked_at && now - c.asked_at < RULES.askGapMs)) return fail(429, "ASK_WAIT", "Wait a little before asking again.");
  const row = await repo.transition(c.id, ["held"], "held", { asked_at: now, asks: c.asks + 1 });
  if (!row) return fail(409, "NOT_HELD", "You are not in custody.");
  held.set(accused, row);
  let notified = 0;
  let offline = 0;
  for (const pid of await bailFriends(accused)) {
    if (isOnline(pid)) {
      sendToPid(pid, askMessage(row, now));
      notified++;
    } else offline++;
  }
  tellCustody(accused, row, now);
  return { ok: true, data: { notified, offline, nextAskAt: now + RULES.askGapMs } };
}

/** Friends in custody that this player may bail (everyone, with CUSTODY_BAIL_ANYONE). */
export async function heldFor(viewer: string): Promise<HeldFriend[]> {
  const friends = new Set(await bailFriends(viewer));
  const out: HeldFriend[] = [];
  for (const c of held.values()) {
    if (c.accused === viewer || (!config.custodyBailAnyone && !friends.has(c.accused))) continue;
    out.push({ caseId: c.id, pid: c.accused, name: c.accused_name, reason: c.reason, bail: c.bail, releaseAt: c.release_at ?? 0, asked: c.asks > 0 });
  }
  return out.sort((a, b) => a.releaseAt - b.releaseAt);
}

/* ------------------------------------------------------------ lists ------------------------------------------------------------ */

/** People this player was with in the last ten minutes (the only people the police counter lets them report), plus who hit or poked them. */
export async function recentFor(pid: string, now = Date.now()): Promise<Recent[]> {
  const pokes = pokedOn(pid, now - POKE.evidenceMs, now);
  const hitRows = new Map((await repo.hitsOn(pid, now - POKE.evidenceMs)).map((r) => [r.from, r.n]));
  const ids = new Set<string>();
  for (const [k, at] of met) {
    if (now - at > RULES.meetWindowMs) continue;
    const [a, b] = k.split("|");
    if (a === pid) ids.add(b);
    else if (b === pid) ids.add(a);
  }
  for (const from of hitRows.keys()) ids.add(from);
  for (const from of pokes.keys()) ids.add(from);
  const out: Recent[] = [];
  for (const other of ids) {
    if (other === pid || (await blockedEither(pid, other))) continue;
    const p = await getPlayer(other);
    if (!p) continue;
    const mem = pokes.get(other);
    out.push({ pid: other, name: p.name, username: p.username, lastMet: lastMet(pid, other), online: isOnline(other), hitMe: Math.max(hitRows.get(other) ?? 0, mem?.hits ?? 0), pokedMe: (mem?.hits ?? 0) + (mem?.pokes ?? 0) });
  }
  return out.sort((a, b) => b.lastMet - a.lastMet);
}

/** People this player sent money to lately (the EFCC counter's picker). */
export async function payeesFor(pid: string, now = Date.now()): Promise<Payee[]> {
  const out: Payee[] = [];
  for (const r of await repo.payeesOf(pid, now - RULES.efcc.windowMs)) {
    if (r.total < RULES.efcc.minTransfer) continue;
    const p = await getPlayer(r.to_pid);
    if (!p) continue;
    const back = await repo.sentBetween(r.to_pid, pid, now - RULES.efcc.windowMs);
    out.push({ pid: r.to_pid, name: p.name, username: p.username, total: r.total, count: r.n, lastAt: r.last_at, repaid: back.total });
  }
  return out;
}

/** EFCC auto-settle: a payment from the accused to the reporter that covers enough of the money settles an open case. */
export async function onTransfer(from: string, to: string, amount: number, now = Date.now()): Promise<void> {
  void amount;
  if (!config.custody || !config.custodyEfcc) return;
  for (const c of await repo.filedAgainst(from, 0)) {
    if (c.kind !== "efcc" || c.reporter !== to) continue;
    if (await repaidEnough(c)) await finish(c, "settled", now);
  }
}

/* --------------------------------------------------------- connect and tick --------------------------------------------------------- */

/** Load the held cases and rebuild the timers; with CUSTODY off, let everybody out. Called once, before listening. */
export async function initCustody(now = Date.now()): Promise<void> {
  held.clear();
  const rows = await repo.loadHeld();
  if (!config.custody) {
    for (const r of rows) await repo.transition(r.id, ["held"], "dismissed", { closed_at: now, note: "custody switched off" });
    if (rows.length) console.log(`[custody] CUSTODY is off: released ${rows.length} held player(s)`);
    return;
  }
  for (const r of rows) held.set(r.accused, r); // the release timer is the tick reading release_at
}

/** First connect of a player: pin a held player to the prison and send `custody` (null when free), and replay bail asks to their friends. */
export async function onConnect(c: Client, now = Date.now()): Promise<void> {
  const mine = held.get(c.info.pid);
  if (mine) placeInCell(c, mine, now);
  else tx(c.ws, { t: "custody", c: null, now });
  if (!config.custody) return;
  for (const row of held.values()) {
    if (row.asks > 0 && row.accused !== c.info.pid && (await getFriendship(c.info.pid, row.accused))?.status === "accepted" && !(await blockedEither(c.info.pid, row.accused))) tx(c.ws, askMessage(row, now));
  }
}

let lastLapse = 0;
let lastPurge = 0;
/** Every second: let out those whose time is up. Every 10 seconds: lapse filed cases nobody booked. Every hour: forget old hits. */
export async function tickCustody(now = Date.now()): Promise<void> {
  if (!config.custody) return;
  for (const c of [...held.values()]) if ((c.release_at ?? 0) <= now) await finish(c, "served", now);
  if (now - lastLapse >= 10_000) {
    lastLapse = now;
    for (const c of await repo.loadFiled()) if (c.confirm_by < now) await finish(c, "expired", now);
  }
  if (now - lastPurge >= HOUR) {
    lastPurge = now;
    await repo.purgeHits(now - 24 * HOUR).catch(() => {});
  }
}

/* -------------------------------------------------------- moderators -------------------------------------------------------- */

/** A moderator closes a case: the accused is let out, any bail is refunded, the reporter's fee is kept and (optionally) their reporting suspended. */
export async function adminDismiss(caseId: number, note: string, banHours: number, now = Date.now()): Promise<Result<{ case: CaseCard }>> {
  const c = await repo.getCase(caseId);
  if (!c) return fail(404, "GONE", "No such case.");
  if (c.status !== "filed" && c.status !== "held") return fail(409, "GONE", "That case is already closed.");
  const row = await finish(c, "dismissed", now, { note: note.slice(0, 200) });
  if (!row) return fail(409, "GONE", "That case is already closed.");
  if (banHours > 0) await repo.setPoliceBan(row.reporter, now + banHours * HOUR);
  return { ok: true, data: { case: cardFor(row, row.reporter) } };
}

/** Let everyone out at once (an emergency). */
export async function adminReleaseAll(note: string, now = Date.now()): Promise<number> {
  let n = 0;
  for (const c of [...held.values()]) if (await finish(c, "dismissed", now, { note: note.slice(0, 200) })) n++;
  return n;
}

/** The cases a moderator can list. */
export const adminCases = (status: string) => repo.casesByStatus(status);
/** A player's own cases, newest first, as they see them. */
export async function casesOf(pid: string): Promise<CaseCard[]> {
  return (await repo.casesFor(pid)).map((c) => cardFor(c, pid));
}
