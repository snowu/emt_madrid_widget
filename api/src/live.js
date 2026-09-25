import { DurableObject } from "cloudflare:workers";
import { getArrivals } from "./emt.js";
import { authenticatedUser } from "./auth.js";
import { accountRow, openCredentials, scopedEnvironment, accountRequired } from "./emt-account.js";
import { EmtError } from "./errors.js";
import { recordEdgeMetric } from "./metrics.js";

/* The live map, pushed instead of polled.
 *
 * The map used to ask /arrivals every five seconds for each stop it probes,
 * from every open page. Now each page opens one WebSocket per probed stop to
 * that stop's LiveStop object, which fetches the board once per interval for
 * everyone watching and pushes it to every socket: one EMT call per stop per
 * tick however many people look, every viewer sees the same board at the
 * same moment, and no page sends a request per tick.
 *
 * Whose quota: like the tracking pollers, the connected viewers' own EMT
 * accounts in turn (the shared login only when accounts are optional). A
 * socket carries its viewer's account as ciphertext, resolved once by the
 * worker when the socket opens. Guests and unconnected viewers may listen —
 * they get what connected viewers already pay for, exactly like a cache hit
 * — but a stop nobody connected is watching is not polled at all.
 *
 * The object ticks on an alarm only while sockets are open; pages close
 * theirs when the map is hidden or the tab goes to the background.
 */

export const LIVE_INTERVAL = 5_000;
export const LIVE_PROTOCOL = "hubwise";
const named = (namespace, name) => namespace.get(namespace.idFromName(name));
export const liveStop = (env, stopId) => named(env.LIVE_STOP, String(stopId));

/** GET /live?stop= with Upgrade: websocket. Browsers cannot set headers on a
 *  WebSocket, so the page offers its sign-in token as a second subprotocol
 *  next to "hubwise"; only "hubwise" is echoed back. */
export async function openLiveSocket(request, env) {
  const stop = new URL(request.url).searchParams.get("stop") ?? "";
  if (!/^\d{1,8}$/.test(stop)) throw new EmtError("bad_request", "Choose a bus stop");
  // WebSockets ignore CORS: without this any site could open sockets as
  // whoever is signed in and spend their quota.
  if (request.headers.get("Origin") !== env.ALLOWED_ORIGIN) throw new EmtError("forbidden", "Origin not allowed");
  const offered = (request.headers.get("Sec-WebSocket-Protocol") ?? "").split(",").map((p) => p.trim());
  if (!offered.includes(LIVE_PROTOCOL)) throw new EmtError("bad_request", "Unsupported protocol");
  const token = offered.find((p) => p && p !== LIVE_PROTOCOL);
  let account = null;
  let who = "guest";
  if (token && env.EMT_CREDENTIAL_KEY) {
    who = "unconnected";
    const authed = new Request(request.url, { headers: { Authorization: `Bearer ${token}` } });
    try {
      const user = await authenticatedUser(env, authed);
      const row = await accountRow(env, authed, user);
      if (row) {
        account = { userId: user.id, connectionId: row.connection_id, credentials: row.credentials };
        who = "connected";
      }
    } catch { /* an expired session listens like a guest */ }
  }
  recordEdgeMetric(env, { endpoint: "live", cache: "socket", target: stop, caller: "live", who });
  return liveStop(env, stop).fetch(new Request(`https://live.internal/?stop=${stop}`, {
    headers: { Upgrade: "websocket", "x-live-account": JSON.stringify(account) },
  }));
}

export class LiveStop extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.board = null; // the last board, for sockets that join mid-interval
  }

  async fetch(request) {
    const stop = new URL(request.url).searchParams.get("stop");
    if (request.headers.get("Upgrade") !== "websocket" || !stop) return new Response(null, { status: 400 });
    if (await this.ctx.storage.get("stop") !== stop) await this.ctx.storage.put("stop", stop);
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ account: JSON.parse(request.headers.get("x-live-account") || "null") });
    if (this.board && Date.now() - this.board.fetchedAt < LIVE_INTERVAL) {
      server.send(JSON.stringify(this.board));
    }
    // A viewer who can pay restarts a stop that stopped for lack of one. Tests
    // delay the first tick and run ticks themselves, as with the pollers.
    const delay = Number(this.env.POLLER_START_DELAY_MS ?? 0);
    if (await this.ctx.storage.getAlarm() == null) await this.ctx.storage.setAlarm(Date.now() + delay);
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": LIVE_PROTOCOL } });
  }

  /** Whose quota this tick may spend, in the order to try: connected viewers
   *  in turn, then the shared login when accounts are optional. */
  async environments(sockets, now) {
    const byUser = new Map();
    for (const socket of sockets) {
      const account = socket.deserializeAttachment()?.account;
      if (account) byUser.set(account.userId, account);
    }
    const accounts = [...byUser.values()].sort((a, b) => a.userId.localeCompare(b.userId));
    const start = accounts.length ? Math.floor(now / LIVE_INTERVAL) % accounts.length : 0;
    const envs = [];
    for (const account of [...accounts.slice(start), ...accounts.slice(0, start)]) {
      try {
        const credentials = await openCredentials(this.env, account.userId, account.credentials);
        envs.push(scopedEnvironment(this.env, credentials, `${account.userId}:${account.connectionId}`));
      } catch { /* undecryptable: skip this viewer's account */ }
    }
    if (!accountRequired(this.env)) envs.push(this.env);
    return envs;
  }

  async alarm() {
    const sockets = this.ctx.getWebSockets();
    const stop = await this.ctx.storage.get("stop");
    if (!sockets.length || !stop) return; // nobody watching: stop ticking
    const now = Date.now();
    const envs = await this.environments(sockets, now);
    if (!envs.length) {
      // Nobody here can pay. Say so, and wait for a viewer who can.
      this.broadcast(sockets, { type: "error", stopId: stop, error: "emt_account", message: "Connect your EMT account to see live buses" });
      return;
    }
    await this.ctx.storage.setAlarm(now + LIVE_INTERVAL);
    let lastError;
    for (const env of envs) {
      try {
        const board = await getArrivals(env, stop, "live");
        this.board = { type: "board", stopId: stop, arrivals: board.arrivals, fetchedAt: board.fetchedAt ?? now };
        this.broadcast(this.ctx.getWebSockets(), this.board);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    this.broadcast(this.ctx.getWebSockets(), {
      type: "error", stopId: stop, error: lastError?.kind ?? "upstream", message: String(lastError?.message ?? lastError),
    });
  }

  broadcast(sockets, message) {
    const text = JSON.stringify(message);
    for (const socket of sockets) {
      try { socket.send(text); } catch { /* closing; the runtime cleans it up */ }
    }
  }

  async webSocketMessage() { /* pages only listen */ }

  async webSocketClose(socket, code) {
    try { socket.close(code === 1005 ? 1000 : code, "bye"); } catch { /* already closed */ }
  }

  async webSocketError(socket) {
    try { socket.close(1011, "error"); } catch { /* already closed */ }
  }
}
