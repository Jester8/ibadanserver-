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
import { addReport, addRoomMessage, blockedEither, blocksOf, countAccounts, friendshipsOf, getFriendship, getPlayer, hasEmail, importLegacyPlots, loadPlots, recordElection, roomHistory, savePlot, touchPlayer } from "./db/repo";
import { handleHttp } from "./http/router";
import { BIZ_INFO, DEFAULT_WAGE, MAX_WAGE } from "./business";
import { broadcast, clients, isOnline, plots, sendToPid, socialFields, standUp, tx, type Client } from "./presence";
import { hooks as custodyHooks, forcedRoom, initCustody, isHeld, onConnect, tickCustody, tickMeetings } from "./custody";
import { handlePoke, handlePokeMode, onPokeConnect } from "./pokes";
import { initLoans, onLoanConnect, tickLoans } from "./loans";
import { claimBlocked, initProperty } from "./property";
import { sweep, watch } from "./heartbeat";
import { sendDm } from "./http/social";
import { verifyToken } from "./http/auth";
import { cleanChat } from "../src/lib/moderation";
import type { C2S, Election, PeerInfo, PlotState, Policy, S2C } from "../src/lib/protocol";

/** Open the database, apply migrations and load the land before anyone connects. */
const ready = (async () => {
  await migrate();
  await importLegacyPlots(__dirname);
  Object.assign(plots, await loadPlots());
  await initCustody();
  await initLoans();
  await initProperty();
})();

const voiceRooms = new Map<string, Set<string>>();
/** visitors the owner let in: "visitorPid|plotId" -> until when. Kept in memory, 30 minutes each. */
const grants = new Map<string, number>();

const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
const num = (n: unknown, fallback = 0) => (typeof n === "number" && Number.isFinite(n) ? n : fallback);

/** A Spotify link in the form the game keeps it in: only a real id ever gets relayed to another player. */
const SPOTIFY_URI = /^spotify:(?:playlist|album|track|artist|show|episode):[A-Za-z0-9]{22}$/;
/** Are these two accepted friends, with no block either way? Remembered for 20 seconds so a stream of player updates costs nothing. */
const friendOk = new Map<string, { ok: boolean; until: number }>();
async function canListen(x: string, y: string) {
  if (!x || !y || x === y) return false;
  const key = x < y ? `${x}|${y}` : `${y}|${x}`;
  const now = Date.now();
  const hit = friendOk.get(key);
  if (hit && hit.until > now) return hit.ok;
  const ok = (await getFriendship(x, y))?.status === "accepted" && !(await blockedEither(x, y));
  friendOk.set(key, { ok, until: now + 20_000 });
  if (friendOk.size > 2000) for (const [k, v] of friendOk) if (v.until < now) friendOk.delete(k);
  return ok;
}

/** Let a player's accepted friends know they came online or went offline. */
async function tellFriends(pid: string, online: boolean) {
  for (const f of await friendshipsOf(pid)) if (f.status === "accepted") sendToPid(f.a === pid ? f.b : f.a, { t: "presence", pid, online });
}

