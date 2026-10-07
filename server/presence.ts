import { WebSocket } from "ws";
import type { PeerInfo, S2C } from "../src/lib/protocol";

import type { Seat } from "../src/lib/protocol";

export type Client = { ws: WebSocket; info: PeerInfo; moved: boolean; speed: number; voiceRoom: string | null; lastChat: number;
  lastPhoto: number; lastKnock: number; sit: Seat | null; doing: string | null; lastTyping: number; lastServe: number; verified: boolean };

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
