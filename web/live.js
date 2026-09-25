/** Live boards for the map, pushed by the worker over WebSockets.
 *
 * One socket per stop the map probes. The worker's LiveStop object fetches
 * each stop once per tick for everyone watching it and pushes the board, so
 * every open map shows the same buses at the same moment. The page keeps its
 * HTTP polling as the fallback: `fresh(stopId)` says whether a socket has
 * delivered recently, and anything not fresh is polled as before. */

const TICK_MS = 5_000;
// Two missed ticks plus slack before a stop counts as not live.
const FRESH_MS = 2 * TICK_MS + 2_000;
const MAX_BACKOFF_MS = 30_000;

export function createLive({ base, token, onBoard, WebSocketImpl = globalThis.WebSocket }) {
  const url = `${base.replace(/^http/, "ws")}/live?stop=`;
  const sockets = new Map(); // stop id → { ws, boardAt, failures, retry }

  function connect(stopId, entry) {
    const session = token();
    let ws;
    try {
      // Browsers cannot set headers on a socket: the sign-in token rides as
      // a second subprotocol, and the worker answers with "hubwise" alone.
      ws = new WebSocketImpl(url + encodeURIComponent(stopId), session ? ["hubwise", session] : ["hubwise"]);
    } catch {
      return; // polling carries on
    }
    entry.ws = ws;
    ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message?.type !== "board" || String(message.stopId) !== stopId) return;
      entry.boardAt = Date.now();
      entry.failures = 0;
      const { type, ...board } = message;
      onBoard(board);
    });
    ws.addEventListener("close", () => {
      if (sockets.get(stopId) !== entry || entry.ws !== ws) return; // closed on purpose
      entry.ws = null;
      entry.boardAt = 0;
      const wait = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** entry.failures++);
      entry.retry = setTimeout(() => {
        if (sockets.get(stopId) === entry) connect(stopId, entry);
      }, wait);
    });
  }

  function drop(stopId) {
    const entry = sockets.get(stopId);
    if (!entry) return;
    sockets.delete(stopId);
    clearTimeout(entry.retry);
    const { ws } = entry;
    entry.ws = null;
    try { ws?.close(1000); } catch { /* already closed */ }
  }

  return {
    /** Keep sockets open for exactly these stops. */
    want(stopIds) {
      const wanted = new Set([...stopIds].map(String));
      for (const stopId of [...sockets.keys()]) if (!wanted.has(stopId)) drop(stopId);
      if (!WebSocketImpl) return;
      for (const stopId of wanted) {
        if (sockets.has(stopId)) continue;
        const entry = { ws: null, boardAt: 0, failures: 0, retry: null };
        sockets.set(stopId, entry);
        connect(stopId, entry);
      }
    },
    /** Whether this stop's board arrived over its socket recently enough
     *  that the page need not poll it. */
    fresh(stopId) {
      const entry = sockets.get(String(stopId));
      return Boolean(entry?.ws && Date.now() - entry.boardAt < FRESH_MS);
    },
    /** Close everything, e.g. when the signed-in user changes: sockets carry
     *  the account they were opened with. */
    reset() {
      for (const stopId of [...sockets.keys()]) drop(stopId);
    },
  };
}
