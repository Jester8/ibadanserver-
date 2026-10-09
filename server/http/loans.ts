import type { IncomingMessage, ServerResponse } from "node:http";

/* Money server owner replaces the body: /api/loan*, /api/plots/*, /api/admin/loans*. Returns true when it answered. */
export async function handleLoans(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  void req; void res; void url;
  return false;
}
