import type { Client } from "./presence";

/* Justice server owner replaces every body. These are the exports index.ts and bank.ts use. */
/** index.ts sets this to its leaveVoice, so an arrest can take the player out of a voice room. */
export const hooks: { leaveVoice: ((c: Client) => void) | null } = { leaveVoice: null };
/** Load the held cases from the database and rebuild the timers; release everyone if CUSTODY is off. Called once, before listening. */
export async function initCustody(): Promise<void> {}
export const isHeld = (pid: string): boolean => { void pid; return false; };
/** The room a held player is pinned to (the prison), or null. */
export const forcedRoom = (pid: string): string | null => { void pid; return null; };
/** First connect of a player: pin a held player to the prison and send `custody` (null when free). The poke setting is loaded by pokes.ts. */
export async function onConnect(c: Client): Promise<void> { void c; }
/** Every second: release held players whose time is up and lapse filed cases. */
export async function tickCustody(now?: number): Promise<void> { void now; }
/** Every 5 seconds: remember who was close to whom (for "you can report someone you were with"). */
export function tickMeetings(): void {}
/** EFCC auto-settle after a transfer (called by bank.ts). */
export async function onTransfer(from: string, to: string, amount: number): Promise<void> { void from; void to; void amount; }
