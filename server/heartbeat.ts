import type { WebSocket } from "ws";

/*
 * Dead-connection sweep. A phone that loses signal never says goodbye, so its avatar would stand frozen in the city for ever.
 * Every sweep, a socket that has not answered the previous ping is terminated (the close handler then removes the player);
 * the others are pinged again. Browsers answer pings in the network stack, so a background tab with throttled timers is not
 * dropped. With the default 20-second sweep a lost connection is gone within 40 seconds.
 */
const alive = new WeakSet<WebSocket>();

/** Start watching a socket: it counts as alive now and every time it answers a ping. */
export function watch(ws: WebSocket): void {
  alive.add(ws);
  ws.on("pong", () => alive.add(ws));
}

/** One sweep over the connected sockets. Returns how many were dropped. */
export function sweep(sockets: Iterable<WebSocket>): number {
  let dropped = 0;
  for (const ws of sockets) {
    if (!alive.has(ws)) {
      ws.terminate();
      dropped++;
      continue;
    }
    alive.delete(ws);
    try {
      ws.ping();
    } catch {
      /* closing already: the next sweep drops it */
    }
  }
  return dropped;
}
