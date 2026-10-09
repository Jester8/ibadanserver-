import { STATE, stateName } from "../src/lib/custodyRules";
import { SALE, landPrefix, repEarned, saleValue } from "../src/lib/moneyRules";
import type { Result, SocialErrorCode } from "../src/lib/socialRules";
import { BIZ_INFO } from "./business";
import { config } from "./config";
import { isHeld } from "./custody";
import { activeLoan, loadReleases, sellPlotRows } from "./db/repoMoney";
import { done, fail, planSalePayment, settleSale, tooSoon, withPidLock } from "./loans";
import { broadcast, clients, plots, sendToPid } from "./presence";

/*
 * Selling land back to the city. The server works out the price from the shared tables (the client's sheet shows the same
 * numbers), frees the plot, and pays through the transfers ledger: cash is a credit, and with a loan the bank is paid first.
 * A plot that was sold is remembered, so a device that still thinks it owns it cannot claim it back (and be paid twice).
 */

/** plot id -> who sold it to the city and when (epoch ms). Loaded at boot, kept up to date by every sale. */
const released = new Map<string, { by: string; at: number }>();

/** Load the record of plots sold back to the city. Called once, before listening. */
export async function initProperty(): Promise<void> {
  released.clear();
  for (const r of await loadReleases()) released.set(r.plot_id, { by: r.by_pid, at: r.at });
}

/**
 * True when a plotSet that claims an empty plot must be refused because it is a stale claim: this player sold the plot to the
 * city after `collectedAt`, so a device that still remembers owning it is trying to take it back. A real purchase has
 * collectedAt = now, which is after the sale, and passes.
 */
export const claimBlocked = (plotId: string, pid: string, collectedAt: number): boolean => {
  const r = released.get(plotId);
  return !!r && r.by === pid && !(collectedAt > r.at);
};

/** The one thing property needs to know about custody; tests hand in their own. */
export type SaleDeps = { isHeld: (pid: string) => boolean };
const realDeps: SaleDeps = { isHeld };

export type SaleBlock = { code: SocialErrorCode; text: string };
export type SaleQuote = { plotId: string; gross: number; parts: { land: number; built: number; decor: number }; loanPaid: number; net: number; repBack: number; blocked: SaleBlock | null; now: number };
export type SaleDone = { plotId: string; gross: number; loanPaid: number; net: number; repBack: number; now: number };

const NO_PLOT = "There is no such plot.";
const statusOf: Partial<Record<SocialErrorCode, number>> = { NOT_OWNER: 403, FROZEN: 403, INSIDE: 409, BAD: 400 };
const districtName = (plotId: string) => landPrefix(plotId).split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

/** Why this plot cannot be sold by this player right now, or null. */
function blockOf(pid: string, plotId: string, deps: SaleDeps): SaleBlock | null {
  const plot = plots[plotId];
  if (plot.ownerId !== pid) return { code: "NOT_OWNER", text: "That is not your property." };
  if (deps.isHeld(pid)) return { code: "FROZEN", text: "Your assets are frozen while you are in custody." };
  if (saleValue(plotId, plot).gross <= 0) return { code: "BAD", text: "This property cannot be sold." };
  for (const c of clients.values()) {
    if (c.info.room !== `in:home:${plotId}`) continue;
    return c.info.pid === pid ? { code: "INSIDE", text: "Step outside first." } : { code: "INSIDE", text: "Someone is inside. Try again when they have left." };
  }
  return null;
}

/** What selling would pay, and why not if it cannot be done. The same numbers `sellPlot` uses. */
export async function quoteSale(pid: string, plotId: string, now = Date.now(), deps: SaleDeps = realDeps): Promise<Result<SaleQuote>> {
  if (!config.plotSales) return fail(503, "OFF", "Selling land is closed for now.");
  const loan = await activeLoan(pid);
  if (!Object.hasOwn(plots, plotId)) return fail(404, "NO_PLOT", NO_PLOT);
  const plot = plots[plotId];
  const blocked = blockOf(pid, plotId, deps);
  if (blocked?.code === "NOT_OWNER") return done({ plotId, gross: 0, parts: { land: 0, built: 0, decor: 0 }, loanPaid: 0, net: 0, repBack: 0, blocked, now });
  const { gross, land, built, decor } = saleValue(plotId, plot);
  const loanPaid = loan && gross > 0 ? planSalePayment(loan, gross, plotId, now).paid : 0;
  return done({ plotId, gross, parts: { land, built, decor }, loanPaid, net: gross - loanPaid, repBack: repEarned(plot), blocked, now });
}

/** Sell a plot to the city. Everything is checked first; then the plot, the cash and the loan payment are written in one statement. */
export function sellPlot(pid: string, plotId: string, now = Date.now(), deps: SaleDeps = realDeps): Promise<Result<SaleDone>> {
  return withPidLock(pid, async () => {
    if (!config.plotSales) return fail(503, "OFF", "Selling land is closed for now.");
    if (tooSoon("sale", pid, SALE.minGapMs, now)) return fail(429, "RATE", "Slow down a little.");
    const loan = await activeLoan(pid);

    // from here to the removal below there is no await, so what was checked is still true when the plot is taken off the map
    if (!Object.hasOwn(plots, plotId)) return fail(404, "NO_PLOT", NO_PLOT);
    const plot = plots[plotId];
    const blocked = blockOf(pid, plotId, deps);
    if (blocked) return fail(statusOf[blocked.code] ?? 400, blocked.code, blocked.text);
    const { gross } = saleValue(plotId, plot);
    const pay = loan ? { loan, plan: planSalePayment(loan, gross, plotId, now) } : null;
    const loanPaid = pay?.plan.paid ?? 0;
    const net = gross - loanPaid;
    const place = districtName(plotId);
    const creditNote = `Land sale: ${place}`;

    delete plots[plotId];
    const before = released.get(plotId);
    released.set(plotId, { by: pid, at: now });
    const undo = () => {
      if (!Object.hasOwn(plots, plotId)) plots[plotId] = plot;
      if (before) released.set(plotId, before);
      else released.delete(plotId);
    };
    let rows;
    try {
      rows = await sellPlotRows({
        plotId, pid, now, net, creditNote, loanPaid, repayNote: `Loan repaid from the sale of ${place}`,
        loanBefore: pay && loanPaid > 0 ? pay.loan : null, loanAfter: pay && loanPaid > 0 ? pay.plan.after : null,
      });
    } catch (e) {
      undo();
      throw e;
    }
    if (!rows.freed) {
      undo();
      return fail(409, "BAD", "The sale did not go through. Try again.");
    }

    broadcast({ t: "plotFree", plotId });
    const business = BIZ_INFO[plot.biz ?? ""]?.name ?? "business";
    for (const s of plot.staff ?? []) sendToPid(s.pid, { t: "fired", plotId, owner: plot.ownerName, business });
    if (net > 0 && rows.creditId !== null) sendToPid(pid, { t: "credit", id: rows.creditId, from: stateName(STATE.city) ?? "City Council", username: "", amount: net, note: creditNote });
    if (pay && loanPaid > 0) {
      try {
        await settleSale(pid, pay.loan, pay.plan, now);
      } catch (e) {
        console.error("[property] the sale is written but the loan notice failed", pid, plotId, e);
      }
    }
    return done({ plotId, gross, loanPaid, net, repBack: repEarned(plot), now });
  });
}
