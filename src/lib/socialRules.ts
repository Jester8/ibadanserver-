import type { CustodyErrorCode } from "./custodyRules";
import { MIN } from "./custodyRules";

/*
 * Rules for pokes and hits, the switches the server reports, and the error codes of the loan and property routes.
 * IDENTICAL in both repos (client src/lib and server src/lib), like protocol.ts and custodyRules.ts.
 */

/* ---- pokes and hits ---- */
export const POKE = {
  /** the server accepts a poke when the two are this close (world units; an avatar is about 1 unit tall) */
  range: 2.6,
  /** the player card shows the buttons inside this distance */
  nearUi: 2.0,
  /** both must have been in the room this long (no ambush the moment someone walks in) */
  inRoomMs: 1_500,
  /** least time between two of the same kind from one player, to anyone */
  gapMs: { poke: 2_000, hit: 10_000 },
  /** least time between two of the same kind from one player to the same person */
  pairGapMs: { poke: 6_000, hit: 30_000 },
  /** at most this many to one person in the window, from one player */
  pairWindowMs: 10 * MIN,
  pairMax: { poke: 5, hit: 3 },
  /** at most this many pokes and hits of any kind from one player to anyone */
  anyWindowMs: 5 * MIN,
  anyMax: 20,
  /** at most this many hits to anyone */
  hitWindowMs: 10 * MIN,
  hitMax: 6,
  /** a hit needs an account this old */
  hitMinAgeMs: 10 * MIN,
  /** what a hit costs the one who was hit (needs points, 0 to 100), for the first `victimMaxCharged` hits in the window; a poke costs nothing */
  victimFun: -6,
  victimSocial: -3,
  victimMaxCharged: 3,
  victimWindowMs: 10 * MIN,
  /** what a hit costs the one who did it */
  attackerEnergy: -3,
  /** how long the alert (with its Report button) stays up */
  alertMs: 12_000,
  /** a report for "assault" needs a hit by the accused on the reporter this recent; for "harassment" pokes and hits both count */
  evidenceMs: 10 * MIN,
  /** someone who reported you (a case still open, or closed this recently) cannot be poked or hit by you */
  reportShieldMs: 10 * MIN,
  /** the little bubble over the head */
  fxMs: 2_500,
  /** this many pokes and hits from one person in the evidence window make "harassment" reportable from the alert */
  harassCount: 3,
} as const;

/** What the client says for each reason the server can give. */
export const POKE_DENY_TEXT: Record<string, string> = {
  off: "Pokes are switched off right now.",
  declined: "They are not taking pokes right now.",
  far: "Get closer first.",
  cooldown: "Easy. Give it a moment.",
  limit: "That is enough pokes for now.",
  young: "Hits unlock after your first 10 minutes in Ibadan.",
  custody: "Not while someone is in custody.",
  prison: "No pokes inside the prison.",
  reported: "You cannot do that to someone who has just reported you.",
};

/* ---- the EFCC office keeps office hours (events.ts HOURS.efcc = [8, 17]), so a money case may only be filed while there is still time to book it ---- */
export const EFCC_HOURS = { open: 8, close: 17, lastFilingBeforeCloseMin: 10 } as const;
/** Hour of day on the Ibadan clock (WAT, UTC+1, no daylight saving), 0 to 24: the clock time.ts uses. */
export const watHour = (now: number) => (((now + 3_600_000) % 86_400_000) / 86_400_000) * 24;
/** Can a money case be filed right now? 08:00 to 16:50 Ibadan time. Police cases have no such limit (the stations never close). */
export const efccFilingOpen = (now: number): boolean => {
  const h = watHour(now);
  return h >= EFCC_HOURS.open && h < EFCC_HOURS.close - EFCC_HOURS.lastFilingBeforeCloseMin / 60;
};

/* ---- switches ---- */
/** Which social features this server has switched on. GET /api/social/flags. A server that answers 404 has none of them. */
export type SocialFlags = { custody: boolean; efcc: boolean; pokes: boolean; loans: boolean; sales: boolean; now: number };

/* ---- the routes added for loans and property ---- */
export type SocialErrorCode = CustodyErrorCode | "OFFICE_CLOSED" | "LOAN_ACTIVE" | "LOAN_NONE" | "LOAN_LIMIT" | "LOAN_MIN" | "LOAN_LOCKED" | "LOAN_TERM" | "NOT_OWNER" | "FROZEN" | "INSIDE" | "NO_PLOT";
export type SocialError = { error: string; code: SocialErrorCode };
/** What the server modules hand back to their HTTP handlers. */
export type Result<T> = { ok: true; data: T } | { ok: false; status: number; code: SocialErrorCode; error: string };
