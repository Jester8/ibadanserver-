import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { config } from "../config";

/**
 * The game's intro song. The file is never committed to git. In production it is only served when
 * INTRO_LICENSED=1, i.e. you are asserting you hold the artists' written permission to stream it.
 */
const file = () => join(config.introDir, "intro.mp3");
const allowed = () => existsSync(file()) && (!config.production || config.introLicensed);

function meta() {
  try {
    const m = JSON.parse(readFileSync(join(config.introDir, "intro.json"), "utf8")) as { title?: string; artist?: string; rightsHolder?: string };
    return { title: String(m.title ?? "Intro"), artist: String(m.artist ?? ""), rightsHolder: String(m.rightsHolder ?? m.artist ?? "") };
  } catch {
    return { title: "Intro", artist: "", rightsHolder: "" };
  }
}

export function handleIntro(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (req.method !== "GET" || !url.pathname.startsWith("/api/intro")) return false;
  if (url.pathname === "/api/intro") {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(allowed() ? { available: true, ...meta() } : { available: false }));
    return true;
  }
  if (url.pathname !== "/api/intro/audio" || !allowed()) {
    res.writeHead(404).end();
    return true;
  }
  const size = statSync(file()).size;
  const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ""));
  const base = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff" };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return true;
    }
    res.writeHead(206, { ...base, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    createReadStream(file(), { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, "content-length": size });
  createReadStream(file()).pipe(res);
  return true;
}
