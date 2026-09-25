import { test } from "node:test";
import assert from "node:assert/strict";
import { createLive } from "../web/live.js";

/** A WebSocket stand-in the test drives by hand. */
function fakeSockets() {
  const made = [];
  class FakeSocket extends EventTarget {
    constructor(url, protocols) {
      super();
      Object.assign(this, { url, protocols, closed: false });
      made.push(this);
    }
    close() {
      this.closed = true;
      this.dispatchEvent(new Event("close"));
    }
    push(message) {
      this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(message) }));
    }
  }
  return { FakeSocket, made };
}

test("opens one socket per wanted stop, offering the sign-in token as a subprotocol", () => {
  const { FakeSocket, made } = fakeSockets();
  let session = "jwt.token.here";
  const live = createLive({ base: "https://w.dev", token: () => session, onBoard: () => {}, WebSocketImpl: FakeSocket });
  live.want(["10", "20"]);
  live.want(["10", "20"]); // already open: nothing new
  assert.deepEqual(made.map((s) => s.url), ["wss://w.dev/live?stop=10", "wss://w.dev/live?stop=20"]);
  assert.deepEqual(made[0].protocols, ["hubwise", "jwt.token.here"]);
  live.want(["20"]);
  assert.equal(made[0].closed, true);
  session = null;
  live.want(["20", "30"]);
  assert.deepEqual(made[2].protocols, ["hubwise"]);
});

test("hands boards on and counts a stop as fresh only while boards keep coming", () => {
  const { FakeSocket, made } = fakeSockets();
  const boards = [];
  const live = createLive({ base: "https://w.dev", token: () => null, onBoard: (b) => boards.push(b), WebSocketImpl: FakeSocket });
  live.want(["10"]);
  assert.equal(live.fresh("10"), false); // nothing yet: keep polling
  made[0].push({ type: "error", stopId: "10", error: "emt_account" });
  made[0].push({ type: "board", stopId: "99", arrivals: [], fetchedAt: 1 }); // not this socket's stop
  assert.equal(live.fresh("10"), false);
  made[0].push({ type: "board", stopId: "10", arrivals: [{ line: "70" }], fetchedAt: 5 });
  assert.equal(live.fresh(10), true);
  assert.deepEqual(boards, [{ stopId: "10", arrivals: [{ line: "70" }], fetchedAt: 5 }]);
});

test("reconnects a socket the server closed, but not one closed on purpose", async () => {
  const { FakeSocket, made } = fakeSockets();
  const live = createLive({ base: "https://w.dev", token: () => null, onBoard: () => {}, WebSocketImpl: FakeSocket });
  live.want(["10"]);
  made[0].push({ type: "board", stopId: "10", arrivals: [], fetchedAt: 1 });
  made[0].close(); // dropped by the network
  assert.equal(live.fresh("10"), false);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(made.length, 2);
  live.reset();
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  assert.equal(made.length, 2);
  assert.equal(made[1].closed, true);
});

test("without WebSocket support everything stays on polling", () => {
  const live = createLive({ base: "https://w.dev", token: () => null, onBoard: () => {}, WebSocketImpl: undefined });
  live.want(["10"]);
  assert.equal(live.fresh("10"), false);
});
