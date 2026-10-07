import type { Look } from "./look";

export type PlotState = {
  ownerId: string;
  ownerName: string;
  /** 0 = empty land, 1 = bungalow, 2 = duplex, 3 = mansion */
  tier: number;
  collectedAt: number;
  /** decor ids placed in the house, visible to every visitor */
  decor?: string[];
  /** a business built on this land instead of a house (see business.ts) */
  biz?: string;
  /** who may come in: "ask" (the owner is asked each time), "friends" (friends walk straight in), "closed" */
  visit?: "ask" | "friends" | "closed";
};

export type Policy = "none" | "transport" | "food" | "wages";

export type Election = {
  term: number;
  endsAt: number;
  candidates: { pid: string; name: string; slogan: string; votes: number }[];
  governor: { pid: string; name: string; slogan: string; policy: Policy } | null;
};

export type PeerInfo = {
  id: string; // connection id (changes every connection)
  pid: string; // persistent player id
  name: string;
  look: Look;
  room: string;
  x: number;
  z: number;
  ry: number;
  /** the car they are currently driving, if any */
  car?: { id: string; color: string } | null;
};

/** Where someone is seated or lying down on furniture, so everyone in the room sees them settle in. */
export type Seat = { pose: "sit" | "lie"; x: number; z: number; ry: number; seatH: number };

export type C2S =
  | { t: "hello"; pid: string; name: string; look: Look; token?: string }
  | { t: "move"; x: number; z: number; ry: number; s: number }
  | { t: "room"; room: string }
  | { t: "chat"; text: string }
  | { t: "plotSet"; plotId: string; plot: PlotState }
  | { t: "voiceJoin"; room: string }
  | { t: "voiceLeave" }
  | { t: "signal"; to: string; data: unknown }
  | { t: "call"; to: string }
  | { t: "callReply"; to: string; accept: boolean }
  | { t: "hangup"; to: string }
  | { t: "report"; id: string; reason: string }
  | { t: "emote"; e: "wave" | "dance" }
  | { t: "car"; car: { id: string; color: string } | null }
  | { t: "dm"; to: string; text: string }
  | { t: "photo"; data: string }
  | { t: "sit"; u: Seat | null }
  | { t: "knock"; plotId: string }
  | { t: "knockReply"; to: string; plotId: string; allow: boolean }
  | { t: "run"; slogan: string }
  | { t: "vote"; pid: string }
  | { t: "policy"; policy: Policy };

export type S2C =
  | { t: "welcome"; id: string; peers: PeerInfo[]; plots: Record<string, PlotState> }
  | { t: "join"; peer: PeerInfo }
  | { t: "leave"; id: string }
  | { t: "moves"; m: [string, number, number, number, number][] }
  | { t: "chat"; id: string; name: string; room: string; text: string; at: number }
  | { t: "plots"; plots: Record<string, PlotState> }
  | { t: "plot"; plotId: string; plot: PlotState }
  | { t: "reject"; plotId: string }
  | { t: "voiceMembers"; room: string; ids: string[] }
  | { t: "voicePeerJoined"; room: string; id: string }
  | { t: "voicePeerLeft"; id: string }
  | { t: "signal"; from: string; data: unknown }
  | { t: "incomingCall"; from: string; name: string }
  | { t: "callReply"; from: string; accept: boolean }
  | { t: "hangup"; from: string }
  | { t: "online"; n: number }
  | { t: "emote"; id: string; e: "wave" | "dance" }
  | { t: "election"; e: Election; myVote: string | null }
  | { t: "dm"; id: number; from: string; to: string; text: string; at: number; fromName: string }
  | { t: "friendEvent"; kind: "request" | "accepted" | "removed"; pid: string; name: string }
  | { t: "presence"; pid: string; online: boolean }
  | { t: "dmError"; error: string }
  | { t: "photo"; photoId: string; from: string; name: string; data: string }
  | { t: "sit"; id: string; u: Seat | null }
  | { t: "knock"; from: string; name: string; plotId: string }
  | { t: "knockResult"; plotId: string; allow: boolean; reason?: string }
  | { t: "history"; room: string; messages: { pid: string; name: string; text: string; at: number }[] };
