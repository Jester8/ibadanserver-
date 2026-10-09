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
  /** what the business charges for its main product or service (naira) */
  price?: number;
  /** what a member of staff is paid for each shift (naira) */
  wage?: number;
  /** the people the owner has hired */
  staff?: { pid: string; name: string }[];
  /** the bank has put a lien on this property because a loan is overdue: no visitors or customers until the loan is cleared */
  seized?: boolean;
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

/**
 * Listening together: "invite" (host to friend, with the Spotify link `uri`), "accept" / "decline" (the friend's answer),
 * "state" (the host's player: `playing`, `pos` in seconds, and `item` when Spotify says which song is on), "end" (either side).
 * Only between accepted friends. `to` / `from` are player ids.
 */
export type ListenOp = "invite" | "accept" | "decline" | "end" | "state";

/* ----------------------- police, EFCC and custody ----------------------- */

/** Who handles a case: the police (people problems) or the EFCC (money problems). */
export type CaseKind = "police" | "efcc";
export type CaseReason = "loitering" | "disturbance" | "harassment" | "assault" | "scam" | "fraud";
export type CaseStatus = "filed" | "held" | "bailed" | "served" | "settled" | "withdrawn" | "expired" | "merged" | "dismissed";

/** What an arrested player is told: sent on every connect (null when free) and whenever it changes. */
export type CustodyView = {
  caseId: number;
  kind: CaseKind;
  reason: CaseReason;
  /** name of the person who reported them */
  by: string;
  /** the lockup place id (PRISON_ID in custodyRules.ts) and which cell (0..CELL_SPAWNS.length-1) */
  place: string;
  cell: number;
  heldAt: number;
  /** the stay never runs past this: the server lets them out then (server clock, epoch ms) */
  releaseAt: number;
  bail: number;
  /** times they have asked friends for bail, and when they may ask again (epoch ms; 0 = now) */
  asks: number;
  nextAskAt: number;
};

/** One case as its reporter or its accused sees it. Evidence never leaves the server. */
export type CaseCard = {
  id: number;
  kind: CaseKind;
  reason: CaseReason;
  role: "reporter" | "accused";
  other: { pid: string; name: string };
  status: CaseStatus;
  filedAt: number;
  /** a filed case lapses after this */
  confirmBy: number;
  /** earliest moment the reporter can book (EFCC gives the other side time to repay) */
  bookableAt: number;
  heldAt: number | null;
  releaseAt: number | null;
  closedAt: number | null;
  bail: number;
  /** 0 = no fine option (EFCC) */
  fine: number;
  fee: number;
  feeState: "paid" | "refunded" | "kept";
  /** EFCC: naira in dispute */
  disputed: number;
  /** name of whoever paid the bail */
  paidBy: string | null;
};

export type C2S =
  | { t: "hello"; pid: string; name: string; look: Look; token?: string }
  | { t: "move"; x: number; z: number; ry: number; s: number }
  | { t: "room"; room: string }
  | { t: "chat"; text: string }
  /** a small picture (a JPEG data URL of about 10 KB at most) for everyone in the room */
  | { t: "chatimg"; data: string }
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
  | { t: "doing"; label: string | null }
  | { t: "typing"; to?: string }
  | { t: "ping"; at: number }
  | { t: "serve"; to: string; dish: string }
  | { t: "serveReply"; to: string; dish: string; accept: boolean }
  | { t: "claimStarter"; candidates: string[] }
  | { t: "knockReply"; to: string; plotId: string; allow: boolean }
  | { t: "run"; slogan: string }
  | { t: "vote"; pid: string }
  | { t: "policy"; policy: Policy }
  /** listen to Spotify together with a friend: the host invites, the friend answers, then the host's player state is relayed */
  | { t: "listen"; to: string; op: ListenOp; uri?: string; item?: string; playing?: boolean; pos?: number }
  /** poke or hit someone close to you (`to` is their connection id); the server decides if it is allowed */
  | { t: "poke"; to: string; kind: PokeKind }
  /** who may poke me: everyone, friends only, or nobody (saved on the server) */
  | { t: "pokeMode"; mode: PokeMode };

