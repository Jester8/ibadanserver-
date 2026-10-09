import type { C2S, PokeDeny, PokeKind, PokeMode, S2C } from "../src/lib/protocol";
import { PRISON_ROOM } from "../src/lib/custodyRules";
import { POKE } from "../src/lib/socialRules";
import { config } from "./config";
import { blockedEither, getFriendship } from "./db/repo";
import { caseBetweenRecent, countHits, insertHit, playerMeta, setPokeModeRow } from "./db/repoCustody";
import { clients, sendToPid, tx, type Client } from "./presence";
import { isHeld } from "./custody";

/*
 * Pokes and hits. A player close to another can poke (a nudge) or hit (a small fun and social loss for the victim). The
 * server decides everything it can: who is close, who is allowed, how often. The victim can switch it off, block, or report.
 * Pokes are kept in memory only; hits are also written down, because they are the evidence for an "assault" report.
 */

type Ev = { at: number; to: string; kind: PokeKind };
/** what each player has done in the last ten minutes, by player id, oldest first */
const done = new Map<string, Ev[]>();
let seq = 0;

/** The most that is ever looked back at (the longest of the windows in POKE). */
const KEEP = Math.max(POKE.pairWindowMs, POKE.anyWindowMs, POKE.hitWindowMs, POKE.evidenceMs);

function recent(pid: string, now: number): Ev[] {
  const list = (done.get(pid) ?? []).filter((e) => now - e.at < KEEP);
  if (list.length) done.set(pid, list);
  else done.delete(pid);
  return list;
}

/** The pokes and hits one player has made on another since `since`, and the hits on record (the database keeps those). */
export async function pokeEvidence(from: string, to: string, since: number, now = Date.now()): Promise<{ hits: number; pokes: number }> {
  const pokes = recent(from, now).filter((e) => e.to === to && e.at > since && e.kind === "poke").length;
  return { hits: await countHits(from, to, since), pokes };
}

/** What each person has done to `to` lately (for the "recently met" list). Hits come from memory; the caller may add the database's. */
export function pokedOn(to: string, since: number, now = Date.now()): Map<string, { hits: number; pokes: number }> {
  const out = new Map<string, { hits: number; pokes: number }>();
  for (const [from] of done) {
    for (const e of recent(from, now)) {
      if (e.to !== to || e.at <= since) continue;
      const row = out.get(from) ?? { hits: 0, pokes: 0 };
      if (e.kind === "hit") row.hits++;
      else row.pokes++;
      out.set(from, row);
    }
  }
  return out;
}

const dist = (a: Client, b: Client) => Math.hypot(a.info.x - b.info.x, a.info.z - b.info.z);

/** Why this poke is not allowed, or null. The first failing check is the answer. */
async function deny(c: Client, target: Client | undefined, kind: PokeKind, now: number): Promise<{ deny: PokeDeny; retryMs?: number } | null> {
  if (!config.pokes) return { deny: "off" };
  if (!target || target.lingering || target.info.pid === c.info.pid) return { deny: "far" };
  if (isHeld(c.info.pid) || isHeld(target.info.pid)) return { deny: "custody" };
  if (c.info.room === PRISON_ROOM || target.info.room === PRISON_ROOM) return { deny: "prison" };
  if (c.info.room !== target.info.room || now - c.roomAt < POKE.inRoomMs || now - target.roomAt < POKE.inRoomMs || dist(c, target) > POKE.range) return { deny: "far" };
  // one word for "switched off", "friends only" and "blocked", so a block is never revealed
  if (target.pokeMode === "off") return { deny: "declined" };
  if (target.pokeMode === "friends" && (await getFriendship(c.info.pid, target.info.pid))?.status !== "accepted") return { deny: "declined" };
  if (await blockedEither(c.info.pid, target.info.pid)) return { deny: "declined" };
  // someone who has just reported you cannot be poked or hit by you
  if (config.custody && (await caseBetweenRecent(target.info.pid, c.info.pid, now - POKE.reportShieldMs))) return { deny: "reported" };
  if (kind === "hit" && c.createdAt > 0 && now - c.createdAt < POKE.hitMinAgeMs) return { deny: "young" };

  const mine = recent(c.info.pid, now);
  const ofKind = mine.filter((e) => e.kind === kind);
  // cooldowns come first: they beat the caps and tell the player how long to wait
  const lastAny = ofKind.at(-1);
  const lastPair = ofKind.filter((e) => e.to === target.info.pid).at(-1);
  const wait = Math.max(lastAny ? POKE.gapMs[kind] - (now - lastAny.at) : 0, lastPair ? POKE.pairGapMs[kind] - (now - lastPair.at) : 0);
  if (wait > 0) return { deny: "cooldown", retryMs: wait };
  if (ofKind.filter((e) => e.to === target.info.pid && now - e.at < POKE.pairWindowMs).length >= POKE.pairMax[kind]) return { deny: "limit" };
  if (mine.filter((e) => now - e.at < POKE.anyWindowMs).length >= POKE.anyMax) return { deny: "limit" };
  if (kind === "hit" && mine.filter((e) => e.kind === "hit" && now - e.at < POKE.hitWindowMs).length >= POKE.hitMax) return { deny: "limit" };
  return null;
}