/** Take a player out of the city for good: their voice room, the list, and a goodbye to everyone. */
function dropClient(c: Client) {
  if (c.lingerTimer) clearTimeout(c.lingerTimer);
  c.lingerTimer = null;
  if (clients.get(c.info.id) !== c) return;
  leaveVoice(c);
  clients.delete(c.info.id);
  if (c.verified && !isOnline(c.info.pid)) void tellFriends(c.info.pid, false);
  broadcast({ t: "leave", id: c.info.id });
  void onlineMsg().then((m) => broadcast(m));
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
const wss = new WebSocketServer({ server: httpServer, maxPayload: 1_000_000 });

/** How many different players are online (not how many connections there are). */
const onlineCount = () => new Set([...clients.values()].map((c) => c.info.pid)).size;

/** A chat picture is a JPEG data URL of about 10 KB at most (13,360 characters); a little slack is allowed. */
const MAX_CHAT_IMG = 13_700;
const CHAT_IMG = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;

/** The account total changes slowly, so it is asked of the database at most once a minute. */
let accountsCache = { n: 0, at: 0 };
async function onlineMsg(): Promise<S2C> {
  if (Date.now() - accountsCache.at > 60_000) accountsCache = { n: await countAccounts().catch(() => accountsCache.n), at: Date.now() };
  return { t: "online", n: onlineCount(), accounts: accountsCache.n };
}

wss.on("connection", (ws) => {
  watch(ws);
  // the connection's id in the city. A player who comes straight back after a drop is given their old one (see the first connect)
  let id = randomUUID().slice(0, 8);
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
        // one connection per player: opening the game again (a reload, a second tab, a reconnect) replaces the old one
        let resumed: Client | null = null;
        for (const old of [...clients.values()]) {
          if (old.info.pid !== info.pid || old.info.id === id) continue;
          leaveVoice(old);
          clients.delete(old.info.id);
          if (old.lingerTimer) clearTimeout(old.lingerTimer);
          // their connection had dropped a moment ago: they come back as the same player, where they were, and nobody sees a thing
          if (old.lingering) {
            resumed = old;
            continue;
          }
          broadcast({ t: "leave", id: old.info.id });
          old.ws.close(4000, "opened elsewhere");
        }
        if (resumed) {
          id = resumed.info.id;
          Object.assign(info, { id, room: resumed.info.room, x: resumed.info.x, z: resumed.info.z, ry: resumed.info.ry, car: resumed.info.car ?? null });
        }
        client = { ...socialFields(), ws, info, moved: false, speed: 0, voiceRoom: null, lastChat: 0, lastPhoto: 0, lastImg: 0, lastListen: 0, lastInvite: 0, lastKnock: 0, sit: null, doing: null, lastTyping: 0, lastServe: 0, verified };
        if (resumed) Object.assign(client, { sit: resumed.sit, doing: resumed.doing, roomAt: resumed.roomAt, pokeMode: resumed.pokeMode, createdAt: resumed.createdAt });
        clients.set(id, client);
        tx(ws, { t: "welcome", id, peers: [...clients.values()].filter((c) => c.info.id !== id).map((c) => c.info), plots });
        tx(ws, { t: "election", e: snapshot(), myVote: votes.get(info.pid) ?? null });
        // a player in custody is pinned to the prison and told; the poke setting and any loan are sent too
        await onConnect(client);
        await onPokeConnect(client);
        await onLoanConnect(client);
        if (verified) void tellFriends(info.pid, true);
      } else {
        client.info = { ...client.info, name: info.name, look: info.look };
      }
      broadcast({ t: "join", peer: client.info }, id);
      const online = await onlineMsg();
      broadcast(online);
      tx(ws, online);
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
        // changing rooms means standing up where you were
        standUp(c);
        // a player in custody stays in the prison whatever the client says
        c.info.room = forcedRoom(c.info.pid) ?? (clean(m.room, 40) || "streets");
        c.roomAt = Date.now();
        broadcast({ t: "join", peer: c.info }, id);
        // show the newcomer who is already sitting here
        for (const other of clients.values()) {
          if (other.info.id === id || other.info.room !== c.info.room) continue;
          if (other.sit) tx(ws, { t: "sit", id: other.info.id, u: other.sit });
          if (other.doing) tx(ws, { t: "doing", id: other.info.id, label: other.doing });
        }
        // show what was said here recently, minus anyone you have blocked
        const mine = c.info.pid;
        const hidden = new Set(await blocksOf(mine));
        const messages = (await roomHistory(c.info.room, 30, config.chatHistoryMs)).filter((h) => !hidden.has(h.from_pid)).map((h) => ({ pid: h.from_pid, name: h.from_name, text: h.text, at: h.at }));
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
      case "chatimg": {
        // a small picture for everyone in the room. The client shrinks it to about 10 KB; anything much bigger is refused.
        // Relayed straight through and never stored (so it is not in the history a newcomer is shown).
        const now = Date.now();
        const data = typeof m.data === "string" ? m.data : "";
        if (data.length > MAX_CHAT_IMG || !CHAT_IMG.test(data) || now - c.lastImg < 3000) return;
        c.lastImg = now;
        const msg: S2C = { t: "chatimg", id, name: c.info.name, room: c.info.room, data, at: now };
        for (const other of clients.values()) {
          if (other.info.room !== c.info.room) continue;
          if (other.info.id !== id && (await blockedEither(c.info.pid, other.info.pid))) continue;
          tx(other.ws, msg);
        }
        break;
      }
      case "listen": {
        // listening to Spotify together: relayed between accepted friends only, nothing is stored
        const op = m.op;
        if (op !== "invite" && op !== "accept" && op !== "decline" && op !== "end" && op !== "state") return;
        const now = Date.now();
        if (op === "state") {
          if (now - c.lastListen < 400) return;
          c.lastListen = now;
        } else if (op === "invite") {
          if (now - c.lastInvite < 4000) return;
          c.lastInvite = now;
        }
        const to = clean(m.to, 80);
        if (!(await canListen(c.info.pid, to))) {
          if (op === "invite") tx(ws, { t: "listen", from: to, name: "", op: "decline" });
          return;
        }
        if (!isOnline(to)) {
          if (op === "invite") tx(ws, { t: "listen", from: to, name: "", op: "decline" });
          return;
        }
        const out: S2C = { t: "listen", from: c.info.pid, name: c.info.name, op };
        if (op === "invite" || op === "state") {
          if (typeof m.uri === "string" && SPOTIFY_URI.test(m.uri)) out.uri = m.uri;
          if (op === "invite" && !out.uri) return;
        }
        if (op === "state") {
          if (typeof m.item === "string" && SPOTIFY_URI.test(m.item)) out.item = m.item;
          out.playing = !!m.playing;
          out.pos = Math.min(86_400, Math.max(0, num(m.pos)));
        }
        sendToPid(to, out);
        break;
      }
      case "poke":
        await handlePoke(c, m);
        break;
      case "pokeMode":
        await handlePokeMode(c, m.mode);
        break;
      case "claimStarter": {
        // every new player is given a bungalow in one of the estates: the first free plot among the ones the client suggests
        const mine = Object.entries(plots).find(([, p]) => p.ownerId === c.info.pid);
        if (mine) {
          tx(ws, { t: "starterHome", plotId: mine[0] });
          return;
        }
        const ok = /^(bodija-estate|jericho-gra|oluyole-estate|iyaganku-heights)-([1-9]|[1-3][0-9]|40)$/;
        const pick = (Array.isArray(m.candidates) ? m.candidates : []).slice(0, 40).find((pid) => typeof pid === "string" && ok.test(pid) && !plots[pid]);
        if (!pick) return;
        const plot: PlotState = { ownerId: c.info.pid, ownerName: clean(c.info.name, 16), tier: 1, collectedAt: Date.now(), visit: "ask" };
        plots[pick] = plot;
        await savePlot(pick, plot);
        broadcast({ t: "plot", plotId: pick, plot });
        tx(ws, { t: "starterHome", plotId: pick });
        break;
      }
      case "knock": {
        // a visitor asks to come into a home: the owner decides (or has already decided in their door setting)
        const plot = plots[m.plotId];
        const now = Date.now();
        const result = (allow: boolean, reason?: string): void => {
          tx(ws, { t: "knockResult", plotId: m.plotId, allow, reason });
        };
        if (isHeld(c.info.pid)) return result(false, "You are in custody.");
        if (!plot || plot.tier < 1 || plot.biz) return result(false, "Nobody lives there.");
        if (plot.ownerId === c.info.pid) return result(true);
        if (plot.seized) return result(false, "This property has been seized by Omo'badan Bank.");
        // you can only visit while the owner is home: they are the host, and the house closes behind them when they leave
        const hostHome = [...clients.values()].some((o) => o.info.pid === plot.ownerId && o.info.room === `in:home:${m.plotId}`);
        if (!hostHome) return result(false, "They are not home right now. You can only visit while they are inside.");
        const grant = grants.get(`${c.info.pid}|${m.plotId}`);
        if (grant && grant > now) return result(true);
        if (await blockedEither(c.info.pid, plot.ownerId)) return result(false, "The door stays shut.");
        const mode = plot.visit ?? "ask";
        if (mode === "closed") return result(false, "The door is closed. They are not taking visitors.");
        if (mode === "friends") {
          if ((await friendshipsOf(plot.ownerId)).some((f) => f.status === "accepted" && (f.a === c.info.pid || f.b === c.info.pid))) {
            grants.set(`${c.info.pid}|${m.plotId}`, now + 30 * 60_000);
            return result(true);
          }
          return result(false, "Only their friends can come in.");
        }
        if (now - c.lastKnock < 4000) return;
        c.lastKnock = now;
        let asked = 0;
        for (const o of clients.values()) {
          if (o.info.pid === plot.ownerId) {
            tx(o.ws, { t: "knock", from: id, name: c.info.name, plotId: m.plotId });
            asked++;
          }
        }
        if (!asked) return result(false, "They are not home right now.");
        break;
      }
      case "knockReply": {
        const plot = plots[m.plotId];
        const visitor = clients.get(m.to);
        if (!plot || plot.ownerId !== c.info.pid || !visitor) return;
        if (m.allow) grants.set(`${visitor.info.pid}|${m.plotId}`, Date.now() + 30 * 60_000);
        tx(visitor.ws, { t: "knockResult", plotId: m.plotId, allow: !!m.allow, reason: m.allow ? undefined : "They cannot have visitors right now." });
        break;
      }
      case "ping":
        // lets the player see a weak connection: the answer comes straight back
        tx(ws, { t: "pong", at: typeof m.at === "number" ? m.at : Date.now() });
        break;
      case "typing": {
        // "is typing...": to a friend in a chat, or to everyone in the room
        const now = Date.now();
        if (now - c.lastTyping < 1500) return;
        c.lastTyping = now;
        if (typeof m.to === "string" && m.to) {
          const f = await getFriendship(c.info.pid, m.to);
          if (f?.status === "accepted") sendToPid(m.to, { t: "typing", from: c.info.pid, name: c.info.name, dm: true });
        } else {
          for (const other of clients.values()) if (other.info.id !== id && other.info.room === c.info.room) tx(other.ws, { t: "typing", from: id, name: c.info.name, dm: false });
        }
        break;
      }
      case "serve": {
        // a host serves a guest in the same room; the guest decides whether to eat
        const now = Date.now();
        const guest = clients.get(m.to);
        const dish = clean(m.dish, 40);
        if (!guest || !dish || guest.info.room !== c.info.room || now - c.lastServe < 3000) return;
        if (await blockedEither(c.info.pid, guest.info.pid)) return;
        c.lastServe = now;
        tx(guest.ws, { t: "served", from: id, name: c.info.name, dish });
        break;
      }
      case "serveReply": {
        const host = clients.get(m.to);
        if (!host || host.info.room !== c.info.room) return;
        tx(host.ws, { t: "serveResult", from: id, name: c.info.name, dish: clean(m.dish, 40), accept: !!m.accept });
        break;
      }
      case "doing": {
        // what someone is up to (cooking, eating...), so people in the room can join in
        c.doing = typeof m.label === "string" && m.label ? clean(m.label, 40) : null;
        for (const other of clients.values()) if (other.info.id !== id && other.info.room === c.info.room) tx(other.ws, { t: "doing", id, label: c.doing });
        break;
      }
      case "sit": {
        const u = m.u;
        const ok = u && (u.pose === "sit" || u.pose === "lie") && [u.x, u.z, u.ry, u.seatH].every((n) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) < 500);
        c.sit = ok ? { pose: u.pose, x: u.x, z: u.z, ry: u.ry, seatH: u.seatH } : null;
        for (const other of clients.values()) if (other.info.id !== id && other.info.room === c.info.room) tx(other.ws, { t: "sit", id, u: c.sit });
        break;
      }
      case "photo": {
        // a view-once picture for everyone on this call or voice room. Relayed straight through and never stored.
        const now = Date.now();
        const data = typeof m.data === "string" ? m.data : "";
        if (!c.voiceRoom || !data.startsWith("data:image/jpeg;base64,") || data.length > 450_000 || now - c.lastPhoto < 4000) return;
        c.lastPhoto = now;
        const msg: S2C = { t: "photo", photoId: randomUUID(), from: id, name: c.info.name, data };
        for (const other of clients.values()) {
          if (other.info.id === id || other.voiceRoom !== c.voiceRoom) continue;
          if (await blockedEither(c.info.pid, other.info.pid)) continue;
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
        // land the player sold must not come back from a device that still remembers owning it
        if (!existing && claimBlocked(m.plotId, c.info.pid, num(m.plot.collectedAt, Date.now()))) {
          tx(ws, { t: "reject", plotId: m.plotId });
          tx(ws, { t: "plots", plots });
          return;
        }
        const plot: PlotState = {
          ownerId: c.info.pid,
          ownerName: clean(m.plot.ownerName, 16),
          tier: Math.max(0, Math.min(3, Math.floor(num(m.plot.tier)))),
          collectedAt: num(m.plot.collectedAt, Date.now()),
          decor: Array.isArray(m.plot.decor) ? m.plot.decor.filter((d) => typeof d === "string" && /^[a-z0-9]{1,20}$/.test(d)).slice(0, 21) : existing?.decor,
          visit: m.plot.visit === "ask" || m.plot.visit === "friends" || m.plot.visit === "closed" ? m.plot.visit : existing?.visit ?? "ask",
          biz: typeof m.plot.biz === "string" && /^[a-z0-9]{1,20}$/.test(m.plot.biz) ? m.plot.biz : undefined,
          price: typeof m.plot.price === "number" && Number.isFinite(m.plot.price) ? Math.max(100, Math.min(50_000, Math.floor(m.plot.price))) : existing?.price,
          wage: typeof m.plot.wage === "number" && Number.isFinite(m.plot.wage) ? Math.max(0, Math.min(MAX_WAGE, Math.floor(m.plot.wage))) : existing?.wage,
          // only the bank sets or lifts a lien
          seized: existing?.seized,
        };
        // the people the owner has hired: real accounts only, and they are told when it changes
        if (plot.biz && Array.isArray(m.plot.staff)) {
          const staff: { pid: string; name: string }[] = [];
          for (const s of m.plot.staff.slice(0, 12)) {
            const pid = clean(s?.pid, 40);
            const who = pid && pid !== c.info.pid ? await getPlayer(pid) : undefined;
            if (who && !staff.some((x) => x.pid === pid)) staff.push({ pid, name: who.name });
          }
          plot.staff = staff;
        } else plot.staff = plot.biz ? existing?.staff : undefined;
        const before = new Set((existing?.staff ?? []).map((s) => s.pid));
        const after = new Set((plot.staff ?? []).map((s) => s.pid));
        const bizName = BIZ_INFO[plot.biz ?? ""]?.name ?? "business";
        for (const pid of after) if (!before.has(pid)) sendToPid(pid, { t: "hired", plotId: m.plotId, owner: plot.ownerName, business: bizName, wage: plot.wage ?? DEFAULT_WAGE });
        for (const pid of before) if (!after.has(pid)) sendToPid(pid, { t: "fired", plotId: m.plotId, owner: plot.ownerName, business: bizName });
        plots[m.plotId] = plot;
        await savePlot(m.plotId, plot);
        broadcast({ t: "plot", plotId: m.plotId, plot });
        break;
      }
      case "voiceJoin": {
        leaveVoice(c);
        const room = clean(m.room, 80);
        if (!room) return;
        // a player in custody can talk in the prison and take calls, nothing else
        if (isHeld(c.info.pid) && !room.startsWith("call:") && room !== "place:prison") return;
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
        if (isHeld(c.info.pid)) break;
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

  ws.on("close", (code) => {
    const c = clients.get(id);
    if (!c || c.ws !== ws) return; // replaced by a newer connection already
    // a dropped connection (a weak signal, a reload, a lock screen) is not a goodbye: the player stays, frozen, for a little while
    // and takes their place back if they return. Only a deliberate sign-out, a replaced window or a refused login leaves at once.
    const goodbye = code === 1000 || code === 1005 || code === 4000 || code === 4401;
    if (config.lingerMs > 0 && !goodbye) {
      c.lingering = true;
      c.lingerTimer = setTimeout(() => dropClient(c), config.lingerMs);
      return;
    }
    dropClient(c);
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

custodyHooks.leaveVoice = leaveVoice;

// dead connections: a client that stops answering pings is dropped within two sweeps
setInterval(() => void sweep(wss.clients), config.heartbeatMs);

ready
  .then(() => {
    setInterval(() => void tickCustody().catch((e) => console.error("[custody]", e)), 1000);
    setInterval(() => tickMeetings(), 5000);
    setInterval(() => void tickLoans().catch((e) => console.error("[loans]", e)), 15_000);
  })
  .then(() => httpServer.listen(config.port, () => console.log(`Omo Ibadan server listening on http/ws://localhost:${config.port} (database: ${db.kind})`)))
  .catch((e) => {
    console.error("Could not start:", e);
    process.exit(1);
  });
