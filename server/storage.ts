import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { createReadStream, existsSync, mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

/**
 * Where uploaded music files live.
 *  - production: a private Supabase Storage bucket (SUPABASE_URL + SUPABASE_SERVICE_KEY + SUPABASE_BUCKET), so nothing is lost when Render redeploys;
 *  - local development: a folder on disk.
 */
export type Storage = {
  put(name: string, data: Buffer, mime: string): Promise<void>;
  remove(name: string): Promise<void>;
  /** Stream a file to the response with Range support. Returns false if it does not exist. */
  serve(req: IncomingMessage, res: ServerResponse, name: string, mime: string): Promise<boolean>;
};

const headersBase = (mime: string) => ({ "content-type": mime, "accept-ranges": "bytes", "cache-control": "private, max-age=300", "x-content-type-options": "nosniff" });

const disk: Storage = {
  async put(name, data) {
    mkdirSync(config.tracksDir, { recursive: true });
    writeFileSync(join(config.tracksDir, name), data);
  },
  async remove(name) {
    const p = join(config.tracksDir, name);
    if (existsSync(p)) unlinkSync(p);
  },
  async serve(req, res, name, mime) {
    const path = join(config.tracksDir, name);
    if (!existsSync(path)) return false;
    const size = statSync(path).size;
    const range = /bytes=(\d*)-(\d*)/.exec(String(req.headers.range ?? ""));
    if (range) {
      const start = range[1] ? Number(range[1]) : 0;
      const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "content-range": `bytes */${size}` }).end();
        return true;
      }
      res.writeHead(206, { ...headersBase(mime), "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
      createReadStream(path, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...headersBase(mime), "content-length": size });
    createReadStream(path).pipe(res);
    return true;
  },
};

const supa = (): Storage => {
  const base = `${config.supabaseUrl.replace(/\/$/, "")}/storage/v1/object/${config.supabaseBucket}`;
  const auth = { authorization: `Bearer ${config.supabaseServiceKey}`, apikey: config.supabaseServiceKey };
  return {
    async put(name, data, mime) {
      const r = await fetch(`${base}/${encodeURIComponent(name)}`, { method: "POST", headers: { ...auth, "content-type": mime, "x-upsert": "true" }, body: new Uint8Array(data) });
      if (!r.ok) throw new Error(`storage upload failed: ${r.status} ${await r.text()}`);
    },
    async remove(name) {
      await fetch(`${base}/${encodeURIComponent(name)}`, { method: "DELETE", headers: auth }).catch(() => undefined);
    },
    async serve(req, res, name, mime) {
      const r = await fetch(`${base}/${encodeURIComponent(name)}`, { headers: { ...auth, ...(req.headers.range ? { range: String(req.headers.range) } : {}) } });
      if (r.status === 404 || r.status === 400) return false;
      if (!r.ok && r.status !== 206 && r.status !== 416) return false;
      const out: Record<string, string> = { ...headersBase(mime) };
      for (const h of ["content-length", "content-range"]) {
        const v = r.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(r.status, out);
      if (!r.body) res.end();
      else Readable.fromWeb(r.body as import("node:stream/web").ReadableStream).pipe(res);
      return true;
    },
  };
};

export const storage: Storage = config.supabaseUrl && config.supabaseServiceKey ? supa() : disk;