export type S2C =
  | { t: "welcome"; id: string; peers: PeerInfo[]; plots: Record<string, PlotState> }
  | { t: "join"; peer: PeerInfo }
  | { t: "leave"; id: string }
  | { t: "moves"; m: [string, number, number, number, number][] }
  | { t: "chat"; id: string; name: string; room: string; text: string; at: number }
  | { t: "chatimg"; id: string; name: string; room: string; data: string; at: number }
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
  | { t: "online"; n: number; /** how many accounts have been created in all */ accounts?: number }
  | { t: "emote"; id: string; e: "wave" | "dance" }
  | { t: "election"; e: Election; myVote: string | null }
  | { t: "dm"; id: number; from: string; to: string; text: string; at: number; fromName: string }
  | { t: "friendEvent"; kind: "request" | "accepted" | "removed"; pid: string; name: string }
  | { t: "credit"; id: number; from: string; username: string; amount: number; note: string }
  | { t: "relAsk"; from: string; name: string; level: string }
  | { t: "relChanged"; pid: string; name: string; level: string; by: "them" | "accepted" }
  | { t: "relDeclined"; pid: string; name: string; level: string }
  | { t: "famEvent"; kind: "ask" | "accepted" | "declined" | "removed"; pid: string; name: string; role: string }
  | { t: "presence"; pid: string; online: boolean }
  | { t: "dmError"; error: string }
  | { t: "photo"; photoId: string; from: string; name: string; data: string }
  | { t: "sit"; id: string; u: Seat | null }
  | { t: "knock"; from: string; name: string; plotId: string }
  | { t: "knockResult"; plotId: string; allow: boolean; reason?: string }
  | { t: "starterHome"; plotId: string }
  | { t: "doing"; id: string; label: string | null }
  | { t: "typing"; from: string; name: string; dm: boolean }
  | { t: "pong"; at: number }
  | { t: "sale"; plotId: string; from: string; item: string; amount: number }
  | { t: "hired"; plotId: string; owner: string; business: string; wage: number }
  | { t: "fired"; plotId: string; owner: string; business: string }
  | { t: "debit"; id: number; to: string; amount: number; note: string }
  | { t: "served"; from: string; name: string; dish: string }
  | { t: "serveResult"; from: string; name: string; dish: string; accept: boolean }
  | { t: "history"; room: string; messages: { pid: string; name: string; text: string; at: number }[] }
  | { t: "custody"; c: CustodyView | null; now: number }
  | { t: "caseUpdate"; c: CaseCard; now: number }
  | { t: "bailAsk"; caseId: number; pid: string; name: string; reason: CaseReason; bail: number; releaseAt: number; now: number }
  | { t: "bailAskEnd"; caseId: number; why: "paid" | "released" | "ended"; by?: string }
  | { t: "arrestNote"; name: string; reason: CaseReason }
  | { t: "listen"; from: string; name: string; op: ListenOp; uri?: string; item?: string; playing?: boolean; pos?: number }
  /** pokes and hits: `poked` goes to the one poked, `pokeAck` to the one who did it, `pokeFx` to everyone in the room (for the little bubble) */
  | { t: "poked"; id: number; from: string; fromPid: string; name: string; kind: PokeKind; at: number; recent: number; canReport: boolean }
  | { t: "pokeAck"; to: string; kind: PokeKind; ok: boolean; deny?: PokeDeny; retryMs?: number }
  | { t: "pokeFx"; from: string; to: string; kind: PokeKind }
  | { t: "pokeMode"; mode: PokeMode }
  /** a plot was sold back to the city and is free land again */
  | { t: "plotFree"; plotId: string }
  /** your bank loan changed (null: you have none). Sent on every connect and whenever the server changes it */
  | { t: "loan"; loan: LoanView | null; now: number; why: LoanWhy };

/* ----------------------- pokes and hits ----------------------- */

export type PokeKind = "poke" | "hit";
export type PokeMode = "all" | "friends" | "off";
/** Why the server said no. `declined` covers "they switched pokes off", "friends only" and "blocked" alike, so a block is never revealed. */
export type PokeDeny = "off" | "declined" | "far" | "cooldown" | "limit" | "young" | "custody" | "prison" | "reported";

/* ----------------------- bank loans (rules and numbers: moneyRules.ts) ----------------------- */

export type LoanStage = "active" | "overdue" | "notice" | "seized";
export type LoanWhy = "sync" | "take" | "repay" | "overdue" | "notice" | "seized" | "cleared" | "sale" | "forgiven";

/** A loan as the player sees it. Interest is brought up to date by `owedNow` in moneyRules.ts. */
export type LoanView = {
  id: number;
  /** what was borrowed */
  principal: number;
  /** principal still unpaid */
  left: number;
  /** interest and fees accrued and unpaid as of `at` */
  interest: number;
  /** epoch ms (server clock) up to which interest has been added; always a whole minute */
  at: number;
  takenAt: number;
  dueAt: number;
  /** basis points of the unpaid principal charged each minute before the due time (10 = 0.10%) */
  rateBpm: number;
  /** the one-off late fee has been added */
  lateFee: boolean;
  stage: LoanStage;
  /** when the final notice was served (the player was online); the lien follows LOAN.seizeAfterNoticeMin later */
  noticeAt: number | null;
  /** the plot under lien, if any */
  seizedPlot: string | null;
  /** client only: the one-off reputation penalty has been applied for this loan. The server never sets it. */
  repHit?: boolean;
};
