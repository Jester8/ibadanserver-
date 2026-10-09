import type { C2S, PokeMode } from "../src/lib/protocol";
import type { Client } from "./presence";

/* Justice server owner replaces every body (the poke rules live in POKE, custodyRules.ts). */
/** A `poke` message from a connected player. Validates everything, then sends poked / pokeAck / pokeFx. */
export async function handlePoke(c: Client, m: Extract<C2S, { t: "poke" }>): Promise<void> { void c; void m; }
/** A `pokeMode` message: save it and echo it back. */
export async function handlePokeMode(c: Client, mode: PokeMode): Promise<void> { void c; void mode; }
/** First connect: read the saved mode and the account's age into the client record, and tell the player the mode. */
export async function onPokeConnect(c: Client): Promise<void> { void c; }
