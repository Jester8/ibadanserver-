import { WebSocket } from "ws";
import type { PeerInfo, PokeMode, S2C } from "../src/lib/protocol";

import type { Seat } from "../src/lib/protocol";

/** What the social features need to know about a connected player. Filled in on the first connect (socialFields) and by onPokeConnect. */
export type SocialFields = {
  /** when they entered their current room (a poke needs both to have been in the room a moment) */
  roomAt: number;
  pokeMode: PokeMode;
  /** the account's age is measured from this (epoch ms; 0 until read) */
  createdAt: number;
};
export const socialFields = (): SocialFields => ({ roomAt: Date.now(), pokeMode: "all", createdAt: 0 });

export type Client = SocialFields & { ws: WebSocket; info: PeerInfo; moved: boolean; speed: number; voiceRoom: string | null; lastChat: number;
  lastPhoto: number; lastImg: number; lastListen: number; lastInvite: number; lastKnock: number; sit: Seat | null; doing: string | null; lastTyping: number; lastServe: number; verified: boolean };

import type { PlotState } from "../src/lib/protocol";

/** The land and what is built on it, held in memory and saved to the database as it changes. */
export const plots: Record<string, PlotState> = {};

/** Everyone connected right now, by connection id. Shared by the websocket handlers and the REST routes. */
export const clients = new Map<string, Client>();

export const tx = (ws: WebSocket, m: S2C) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));

export const broadcast = (m: S2C, except?: string) => {
  const data = JSON.stringify(m);
  for (const [id, c] of clients) if (id !== except && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
};

export const isOnline = (pid: string) => {
  for (const c of clients.values()) if (c.info.pid === pid) return true;
  return false;
};

/** Send to every connection (tab/device) a player has open. */
export function sendToPid(pid: string, m: S2C) {
  for (const c of clients.values()) if (c.info.pid === pid) tx(c.ws, m);
}

/** Stand a player up from wherever they were sitting or working, and tell the others in their room. */
export function standUp(c: Client): void {
  if (!c.sit && !c.doing) return;
  for (const other of clients.values()) {
    if (other.info.id === c.info.id || other.info.room !== c.info.room) continue;
    if (c.sit) tx(other.ws, { t: "sit", id: c.info.id, u: null });
    if (c.doing) tx(other.ws, { t: "doing", id: c.info.id, label: null });
  }
  c.sit = null;
  c.doing = null;
}
