import type { IncomingMessage, ServerResponse } from "node:http";
import { adminLoans, forgiveLoan, getLoan, offerFor, repayLoan, takeLoan, tooSoon, unseizePlot } from "../loans";
import { quoteSale, sellPlot } from "../property";
import { verifyToken } from "./auth";
import { isAdmin } from "./tracks";

const PLOT_ID = /^[a-z0-9-]{1,40}$/;
const PID = /^[a-zA-Z0-9]{8,40}$/;
/** Same shape as the bank's: money routes take small JSON bodies only. */
const MAX_BODY = 4 * 1024;

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

/**
 * Loans, selling land, and the moderator routes for both: /api/loan*, /api/plots/*, /api/admin/loans*, /api/admin/plots/*.
 * Every error is { error, code }. Returns true when it answered.
 */
export async function handleLoans(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  if (path !== "/api/loan" && !path.startsWith("/api/loan/") && !path.startsWith("/api/plots/") && !path.startsWith("/api/admin/loans") && !path.startsWith("/api/admin/plots/")) return false;
  const send = (status: number, json: unknown) => void res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
  const fail = (status: number, code: string, error: string) => send(status, { error, code });
  const method = req.method ?? "GET";
  const answer = (r: { ok: true; data: object } | { ok: false; status: number; code: string; error: string }, extra: object = {}) => (r.ok ? send(200, { ...extra, ...r.data }) : fail(r.status, r.code, r.error));

  if (path.startsWith("/api/admin/")) {
    if (!isAdmin(req)) return fail(401, "AUTH", "admin only"), true;
    if (method === "GET" && path === "/api/admin/loans") {
      return send(200, { loans: await adminLoans(url.searchParams.get("status") === "closed" ? "closed" : "active") }), true;
    }
    if (method === "POST") {
      const body = await readJson(req);
      if (!body) return fail(400, "BAD", "bad json"), true;
      if (path === "/api/admin/loans/forgive") {
        const pid = String(body.pid ?? "");
        if (!PID.test(pid)) return fail(400, "BAD", "Give the player id."), true;
        const r = await forgiveLoan(pid);
        if (r.ok) console.log(`[loans] a moderator forgave loan ${r.data.id} of ${pid}${body.note ? `: ${String(body.note).replace(/[\u0000-\u001f]/g, " ").slice(0, 200)}` : ""}`);
        return answer(r, { ok: true }), true;
      }
      if (path === "/api/admin/plots/unseize") {
        const plotId = String(body.plotId ?? "");
        if (!PLOT_ID.test(plotId)) return fail(400, "BAD", "Give the plot id."), true;
        return answer(await unseizePlot(plotId), { ok: true }), true;
      }
    }
    return fail(404, "BAD", "not found"), true;
  }

  const me = await verifyToken(req.headers.authorization?.replace(/^Bearer /i, ""));
  if (!me) return fail(401, "AUTH", "unauthorised"), true;
  if (method === "GET" && tooSoon(`get:${path}`, me, 500, Date.now())) return fail(429, "RATE", "Slow down a little."), true;

  if (method === "GET" && path === "/api/loan/offer") return send(200, await offerFor(me)), true;
  if (method === "GET" && path === "/api/loan") return answer(await getLoan(me)), true;
  if (method === "GET" && path === "/api/plots/quote") {
    const plotId = url.searchParams.get("plotId") ?? "";
    if (!PLOT_ID.test(plotId)) return fail(400, "BAD", "Give the plot id."), true;
    return answer(await quoteSale(me, plotId)), true;
  }

  if (method === "POST") {
    const body = await readJson(req);
    if (!body) return fail(400, "BAD", "bad json"), true;
    if (path === "/api/loan/take") return answer(await takeLoan(me, body.amount, body.termMin)), true;
    if (path === "/api/loan/repay") return answer(await repayLoan(me, body.amount)), true;
    if (path === "/api/plots/sell") {
      const plotId = typeof body.plotId === "string" ? body.plotId : "";
      if (!PLOT_ID.test(plotId)) return fail(400, "BAD", "Give the plot id."), true;
      return answer(await sellPlot(me, plotId), { ok: true }), true;
    }
  }
  return fail(404, "BAD", "not found"), true;
}
