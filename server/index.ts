/**
 * Omo Ibadan realtime server.
 * Presence + chat + shared land ownership + WebRTC voice signalling.
 * Run: npm run server   (defaults to ws://localhost:8787)
 *
 * NOTE: money/needs are still client-side (trusted). Move them server-side before a public launch.
 */
import { createServer } from "node:http";
import { WebSocketServer, type RawData } from "ws";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { db, migrate } from "./db";
import { addReport, addRoomMessage, blockedEither, blocksOf, friendshipsOf, hasEmail, importLegacyPlots, loadPlots, recordElection, roomHistory, savePlot, touchPlayer } from "./db/repo";
import { handleHttp } from "./http/router";
import { broadcast, clients, isOnline, sendToPid, tx, type Client } from "./presence";
import { sendDm } from "./http/social";
import { verifyToken } from "./http/auth";
import { cleanChat } from "../src/lib/moderation";
import type { C2S, Election, PeerInfo, PlotState, Policy, S2C } from "../src/lib/protocol";

/** Open the database, apply migrations and load the land before anyone connects. */
const plots: Record<string, PlotState> = {};
const ready = (async () => {
  await migrate();
  await importLegacyPlots(__dirname);
  Object.assign(plots, await loadPlots());
})();

const voiceRooms = new Map<string, Set<string>>();

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const num = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/** Let a player's accepted friends know they came online or went offline. */
async function tellFriends(pid: string, online: boolean) {
  for (const f of await friendshipsOf(pid)) if (f.status === "accepted") sendToPid(f.a === pid ? f.b : f.a, { t: "presence", pid, online });
}

function leaveVoice(c: Client) {
  if (!c.voiceRoom) return;
  const room = voiceRooms.get(c.voiceRoom);
  room?.delete(c.info.id);
  if (room) {
    for (const id of room) {
      const peer = clients.get(id);
      if (peer) tx(peer.ws, { t: "voicePeerLeft", id: c.info.id });
    }
    if (room.size === 0) voiceRooms.delete(c.voiceRoom);
  }
  c.voiceRoom = null;
}

/* ------------------------------- governor election ------------------------------- */
const TERM_MS = 20 * 60 * 1000;
const POLICIES: Policy[] = ["none", "transport", "food", "wages"];
let term = 1;
let endsAt = Date.now() + TERM_MS;
let governor: Election["governor"] = null;
const candidates = new Map<string, { name: string; slogan: string }>();
const votes = new Map<string, string>(); // voter pid -> candidate pid

const snapshot = (): Election => ({
  term,
  endsAt,
  governor,
  candidates: [...candidates.entries()].map(([pid, c]) => ({ pid, ...c, votes: [...votes.values()].filter((v) => v === pid).length })),
});
function pushElection() {
  const e = snapshot();
  for (const c of clients.values()) tx(c.ws, { t: "election", e, myVote: votes.get(c.info.pid) ?? null });
}
setInterval(() => {
  if (Date.now() < endsAt) return;
  const e = snapshot();
  const win = [...e.candidates].sort((a, b) => b.votes - a.votes)[0];
  if (win && win.votes > 0) governor = { pid: win.pid, name: win.name, slogan: win.slogan, policy: "none" };
  void recordElection(term, win && win.votes > 0 ? win : null).catch((e) => console.error("[election]", e));
  term++;
  endsAt = Date.now() + TERM_MS;
  candidates.clear();
  votes.clear();
  pushElection();
}, 3000);

