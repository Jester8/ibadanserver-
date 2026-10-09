import { MIN } from "./custodyRules";
import type { LoanView, PlotState } from "./protocol";

/*
 * Rules and numbers for bank loans and for selling property back to the city. IDENTICAL in both repos (client src/lib and
 * server src/lib), like protocol.ts. The server uses it to decide; the client uses it to show the same numbers.
 * scripts/check-money.ts (client) proves the tables below still match plots.ts, business.ts, decor.ts and titles.ts.
 */

/* ------------------------------------------------ land and what it is worth ------------------------------------------------ */

/** Price of one plot by the start of its id (plot ids are "<district>-<n>", for example "bodija-estate-12" or "dugbe-1"). */
export const LAND_PRICE: Record<string, number> = {
  "bodija-estate": 180_000, "jericho-gra": 260_000, "oluyole-estate": 220_000, "iyaganku-heights": 230_000,
  agbowo: 45_000, mokola: 85_000, dugbe: 320_000, challenge: 60_000, oluyole: 150_000, "iyaganku-gra": 200_000,
  samonda: 90_000, ojoo: 70_000, "akobo-estate": 55_000, oje: 50_000, sango: 65_000, beere: 75_000, apata: 60_000,
  "odo-ona": 48_000, moniya: 40_000, "iwo-road": 52_000, "adamasingba-east": 140_000, sapati: 58_000,
};
/** Cost of building a house, by tier (index = tier; each tier is paid on top of the one before). */
export const TIER_COST = [0, 15_000, 60_000, 180_000] as const;
/** Cost of a business built on empty land. */
export const BIZ_COST: Record<string, number> = { shop: 25_000, salon: 45_000, cafe: 90_000, pharmacy: 150_000, gym: 220_000, mart: 300_000 };
export const DECOR_PRICE: Record<string, number> = { plant: 6_000, wallart: 8_000, calabash: 7_000, lamp: 9_000, carvedstool: 12_000, rug: 15_000, ibeji: 25_000 };
/** Reputation needed for each title (titles.ts). */
export const TITLE_REPS = [0, 25, 70, 140, 240, 380, 560, 800] as const;
export const titleIndexOf = (rep: number): number => (TITLE_REPS as readonly number[]).reduce((idx, r, i) => (rep >= r ? i : idx), 0);

export const landPrefix = (plotId: string) => plotId.replace(/-\d+$/, "");
export const landPrice = (plotId: string) => LAND_PRICE[landPrefix(plotId)] ?? 0;

type Built = Pick<PlotState, "tier" | "biz">;
/** What was spent building on the land: the business, or each house tier up to the current one. */
export function builtCost(p: Built): number {
  if (p.biz) return BIZ_COST[p.biz] ?? 0;
  let n = 0;
  for (let t = 1; t <= Math.min(3, Math.max(0, Math.floor(p.tier))); t++) n += TIER_COST[t];
  return n;
}
/** Land plus what stands on it: what the owner paid. Decor is not counted. */
export const paidValue = (plotId: string, p: Built) => landPrice(plotId) + builtCost(p);
export const decorValue = (p: Pick<PlotState, "decor">) => (p.decor ?? []).reduce((a, d) => a + (DECOR_PRICE[d] ?? 0), 0);

/** Selling back to the city: a share of what was paid. Rounded down to ₦100. */
export const SALE = { land: 0.6, built: 0.5, decor: 0.25, round: 100, max: 450_000, minGapMs: 3_000 } as const;
export function saleValue(plotId: string, p: Built & Pick<PlotState, "decor">): { land: number; built: number; decor: number; gross: number } {
  const land = Math.floor(landPrice(plotId) * SALE.land);
  const built = Math.floor(builtCost(p) * SALE.built);
  const decor = Math.floor(decorValue(p) * SALE.decor);
  const gross = Math.min(SALE.max, Math.floor((land + built + decor) / SALE.round) * SALE.round);
  return { land, built, decor, gross };
}
/** The reputation buying and building on this plot gave (buyPlot +10, a business +10, each house tier +8 x tier). Selling takes it back, so land cannot be flipped for reputation. */
export function repEarned(p: Built): number {
  if (p.biz) return 20;
  let n = 10;
  for (let t = 1; t <= Math.min(3, Math.max(0, Math.floor(p.tier))); t++) n += 8 * t;
  return n;
}

/* ------------------------------------------------------ loans ------------------------------------------------------ */

