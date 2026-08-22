import { getArrivals, getStopDetail } from "./emt.js";
import { listStops, addStop, removeStop } from "./stops.js";
import { EmtError, errorResponse } from "./errors.js";

// KV rejects expirationTtl below 60, so the 20s freshness contract is a soft
// TTL decided here; the 60s write only bounds how long junk can linger.
const ARRIVALS_KV_TTL = 60;
const ARRIVALS_FRESH_MS = 20_000;
// Stop names/locations never move. A week of cache is quota-free.
const DETAIL_KV_TTL = 7 * 24 * 3600;

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,X-App-Key",
  };
}

function json(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });
}

/** The key ships in public JS. It filters scanners, not people — see the spec. */
function hasAppKey(request, env) {
  return request.headers.get("X-App-Key") === env.APP_KEY;
}

async function cachedArrivals(env, stopId) {
  const key = `arrivals:${stopId}`;
  const hit = await env.KV.get(key, "json");
  if (hit && Date.now() - hit.fetchedAt < ARRIVALS_FRESH_MS) return hit;
  const fresh = await getArrivals(env, stopId);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: ARRIVALS_KV_TTL });
  return fresh;
}

async function cachedStopDetail(env, stopId) {
  const key = `detail:${stopId}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getStopDetail(env, stopId);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: DETAIL_KV_TTL });
  return fresh;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    const isWrite = method === "POST" || method === "DELETE";
    if (isWrite && !hasAppKey(request, env)) {
      return json({ error: "unauthorized" }, env, 401);
    }

    try {
      if (pathname === "/arrivals" && method === "GET") {
        const stop = url.searchParams.get("stop");
        if (!stop) return json({ error: "missing stop parameter" }, env, 400);
        return json(await cachedArrivals(env, stop), env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env), env);
      }

      const detail = pathname.match(/^\/stops\/([^/]+)\/detail$/);
      if (detail && method === "GET") {
        return json(await cachedStopDetail(env, decodeURIComponent(detail[1])), env);
      }

      if (pathname === "/stops" && method === "POST") {
        const { stopId, label = null } = await request.json();
        return json(await addStop(env, { stopId, label }), env, 201);
      }

      const del = pathname.match(/^\/stops\/([^/]+)$/);
      if (del && method === "DELETE") {
        await removeStop(env, del[1]);
        return new Response(null, { status: 204, headers: cors(env) });
      }

      return json({ error: "not found" }, env, 404);
    } catch (err) {
      if (err instanceof EmtError) return errorResponse(err, cors(env));
      return errorResponse(new EmtError("upstream", err.message), cors(env));
    }
  },
};
