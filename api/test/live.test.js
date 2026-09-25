import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";
import { liveStop, LIVE_INTERVAL } from "../src/live.js";
import { clearTokenMemoryForTest } from "../src/emt.js";

// Supabase and EMT are stubbed as in emt-account.test.js: the bearer token
// doubles as the user id, and EMT logins answer with a token naming the
// email, so a board shows whose quota paid for it.
const rows = new Map();
let upstream;
let stop = 5000;
const nextStop = () => String(stop++);
const opened = [];
const boards = () => upstream.mock.calls.filter(([url]) => String(url).includes("/arrives/"))
  .map(([, init]) => init.headers.accessToken);

async function open(stopId, { token, origin = env.ALLOWED_ORIGIN, protocols } = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://live.test/live?stop=${stopId}`, {
    headers: {
      Upgrade: "websocket",
      ...(origin ? { Origin: origin } : {}),
      "Sec-WebSocket-Protocol": (protocols ?? ["hubwise", ...(token ? [token] : [])]).join(", "),
    },
  }), env, ctx);
  await waitOnExecutionContext(ctx);
  if (response.status !== 101) return { response };
  const socket = response.webSocket;
  opened.push(socket);
  const messages = [];
  let wake = () => {};
  socket.addEventListener("message", (event) => { messages.push(JSON.parse(event.data)); wake(); });
  socket.accept();
  /** The next message not seen yet. */
  const next = async () => {
    const seen = messages.length;
    for (let i = 0; i < 50 && messages.length === seen; i++) {
      await Promise.race([new Promise((resolve) => { wake = resolve; }), new Promise((r) => setTimeout(r, 20))]);
    }
    return messages[seen];
  };
  return { response, socket, messages, next };
}
const tick = (stopId) => runDurableObjectAlarm(liveStop(env, stopId));
const alarmAt = (stopId) => runInDurableObject(liveStop(env, stopId), (_, ctx) => ctx.storage.getAlarm());

beforeEach(async () => {
  rows.clear();
  clearTokenMemoryForTest();
  await env.KV.put("emt:token", "shared-token");
  upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return Response.json({ id: init.headers.Authorization.slice(7) });
    if (path.includes("/rest/v1/emt_accounts")) {
      const user = init.headers.Authorization.slice(7);
      if (init.method === "POST") rows.set(user, JSON.parse(init.body));
      return init.method ? new Response(null, { status: 204 }) : Response.json(rows.has(user) ? [rows.get(user)] : []);
    }
    if (path.includes("/mobilitylabs/user/login")) return Response.json({
      code: "01", data: [{ accessToken: `bus:${init.headers.email}`, tokenSecExpiration: 3600 }],
    });
    if (path.includes("/arrives/")) {
      return Response.json({ code: "00", data: [{ Arrive: [{ line: "70", destination: "PLAZA", bus: 123, estimateArrive: 300, DistanceBus: 800 }] }] });
    }
    throw new Error(`Unexpected mock request: ${new URL(path).pathname}`);
  });
});
afterEach(async () => {
  // A socket left open past its test breaks the harness's isolated storage.
  for (const socket of opened.splice(0)) {
    try { socket.close(1000); } catch { /* already closed */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  vi.restoreAllMocks();
});

describe("live map sockets", () => {
  it("refuses other origins, bad stops and sockets without the protocol", async () => {
    expect((await open(nextStop(), { origin: "https://evil.example" })).response.status).toBe(403);
    expect((await open(nextStop(), { origin: null })).response.status).toBe(403);
    expect((await open("abc")).response.status).toBe(400);
    expect((await open(nextStop(), { protocols: ["other"] })).response.status).toBe(400);
  });

  it("pushes one board per tick to every viewer of a stop, with one EMT call", async () => {
    const id = nextStop();
    const alice = await open(id);
    const bob = await open(id);
    expect(alice.response.headers.get("Sec-WebSocket-Protocol")).toBe("hubwise");
    const [first, second] = [alice.next(), bob.next()];
    await tick(id);
    for (const board of [await first, await second]) {
      expect(board).toMatchObject({ type: "board", stopId: id });
      expect(board.arrivals).toHaveLength(1);
    }
    expect(boards()).toEqual(["shared-token"]);
    const next = await alarmAt(id);
    expect(next - Date.now()).toBeLessThanOrEqual(LIVE_INTERVAL);
  });

  it("hands a late joiner the current board without another EMT call", async () => {
    const id = nextStop();
    const early = await open(id);
    const first = early.next();
    await tick(id);
    await first;
    const late = await open(id);
    expect((await late.next())).toMatchObject({ type: "board", stopId: id });
    expect(boards()).toHaveLength(1);
  });

  it("stops ticking once every viewer has gone", async () => {
    const id = nextStop();
    const viewer = await open(id);
    const first = viewer.next();
    await tick(id);
    await first;
    viewer.socket.close(1000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await tick(id);
    expect(await alarmAt(id)).toBeNull();
    expect(boards()).toHaveLength(1);
  });

  it("with accounts required, spends connected viewers' quota and never polls for guests alone", async () => {
    const id = nextStop();
    await runInDurableObject(liveStop(env, id), (instance) => { instance.env = { ...instance.env, EMT_ACCOUNT: "required" }; });
    const guest = await open(id);
    const refused = guest.next();
    await tick(id);
    expect(await refused).toMatchObject({ type: "error", error: "emt_account" });
    expect(boards()).toEqual([]);
    expect(await alarmAt(id)).toBeNull(); // waits for someone who can pay

    const ctx = createExecutionContext();
    const connected = await worker.fetch(new Request("https://live.test/auth/emt", {
      method: "PUT",
      headers: { Authorization: "Bearer alice", "content-type": "application/json" },
      body: JSON.stringify({ email: "alice@example.test", password: "alice-password" }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(connected.status).toBe(200);
    const alice = await open(id, { token: "alice" });
    expect(await alarmAt(id)).not.toBeNull(); // her socket restarted the stop
    const [forGuest, forAlice] = [guest.next(), alice.next()];
    await tick(id);
    expect(await forGuest).toMatchObject({ type: "board" });
    expect(await forAlice).toMatchObject({ type: "board" });
    expect(boards()).toEqual(["bus:alice@example.test"]);
  });
});
