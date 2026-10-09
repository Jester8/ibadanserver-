import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { storage } from "../storage";
import { config } from "../config";
import { countRecentTracks, createTrack, deleteTrackRow, getTrack, listTracks, reviewTrack, setTrackFile, tracksOf, type TrackRow } from "../db/repo";
import { verifyToken } from "./auth";

/**
 * Artist platform. Rules the code enforces:
 *  - only the signed-in uploader can add audio to their own track,
 *  - the uploader must declare they own the rights (stored with the track),
 *  - nothing plays for anyone else until an admin approves it,
 *  - the owner (or an admin) can take a track down at any time.
 */

const MAX_BYTES = 12 * 1024 * 1024;
const clean = (s: unknown, max: number) => String(s ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);

const publicView = (t: TrackRow) => ({ id: t.id, title: t.title, artist: t.artist, rightsHolder: t.rights_holder, createdAt: t.created_at });
const ownerView = (t: TrackRow) => ({ ...publicView(t), status: t.status, hasAudio: !!t.file, note: t.review_note });

function sniff(buf: Buffer): { ext: string; mime: string } | null {
  if (buf.length < 12) return null;
  const head = buf.subarray(0, 4).toString("latin1");
  if (head.startsWith("ID3") || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { ext: "mp3", mime: "audio/mpeg" };
  if (head === "OggS") return { ext: "ogg", mime: "audio/ogg" };
  if (head === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WAVE") return { ext: "wav", mime: "audio/wav" };
  if (buf.subarray(4, 8).toString("latin1") === "ftyp") return { ext: "m4a", mime: "audio/mp4" };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { ext: "webm", mime: "audio/webm" };
  return null;
}

export const isAdmin = (req: IncomingMessage) => {
  const given = Buffer.from(String(req.headers["x-admin-token"] ?? ""));
  const want = Buffer.from(config.adminToken);
  return given.length === want.length && timingSafeEqual(given, want);
};

async function readRaw(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) return null;
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const raw = await readRaw(req, 16 * 1024);
  if (!raw) return null;
  try {
    return JSON.parse(raw.toString("utf8") || "{}");
  } catch {
    return null;
  }
}

/** Returns true when it handled the request. */
export async function handleTracks(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/api/tracks") && !path.startsWith("/api/admin/tracks")) return false;
  const send = (status: number, json: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  const pid = await verifyToken(req.headers.authorization?.replace(/^Bearer /i, ""));
  const parts = path.split("/").filter(Boolean); // api, tracks, :id, audio

  // ---- public catalogue: approved tracks only
  if (req.method === "GET" && path === "/api/tracks") {
    send(200, { tracks: (await listTracks("approved")).map(publicView) });
    return true;
  }
  if (req.method === "GET" && path === "/api/tracks/mine") {
    if (!pid) return send(401, { error: "unauthorised" }), true;
    send(200, { tracks: (await tracksOf(pid)).map(ownerView) });
    return true;
  }

  // ---- create the track record (with the rights declaration)
  if (req.method === "POST" && path === "/api/tracks") {
    if (!pid) return send(401, { error: "unauthorised" }), true;
    const b = await readJson(req);
    if (!b) return send(400, { error: "bad json" }), true;
    const title = clean(b.title, 80);
    const artist = clean(b.artist, 60);
    const rightsHolder = clean(b.rightsHolder, 80);
    if (!title || !artist || !rightsHolder) return send(400, { error: "title, artist and rights holder are required" }), true;
    if (b.declare !== true) return send(400, { error: "you must confirm you own the rights or have written permission" }), true;
    if ((await countRecentTracks(pid, Date.now() - 24 * 3600_000)) >= 5) return send(429, { error: "daily upload limit reached" }), true;
    const id = randomUUID().replace(/-/g, "").slice(0, 16);
    const statement = `On ${new Date().toISOString()} ${pid} declared: "I own the copyright in this recording and composition, or have the owner's written permission, and I allow Omo Ibadan to stream it in the game. I keep all my rights and can remove it at any time." Rights holder: ${rightsHolder}.`;
    await createTrack({ id, title, artist, ownerPid: pid, rightsHolder, statement });
    send(200, { id });
    return true;
  }

  // ---- upload the audio file (raw body)
  if (req.method === "PUT" && parts.length === 4 && parts[1] === "tracks" && parts[3] === "audio") {
    if (!pid) return send(401, { error: "unauthorised" }), true;
    const t = await getTrack(parts[2]);
    if (!t || t.owner_pid !== pid) return send(404, { error: "not found" }), true;
    const buf = await readRaw(req, MAX_BYTES);
    if (!buf) return send(413, { error: "file is larger than 12 MB" }), true;
    const kind = sniff(buf);
    if (!kind) return send(415, { error: "unsupported audio. Use mp3, m4a, ogg, wav or webm" }), true;
    if (t.file) await storage.remove(t.file);
    const file = `${t.id}.${kind.ext}`;
    await storage.put(file, buf, kind.mime);
    await setTrackFile(t.id, file, kind.mime, buf.length);
    send(200, { ok: true, status: "pending" });
    return true;
  }

  // ---- stream (approved to everyone; otherwise owner or admin)
  if (req.method === "GET" && parts.length === 4 && parts[1] === "tracks" && parts[3] === "audio") {
    const t = await getTrack(parts[2]);
    if (!t || !t.file) return send(404, { error: "not found" }), true;
    const allowed = t.status === "approved" || (pid && pid === t.owner_pid) || isAdmin(req);
    if (!allowed) return send(403, { error: "not available" }), true;
    if (!(await storage.serve(req, res, t.file, t.mime ?? "audio/mpeg"))) send(404, { error: "not found" });
    return true;
  }

  // ---- takedown by the owner (or an admin)
  if (req.method === "DELETE" && parts.length === 3 && parts[1] === "tracks") {
    const t = await getTrack(parts[2]);
    if (!t) return send(404, { error: "not found" }), true;
    if (!(pid && pid === t.owner_pid) && !isAdmin(req)) return send(403, { error: "not yours" }), true;
    if (t.file) await storage.remove(t.file);
    await deleteTrackRow(t.id);
    send(200, { ok: true });
    return true;
  }

  // ---- admin review
  if (path.startsWith("/api/admin/tracks")) {
    if (!isAdmin(req)) return send(401, { error: "admin only" }), true;
    if (req.method === "GET" && path === "/api/admin/tracks") {
      const status = ["pending", "approved", "rejected"].includes(url.searchParams.get("status") ?? "") ? url.searchParams.get("status")! : "pending";
      send(200, { tracks: (await listTracks(status)).map((t) => ({ ...ownerView(t), ownerPid: t.owner_pid, statement: t.rights_statement })) });
      return true;
    }
    if (req.method === "POST" && parts.length === 5 && parts[4] === "review") {
      const b = await readJson(req);
      const t = await getTrack(parts[3]);
      if (!b || !t) return send(404, { error: "not found" }), true;
      if (b.status !== "approved" && b.status !== "rejected") return send(400, { error: "status must be approved or rejected" }), true;
      if (b.status === "approved" && !t.file) return send(400, { error: "no audio uploaded yet" }), true;
      await reviewTrack(t.id, b.status, clean(b.note, 200));
      send(200, { ok: true });
      return true;
    }
  }
  send(404, { error: "not found" });
  return true;
}
