/* Money server owner replaces every body. */
/** Load the record of plots sold back to the city. Called once, before listening. */
export async function initProperty(): Promise<void> {}
/**
 * True when a plotSet that claims an empty plot must be refused because it is a stale claim: this player sold the plot to the
 * city after `collectedAt`, so a device that still remembers owning it is trying to take it back.
 */
export const claimBlocked = (plotId: string, pid: string, collectedAt: number): boolean => { void plotId; void pid; void collectedAt; return false; };
