import type { CaseCard, CaseKind, CaseReason, CustodyView } from "./protocol";

/**
 * Rules and constants for police cases, the EFCC and custody. IDENTICAL in the client and the server repo
 * (src/lib/custodyRules.ts in both; `diff -q` them before every release, like protocol.ts).
 */

export const MIN = 60_000;
export const HOUR = 60 * MIN;

/** Keep equal to S in furniture.ts (interiors are drawn at this scale). */
export const INTERIOR_SCALE = 0.56;
/** The lockup. Its place id is also the interior id and the chat/voice room suffix. */
export const PRISON_ID = "prison";
export const PRISON_ROOM = `in:place:${PRISON_ID}`;
/** Where a case of each kind is booked. Place ids from placesCivic.ts. */
export const STATIONS: Record<CaseKind, string[]> = { police: ["police-dugbe", "police-mokola"], efcc: ["efcc"] };
export const stationRooms = (k: CaseKind) => STATIONS[k].map((id) => `in:place:${id}`);
/** Where each cell's prisoner stands, in layout metres (x, z). Must match the `cells` of the prison layout (layoutsLaw.ts). */
export const CELL_SPAWNS: [number, number][] = [[-6, -3], [0, -3], [6, -3]];

/** Pseudo-accounts on the transfers ledger. They are not players and can never be a bank target. */
export const STATE = { treasury: "state:treasury", police: "state:police", efcc: "state:efcc", bank: "state:bank", city: "state:city" } as const;
export const STATE_NAME: Record<string, string> = {
  [STATE.treasury]: "Oyo State Treasury",
  [STATE.police]: "Nigeria Police Force",
  [STATE.efcc]: "EFCC",
  [STATE.bank]: "Omo'badan Bank",
  [STATE.city]: "Ibadan City Council",
};
export const stateName = (pid: string): string | undefined => STATE_NAME[pid];
/** transfers.kind values that are money moving to or from the state. They do not count towards the daily send limit. */
export const STATE_KINDS = ["fee", "fine", "bail", "refund", "loan", "repay", "landsale"] as const;

export const REASONS: Record<CaseReason, { kind: CaseKind; label: string; blurb: string; bail: number; holdMin: number; fee: number }> = {
  loitering: { kind: "police", label: "Wandering around", blurb: "Hanging about with no good reason.", bail: 2_500, holdMin: 5, fee: 500 },
  disturbance: { kind: "police", label: "Disturbing people", blurb: "Making a nuisance of themselves.", bail: 5_000, holdMin: 10, fee: 1_000 },
  assault: { kind: "police", label: "Hit me", blurb: "They hit me in the game (the game saw it).", bail: 7_500, holdMin: 10, fee: 1_500 },
  harassment: { kind: "police", label: "Harassing someone", blurb: "Insults, threats or pestering.", bail: 10_000, holdMin: 15, fee: 2_000 },
  scam: { kind: "efcc", label: "Took my money and vanished", blurb: "I sent money and got nothing back.", bail: 25_000, holdMin: 20, fee: 5_000 },
  fraud: { kind: "efcc", label: "Suspicious transfers", blurb: "They are collecting money from many people.", bail: 40_000, holdMin: 20, fee: 5_000 },
};

/** The reasons a player can pick at a police counter or from a player's card, in the order shown. "assault" is offered only after a hit. */
export const POLICE_REASONS: CaseReason[] = ["loitering", "disturbance", "assault", "harassment"];

