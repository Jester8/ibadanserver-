import type { IncomingMessage, ServerResponse } from "node:http";

/* Justice server owner replaces the body: /api/custody*, /api/admin/cases*, /api/social/flags. Returns true when it answered. */
export async function handleCustody(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  void req; void res; void url;
  return false;
}
