import type { Client } from "./presence";

/* Money server owner replaces every body (the rules are in moneyRules.ts). */
export async function initLoans(): Promise<void> {}
/** First connect: send the player their loan (or null), and serve the final notice if one is due. */
export async function onLoanConnect(c: Client): Promise<void> { void c; }
/** Every 15 seconds: late fees, final notices, liens. */
export async function tickLoans(now?: number): Promise<void> { void now; }