const httpServer = createServer((req, res) => void handleHttp(req, res));
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const id = randomUUID().slice(0, 8);
  let client: Client | null = null;

  // handle one message at a time per connection, so database waits never reorder things
  let chain: Promise<void> = Promise.resolve();
  const onMessage = async (raw: RawData) => {
    let m: C2S;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (m.t === "hello") {
      // with REQUIRE_AUTH on, only players holding a genuine token get in, and only as themselves.
      // An account with a verified email can never be used without its token.
      const tokenPid = await verifyToken(m.token);
      const verified = !!tokenPid && tokenPid === m.pid;
      if ((config.requireAuth || (await hasEmail(String(m.pid)))) && !verified) {
        ws.close(4401, "unauthorised");
        return;
      }
      const info: PeerInfo = {
        id,
        pid: clean(m.pid, 40),
        name: clean(m.name, 16) || "Guest",
        look: m.look,
        room: client?.info.room ?? "streets",
        x: client?.info.x ?? 0.5,
        z: client?.info.z ?? 8.2,
        ry: 0,
      };
      await touchPlayer(info.pid, info.name);
      if (!client) {
        client = { ws, info, moved: false, speed: 0, voiceRoom: null, lastChat: 0, verified };
        clients.set(id, client);
        tx(ws, { t: "welcome", id, peers: [...clients.values()].filter((c) => c.info.id !== id).map((c) => c.info), plots });
        tx(ws, { t: "election", e: snapshot(), myVote: votes.get(info.pid) ?? null });
        if (verified) void tellFriends(info.pid, true);
      } else {
        client.info = { ...client.info, name: info.name, look: info.look };
      }
      broadcast({ t: "join", peer: client.info }, id);
      broadcast({ t: "online", n: clients.size });
      tx(ws, { t: "online", n: clients.size });
      return;
    }
    if (!client) return;
    const c = client;

    switch (m.t) {
      case "move":
        c.info.x = num(m.x);
        c.info.z = num(m.z);
        c.info.ry = num(m.ry);
        c.speed = num(m.s);
        c.moved = true;
        break;
      case "room": {
        c.info.room = clean(m.room, 40) || "streets";
        broadcast({ t: "join", peer: c.info }, id);
        // show what was said here recently, minus anyone you have blocked
        const mine = c.info.pid;
        const hidden = new Set(await blocksOf(mine));
        const messages = (await roomHistory(c.info.room)).filter((h) => !hidden.has(h.from_pid)).map((h) => ({ pid: h.from_pid, name: h.from_name, text: h.text, at: h.at }));
        if (messages.length) tx(ws, { t: "history", room: c.info.room, messages });
        break;
      }
      case "chat": {
        const now = Date.now();
        const text = cleanChat(clean(m.text, 200));
        if (!text || now - c.lastChat < 400) return;
        c.lastChat = now;
        const msg: S2C = { t: "chat", id, name: c.info.name, room: c.info.room, text, at: now };
        if (!c.info.room.startsWith("call:")) void addRoomMessage(c.info.room, c.info.pid, c.info.name, text, now).catch((e) => console.error("[chat]", e));
        for (const other of clients.values()) {
          if (other.info.room !== c.info.room) continue;
          if (other.info.id !== id && (await blockedEither(c.info.pid, other.info.pid))) continue; // blocked either way: not delivered
          tx(other.ws, msg);
        }
        break;
      }
      case "dm": {
        const r = await sendDm(c.info.pid, clean(m.to, 40), m.text);
        if (!r.ok) tx(ws, { t: "dmError", error: r.error });
        break;
      }
      case "plotSet": {
        const existing = plots[m.plotId];
        if (existing && existing.ownerId !== c.info.pid) {
          tx(ws, { t: "reject", plotId: m.plotId });
          tx(ws, { t: "plots", plots });
          return;
        }
        if (!m.plot || m.plot.ownerId !== c.info.pid) return;
        const plot: PlotState = {
          ownerId: c.info.pid,
          ownerName: clean(m.plot.ownerName, 16),
          tier: Math.max(0, Math.min(3, Math.floor(num(m.plot.tier)))),
          collectedAt: num(m.plot.collectedAt, Date.now()),
          decor: Array.isArray(m.plot.decor) ? m.plot.decor.filter((d) => typeof d === "string" && /^[a-z0-9]{1,20}$/.test(d)).slice(0, 21) : existing?.decor,
        };
        plots[m.plotId] = plot;
        await savePlot(m.plotId, plot);
        broadcast({ t: "plot", plotId: m.plotId, plot });
        break;
      }
      case "voiceJoin": {
        leaveVoice(c);
        const room = clean(m.room, 80);
        if (!room) return;
        const set = voiceRooms.get(room) ?? new Set<string>();
        if (set.size >= (config.livekitUrl ? 30 : 8)) return;
        tx(ws, { t: "voiceMembers", room, ids: [...set] });
        for (const peerId of set) {
          const peer = clients.get(peerId);
          if (peer) tx(peer.ws, { t: "voicePeerJoined", room, id });
        }
        set.add(id);
        voiceRooms.set(room, set);
        c.voiceRoom = room;
        break;
      }
      case "voiceLeave":
        leaveVoice(c);
        break;
      case "signal": {
        const target = clients.get(m.to);
        // only relay between people in the same voice room
        if (target && c.voiceRoom && target.voiceRoom === c.voiceRoom) tx(target.ws, { t: "signal", from: id, data: m.data });
        break;
      }
      case "call": {
        const target = clients.get(m.to);
        if (target && !(await blockedEither(c.info.pid, target.info.pid))) tx(target.ws, { t: "incomingCall", from: id, name: c.info.name });
        else tx(ws, { t: "callReply", from: m.to, accept: false });
        break;
      }
      case "callReply": {
        const target = clients.get(m.to);
        if (target) tx(target.ws, { t: "callReply", from: id, accept: !!m.accept });
        break;
      }
      case "report": {
        const target = clients.get(m.id);
        await addReport(`${c.info.pid}(${c.info.name})`, target ? `${target.info.pid}(${target.info.name})` : clean(m.id, 40), clean(m.reason, 120));
        break;
      }
      case "car": {
        const ok = m.car && /^[a-z0-9]{1,20}$/.test(m.car.id) && /^#[0-9a-fA-F]{6}$/.test(m.car.color);
        c.info.car = ok ? { id: m.car!.id, color: m.car!.color } : null;
        broadcast({ t: "join", peer: c.info }, id);
        break;
      }
      case "run": {
        if (!c.info.pid || candidates.size >= 8) break;
        candidates.set(c.info.pid, { name: c.info.name, slogan: clean(m.slogan, 60) || "Good Ibadan ahead" });
        pushElection();
        break;
      }
      case "vote": {
        if (!candidates.has(m.pid)) break;
        votes.set(c.info.pid, m.pid);
        pushElection();
        break;
      }
      case "policy": {
        if (governor?.pid === c.info.pid && POLICIES.includes(m.policy)) {
          governor = { ...governor, policy: m.policy };
          pushElection();
        }
        break;
      }
      case "emote": {
        if (m.e !== "wave" && m.e !== "dance") break;
        const msg: S2C = { t: "emote", id, e: m.e };
        for (const other of clients.values()) if (other.info.room === c.info.room && other.info.id !== id) tx(other.ws, msg);
        break;
      }
      case "hangup": {
        const target = clients.get(m.to);
        if (target) tx(target.ws, { t: "hangup", from: id });
        break;
      }
    }
  };
  ws.on("message", (raw) => {
    chain = chain.then(() => onMessage(raw)).catch((e) => console.error("[ws]", e));
  });

  ws.on("close", () => {
    const c = clients.get(id);
    if (!c) return;
    leaveVoice(c);
    clients.delete(id);
    if (c.verified && !isOnline(c.info.pid)) void tellFriends(c.info.pid, false);
    broadcast({ t: "leave", id });
    broadcast({ t: "online", n: clients.size });
  });
});

// 10 Hz movement snapshots
setInterval(() => {
  const m: [string, number, number, number, number][] = [];
  for (const c of clients.values()) {
    if (!c.moved) continue;
    c.moved = false;
    m.push([c.info.id, c.info.x, c.info.z, c.info.ry, c.speed]);
  }
  if (m.length) broadcast({ t: "moves", m });
}, 100);

ready
  .then(() => httpServer.listen(config.port, () => console.log(`Omo Ibadan server listening on http/ws://localhost:${config.port} (database: ${db.kind})`)))
  .catch((e) => {
    console.error("Could not start:", e);
    process.exit(1);
  });