export const RULES = {
  confirmWindowMs: 10 * MIN, // a filed case must be booked within this
  undoWindowMs: 60_000, // withdraw this fast and the fee is refunded
  efccGraceMs: 3 * MIN, // EFCC: the other side may repay before booking
  minAccountAgeMs: 60 * MIN, // to file at all
  corroboratorAgeMs: 24 * HOUR, // a report counts as corroboration only from older accounts
  fileGapMs: 60_000, // between two filings by one reporter
  maxFiledPerHour: 3,
  maxFiledPerDay: 8,
  maxOpenFiled: 2,
  sameDirectionCooldownMs: 20 * MIN,
  rearrestImmunityMs: 10 * MIN, // after any release nobody can hold that player again for this long
  maxHoldsPerDay: 4, // beyond this, reports are referred to moderators
  fastTrackPriors: 2, // a player with this many holds in 24 h is booked on the first report
  corroborateReporters: 2,
  corroborateWindowMs: 10 * MIN,
  meetWindowMs: 10 * MIN, // you can report someone you were with in the last 10 minutes
  meetRange: 8, // world units (about 200 m) outside; inside, the same room
  hold: { policeCapMin: 15, efccCapMin: 20, perPriorMin: 2 },
  bailCap: 150_000,
  priorStep: 0.5,
  priorMax: 4,
  askGapMs: 45_000,
  maxAsks: 5,
  efcc: {
    windowMs: 48 * HOUR,
    minTransfer: 5_000,
    ledgerMinAgeMs: 10 * MIN,
    repaidShare: 0.5,
    fraudSenders: 3,
    fraudTotal: 50_000,
    disputedBailShare: 0.1,
    disputedBailCap: 100_000,
    watchMs: 24 * HOUR,
    watchDailyCap: 50_000,
  },
} as const;

export const roundTo = (n: number, step: number) => Math.round(n / step) * step;

/** Bail for a new hold: base (+ a share of the disputed amount for the EFCC) times the repeat-offence multiplier. */
export function bailFor(reason: CaseReason, priors: number, disputed = 0): number {
  const r = REASONS[reason];
  const base = r.bail + (r.kind === "efcc" ? Math.min(RULES.efcc.disputedBailCap, Math.round(disputed * RULES.efcc.disputedBailShare)) : 0);
  return Math.min(RULES.bailCap, roundTo(base * (1 + RULES.priorStep * Math.min(priors, RULES.priorMax)), 500));
}
/** How long a hold lasts at most. Never more than 20 minutes. */
export function holdMsFor(reason: CaseReason, priors: number): number {
  const r = REASONS[reason];
  const cap = r.kind === "efcc" ? RULES.hold.efccCapMin : RULES.hold.policeCapMin;
  return Math.min(cap, r.holdMin + RULES.hold.perPriorMin * priors) * MIN;
}
/** Fine to settle a police case before booking: half the base bail. EFCC cases have none. */
export const fineFor = (reason: CaseReason): number => (REASONS[reason].kind === "police" ? Math.ceil((REASONS[reason].bail * 0.5) / 250) * 250 : 0);

/* ---- REST payloads (client and server share these) ---- */
export type CustodyErrorCode =
  | "OFF" | "AUTH" | "BAD" | "TOO_NEW" | "BANNED" | "IN_CUSTODY" | "BLOCKED" | "NO_SUCH_PLAYER" | "NOT_NEARBY" | "NO_EVIDENCE"
  | "RATE" | "DAILY" | "OPEN_PAIR" | "ALREADY_HELD" | "IMMUNE" | "WRONG_PLACE" | "TOO_EARLY" | "OFFLINE" | "GONE"
  | "NOT_YOURS" | "NOT_ALLOWED" | "ASK_WAIT" | "NOT_HELD";
export type ApiError = { error: string; code: CustodyErrorCode };
export type ReportBody = { accused: string; reason: CaseReason; via?: "player" | "chat" | "counter" | "bank" | "poke" };
export type ReportResult = { case: CaseCard; held: boolean; fee: number; referred?: boolean };
export type MeResult = {
  /** CUSTODY=1 on the server */
  enabled: boolean;
  /** the money cases (scam, fraud) are on: CUSTODY_EFCC=1 on the server. When false the EFCC counter says money cases are not open yet. */
  efcc: boolean;
  now: number;
  custody: CustodyView | null;
  cases: CaseCard[];
  standing: { filedLastHour: number; maxPerHour: number; banUntil: number | null; watchUntil: number | null };
};
export type Recent = { pid: string; name: string; username: string | null; lastMet: number; online: boolean; /** times they hit me in the last 10 minutes, and times they poked or hit me */ hitMe: number; pokedMe: number };
export type Payee = { pid: string; name: string; username: string | null; total: number; count: number; lastAt: number; repaid: number };
export type HeldFriend = { caseId: number; pid: string; name: string; reason: CaseReason; bail: number; releaseAt: number; asked: boolean };
