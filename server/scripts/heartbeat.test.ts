// server/scripts/heartbeat.test.ts: npm test. The dead-connection sweep, with fake sockets (no network, no server).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import type { WebSocket } from "ws";
import { sweep, watch } from "../heartbeat";

class FakeSocket extends EventEmitter {
  pings = 0;
  terminated = false;
  failPing = false;
  ping() {
    if (this.failPing) throw new Error("closing");
    this.pings++;
  }
  terminate() {
    this.terminated = true;
  }
}
const make = () => {
  const s = new FakeSocket();
  watch(s as unknown as WebSocket);
  return s;
};
const all = (...s: FakeSocket[]) => s as unknown as WebSocket[];

describe("the sweep", () => {
  test("a socket that answers every ping is never dropped", () => {
    const s = make();
    for (let i = 0; i < 5; i++) {
      assert.equal(sweep(all(s)), 0);
      s.emit("pong");
    }
    assert.equal(s.pings, 5);
    assert.equal(s.terminated, false);
  });

  test("one that misses a ping is dropped on the next sweep, and only that one", () => {
    const quiet = make();
    const chatty = make();
    assert.equal(sweep(all(quiet, chatty)), 0, "the first sweep only pings");
    chatty.emit("pong");
    assert.equal(sweep(all(quiet, chatty)), 1);
    assert.equal(quiet.terminated, true);
    assert.equal(chatty.terminated, false);
    assert.equal(chatty.pings, 2);
  });

  test("a socket that is already closing does not break the sweep", () => {
    const bad = make();
    bad.failPing = true;
    const good = make();
    assert.doesNotThrow(() => sweep(all(bad, good)));
    assert.equal(good.pings, 1);
  });
});
