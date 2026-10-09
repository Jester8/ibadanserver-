import type { IncomingMessage, ServerResponse } from "node:http";
import type { MeResult } from "../../src/lib/custodyRules";
import type { SocialFlags } from "../../src/lib/socialRules";
import { config } from "../config";
import { adminCases, adminDismiss, adminReleaseAll, askFriends, casesOf, confirmCase, fileCase, heldCase, heldFor, payBail, payFine, payeesFor, recentFor, viewOf, withdrawCase } from "../custody";
import { playerFlags, setPoliceBan } from "../db/repoCustody";
import { verifyToken } from "./auth";
import { isAdmin } from "./tracks";

const MAX_BODY = 4 * 1024;
const PID = /^[a-zA-Z0-9]{8,40}$/;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(c as Buffer);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    return body && typeof body === "object" && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** The least time between two calls of one kind from one player (ms). */
const gaps = new Map<string, number>();
export function tooSoon(key: string, who: string, gap: number, now: number): boolean {
  const k = `${key}|${who}`;
  if (now - (gaps.get(k) ?? 0) < gap) return true;
  gaps.set(k, now);
  if (gaps.size > 5000) for (const [kk, at] of gaps) if (now - at > 120_000) gaps.delete(kk);
  return false;
}

export const flagsNow = (now = Date.now()): SocialFlags => ({ custody: config.custody, efcc: config.custody && config.custodyEfcc, pokes: config.pokes, loans: config.loans, sales: config.plotSales, now });

/**
 * Police and EFCC cases, and which social features are on: /api/custody*, /api/social/flags, /api/admin/cases*,
 * /api/admin/players/:pid/police-ban. Every error is { error, code }. Returns true when it answered.
 */
export async function handleCustody(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const isCustody = path.startsWith("/api/custody/") || path === "/api/custody";
  const isAdminPath = path.startsWith("/api/admin/cases") || /^\/api\/admin\/players\/[^/]+\/police-ban$/.test(path);
  if (path !== "/api/social/flags" && !isCustody && !isAdminPath) return false;
  const send = (status: number, json: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  const fail = (status: number, code: string, error: string) => send(status, { error, code });
  const method = req.method ?? "GET";
  const answer = (r: { ok: true; data: object } | { ok: false; status: number; code: string; error: string }) => (r.ok ? send(200, r.data) : fail(r.status, r.code, r.error));

  if (path === "/api/social/flags") return send(200, flagsNow()), true;

  if (isAdminPath) {
    if (!isAdmin(req)) return fail(401, "AUTH", "admin only"), true;
    if (method === "GET" && path === "/api/admin/cases") {
      const status = url.searchParams.get("status") ?? "held";
      return send(200, { cases: (await adminCases(status.replace(/[^a-z]/g, ""))).map((c) => ({ ...c, evidence: c.evidence_json ? JSON.parse(c.evidence_json) : null, evidence_json: undefined })) }), true;
    }
    const body = method === "POST" ? await readJson(req) : null;
    if (method === "POST" && !body) return fail(400, "BAD", "bad json"), true;
    if (method === "POST" && path === "/api/admin/cases/release-all") return send(200, { released: await adminReleaseAll(String(body?.note ?? "")) }), true;
    const dismiss = /^\/api\/admin\/cases\/(\d+)\/dismiss$/.exec(path);
    if (method === "POST" && dismiss) return answer(await adminDismiss(Number(dismiss[1]), String(body?.note ?? ""), Math.max(0, Math.min(24 * 60, Number(body?.banReporterHours ?? 0) || 0)))), true;
    const ban = /^\/api\/admin\/players\/([^/]+)\/police-ban$/.exec(path);
    if (method === "POST" && ban) {
      if (!PID.test(ban[1]) || !(await playerFlags(ban[1]))) return fail(404, "NO_SUCH_PLAYER", "No such player."), true;
      const hours = Math.max(0, Math.min(24 * 60, Number(body?.hours ?? 0) || 0));
      await setPoliceBan(ban[1], hours > 0 ? Date.now() + hours * 3_600_000 : null);
      return send(200, { ok: true }), true;
    }
    return fail(404, "BAD", "not found"), true;
  }

  if (!config.custody) return fail(503, "OFF", "The police are not open yet."), true;
  const me = await verifyToken(req.headers.authorization?.replace(/^Bearer /i, ""));
  if (!me) return fail(401, "AUTH", "unauthorised"), true;
  const now = Date.now();

  if (method === "GET") {
    if (tooSoon(`get:${path}`, me, 500, now)) return fail(429, "RATE", "Slow down a little."), true;
    if (path === "/api/custody/me") {
      const f = await playerFlags(me);
      const mine = heldCase(me);
      const out: MeResult = {
        enabled: true,
        efcc: config.custodyEfcc,
        now,
        custody: mine ? viewOf(mine) : null,
        cases: await casesOf(me),
        standing: { filedLastHour: 0, maxPerHour: 3, banUntil: (f?.police_ban_until ?? 0) > now ? f!.police_ban_until : null, watchUntil: (f?.watch_until ?? 0) > now ? f!.watch_until : null },
      };
      out.standing.filedLastHour = out.cases.filter((c) => c.role === "reporter" && now - c.filedAt < 3_600_000).length;
      return send(200, out), true;
    }
    if (path === "/api/custody/recent") return send(200, { people: await recentFor(me, now) }), true;
    if (path === "/api/custody/payees") return send(200, { payees: config.custodyEfcc ? await payeesFor(me, now) : [] }), true;
    if (path === "/api/custody/held") return send(200, { held: await heldFor(me) }), true;
    return fail(404, "BAD", "not found"), true;
  }

  if (method === "POST") {
    const body = await readJson(req);
    if (!body) return fail(400, "BAD", "bad json"), true;
    const caseId = Math.floor(Number(body.caseId));
    const idOk = Number.isFinite(caseId) && caseId > 0;
    if (path === "/api/custody/report") {
      if (tooSoon("report", me, 5_000, now)) return fail(429, "RATE", "Slow down a little."), true;
      const r = await fileCase(me, { accused: String(body.accused ?? ""), reason: body.reason as never, via: body.via as never }, now);
      return answer(r), true;
    }
    if (tooSoon(`act:${path}`, me, 1_000, now)) return fail(429, "RATE", "Slow down a little."), true;
    if (path === "/api/custody/ask") return answer(await askFriends(me, now)), true;
    if (!idOk) return fail(400, "BAD", "Which case?"), true;
    if (path === "/api/custody/confirm") return answer(await confirmCase(me, caseId, now)), true;
    if (path === "/api/custody/withdraw") return answer(await withdrawCase(me, caseId, now)), true;
    if (path === "/api/custody/fine") return answer(await payFine(me, caseId, now)), true;
    if (path === "/api/custody/bail") return answer(await payBail(me, caseId, now)), true;
  }
  return fail(404, "BAD", "not found"), true;
}