/** A `poke` message from a connected player. Validates everything, then sends poked / pokeAck / pokeFx. */
export async function handlePoke(c: Client, m: Extract<C2S, { t: "poke" }>, now = Date.now()): Promise<void> {
  const kind: PokeKind | null = m.kind === "poke" || m.kind === "hit" ? m.kind : null;
  if (!kind || typeof m.to !== "string") return;
  const target = clients.get(m.to);
  const no = await deny(c, target, kind, now);
  if (no || !target) {
    tx(c.ws, { t: "pokeAck", to: m.to, kind, ok: false, deny: no?.deny ?? "far", ...(no?.retryMs ? { retryMs: Math.ceil(no.retryMs) } : {}) });
    return;
  }
  const list = done.get(c.info.pid) ?? [];
  list.push({ at: now, to: target.info.pid, kind });
  done.set(c.info.pid, list);
  if (kind === "hit") await insertHit(now, c.info.pid, target.info.pid, c.info.room).catch((e) => console.error("[pokes]", e));

  // how many times this player has poked or hit this one lately, this one included
  const count = recent(c.info.pid, now).filter((e) => e.to === target.info.pid && now - e.at < POKE.evidenceMs).length;
  sendToPid(target.info.pid, { t: "poked", id: ++seq, from: c.info.id, fromPid: c.info.pid, name: c.info.name, kind, at: now, recent: count, canReport: config.custody && (kind === "hit" || count >= POKE.harassCount) });
  tx(c.ws, { t: "pokeAck", to: m.to, kind, ok: true });
  // the little bubble: everyone in the room within 12 units (both of them included)
  const fx: S2C = { t: "pokeFx", from: c.info.id, to: target.info.id, kind };
  for (const other of clients.values()) {
    if (other.info.room !== c.info.room) continue;
    if (other === c || other === target || dist(other, c) <= 12) tx(other.ws, fx);
  }
}

/** A `pokeMode` message: save it and echo it back. */
export async function handlePokeMode(c: Client, mode: PokeMode): Promise<void> {
  if (mode !== "all" && mode !== "friends" && mode !== "off") return;
  await setPokeModeRow(c.info.pid, mode).catch((e) => console.error("[pokes]", e));
  c.pokeMode = mode;
  sendToPid(c.info.pid, { t: "pokeMode", mode });
}

/** First connect: read the saved mode and the account's age into the client record, and tell the player the mode. */
export async function onPokeConnect(c: Client): Promise<void> {
  const meta = await playerMeta(c.info.pid).catch(() => undefined);
  c.createdAt = meta?.created_at ?? 0;
  c.pokeMode = meta?.poke_mode === "friends" || meta?.poke_mode === "off" ? meta.poke_mode : "all";
  tx(c.ws, { t: "pokeMode", mode: c.pokeMode });
}

/** Forget a player's log (tests, and a player who left for good). */
export const forgetPokes = (pid?: string) => (pid ? void done.delete(pid) : done.clear());