export const LOAN = {
  minAmount: 5_000,
  step: 1_000,
  hardCap: 400_000,
  /** the credit limit: a base for the player's title, plus this share of what their land and businesses cost */
  titleBase: [10_000, 25_000, 50_000, 80_000, 120_000, 170_000, 230_000, 300_000],
  collateralShare: 0.4,
  /** 10 basis points = 0.10% of the unpaid principal every minute = 6% an hour (simple interest, never on interest) */
  rateBpm: 10,
  /** after the due time interest runs at this many times the normal rate */
  penaltyMul: 2,
  /** unpaid interest and fees together never go past this share of the amount borrowed */
  capShare: 1,
  /** added once, when the loan first goes overdue: this share of the principal still unpaid */
  lateFeeShare: 0.05,
  /** reputation lost, once, when a loan first goes overdue */
  repHit: 5,
  /** repayment terms in minutes */
  terms: [60, 180, 360],
  defaultTerm: 180,
  /** the final notice is served this long after the due time, to a player who is online */
  noticeAfterDueMin: 30,
  /** the lien is placed this long after the final notice */
  seizeAfterNoticeMin: 30,
  /** server: the account must be this old to borrow */
  minAccountAgeMs: 30 * MIN,
  /** server: wait this long after paying a loan off before borrowing again */
  cooldownMs: 5 * MIN,
  /** server: wait this long after a lien before borrowing again (counted from when the loan was cleared) */
  lockoutAfterSeizureMs: 60 * MIN,
  /** server: least time between two loan requests from one player */
  minGapMs: 2_000,
  /** the bank does not put a lien on a plot over a debt this small */
  seizeFloor: 2_000,
} as const;

/** The part of a loan the arithmetic needs. LoanView has all of it. */
export type LoanMath = Pick<LoanView, "principal" | "left" | "interest" | "at" | "dueAt" | "rateBpm" | "lateFee">;

/** The numbers for a brand new loan. `at` is the first whole minute after it was taken, so nobody pays for a part-minute. */
export function newLoan(amount: number, termMin: number, now: number): LoanMath & { takenAt: number } {
  const principal = Math.floor(amount);
  return { principal, left: principal, interest: 0, at: Math.ceil(now / MIN) * MIN, dueAt: now + termMin * MIN, rateBpm: LOAN.rateBpm, lateFee: false, takenAt: now };
}

/**
 * Bring the interest up to `now`, a whole minute at a time. Before the due time a minute costs rateBpm of the unpaid principal;
 * after it, penaltyMul times that. The one-off late fee is added the first time a minute after the due time has been counted.
 * Unpaid interest plus the fee never exceeds capShare x the amount borrowed.
 */
export function accrue<T extends LoanMath>(l: T, now: number): T {
  const m0 = Math.floor(l.at / MIN);
  const m1 = Math.floor(now / MIN);
  if (m1 <= m0) return l;
  const mDue = Math.ceil(l.dueAt / MIN);
  const normal = Math.max(0, Math.min(m1, mDue) - m0);
  const late = Math.max(0, m1 - Math.max(m0, mDue));
  let interest = l.interest + Math.floor((l.left * l.rateBpm * (normal + LOAN.penaltyMul * late)) / 10_000);
  let lateFee = l.lateFee;
  if (!lateFee && m1 > mDue) {
    interest += Math.round(l.left * LOAN.lateFeeShare);
    lateFee = true;
  }
  interest = Math.min(interest, Math.round(l.principal * LOAN.capShare));
  return { ...l, interest, lateFee, at: m1 * MIN };
}

/** Everything owed right now: unpaid principal plus interest and fees. */
export const owedNow = (l: LoanMath, now: number) => {
  const a = accrue(l, now);
  return a.left + a.interest;
};

/** Pay `amount` (any amount): interest and fees first, then principal. Never takes more than is owed. */
export function applyPayment<T extends LoanMath>(l: T, amount: number, now: number): { loan: T; paid: number; closed: boolean } {
  const a = accrue(l, now);
  const owed = a.left + a.interest;
  const paid = Math.max(0, Math.min(Math.floor(amount), owed));
  const toInterest = Math.min(paid, a.interest);
  const loan = { ...a, interest: a.interest - toInterest, left: a.left - (paid - toInterest) };
  return { loan, paid, closed: loan.left === 0 && loan.interest === 0 };
}

/** What a loan would cost: used by the offer screen. `afterMin` minutes after taking it (0 = at once). */
export function owedAfter(amount: number, termMin: number, afterMin: number): number {
  const t0 = 0;
  return owedNow(newLoan(amount, termMin, t0), t0 + afterMin * MIN);
}

/** The credit limit for a title (0..7, titleIndexOf) and the value of the land and businesses the player owns. */
export function creditLimit(titleIdx: number, collateral: number): number {
  const base = LOAN.titleBase[Math.max(0, Math.min(LOAN.titleBase.length - 1, titleIdx))];
  const raw = base + Math.floor((collateral * LOAN.collateralShare) / 1000) * 1000;
  return Math.min(LOAN.hardCap, raw);
}
/** What the player's property cost in all (land and what stands on it), not counting plots under lien. */
export function collateralOf(plots: Record<string, PlotState>, pid: string): number {
  let n = 0;
  for (const [id, p] of Object.entries(plots)) if (p.ownerId === pid && !p.seized) n += paidValue(id, p);
  return n;
}
/** The amounts the slider offers: from minAmount to the limit in steps. */
export const loanAmounts = (limit: number): number[] => {
  const out: number[] = [];
  for (let a = LOAN.minAmount; a <= Math.min(limit, LOAN.hardCap); a += LOAN.step) out.push(a);
  return out;
};
