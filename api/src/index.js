import {
  getArrivals,
  getStopDetail,
  getNearbyStops,
  getLineTimetable,
  getLineRoute,
} from "./emt.js";
import { listStops, addStop, renameStop, removeStop } from "./stops.js";
import { EmtError, errorResponse } from "./errors.js";

// KV rejects expirationTtl below 60, so the 20s freshness contract is a soft
// TTL decided here; the 60s write only bounds how long junk can linger.
const ARRIVALS_KV_TTL = 60;
const ARRIVALS_FRESH_MS = 20_000;
// Bump when a cached payload's *shape* changes: old entries would otherwise
// keep serving the old shape until their TTL runs out (a week, for detail).
const CACHE_VERSION = "v2";
// Stop names/locations never move. A week of cache is quota-free.
const DETAIL_KV_TTL = 7 * 24 * 3600;
// Nearby searches are keyed on a ~110m grid so panning the map reuses cells.
const NEARBY_KV_TTL = 24 * 3600;
// A line's timetable changes with the season, not with the hour.
const TIMETABLE_KV_TTL = 24 * 3600;
// Route geometry changes when EMT redraws a line — a week is generous.
const ROUTE_KV_TTL = 7 * 24 * 3600;
// Cards want the next bus and the one after it; the stop sheet wants the board.
const DEFAULT_ARRIVALS = 2;
const MAX_ARRIVALS = 20;

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
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
  const key = `arrivals:${CACHE_VERSION}:${stopId}`;
  const hit = await env.KV.get(key, "json");
  if (hit && Date.now() - hit.fetchedAt < ARRIVALS_FRESH_MS) return hit;
  const fresh = await getArrivals(env, stopId);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: ARRIVALS_KV_TTL });
  return fresh;
}

async function cachedStopDetail(env, stopId) {
  const key = `detail:${CACHE_VERSION}:${stopId}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getStopDetail(env, stopId);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: DETAIL_KV_TTL });
  return fresh;
}

async function cachedTimetable(env, line) {
  const key = `timetable:${CACHE_VERSION}:${line}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getLineTimetable(env, line);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: TIMETABLE_KV_TTL });
  return fresh;
}

async function cachedRoute(env, line) {
  const key = `route:${CACHE_VERSION}:${line}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getLineRoute(env, line);
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: ROUTE_KV_TTL });
  return fresh;
}

function grid3(n) {
  // ~110m cells: close enough to dedupe map pans, coarse enough to hit often.
  return Number(n).toFixed(3);
}

async function cachedNearby(env, lat, lon, radius) {
  const key = `nearby:${CACHE_VERSION}:${grid3(lon)}:${grid3(lat)}:${radius}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getNearbyStops(env, { lat, lon, radius });
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: NEARBY_KV_TTL });
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

    const isWrite = method === "POST" || method === "PATCH" || method === "DELETE";
    if (isWrite && !hasAppKey(request, env)) {
      return json({ error: "unauthorized" }, env, 401);
    }

    try {
      if (pathname === "/arrivals" && method === "GET") {
        const stop = url.searchParams.get("stop");
        if (!stop) return json({ error: "missing stop parameter" }, env, 400);
        // One cached payload holds every arrival EMT sent; `limit` only trims
        // what this caller gets, so the sheet and the cards share one fetch.
        const limit = Math.min(
          MAX_ARRIVALS,
          Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_ARRIVALS)
        );
        const payload = await cachedArrivals(env, stop);
        return json({ ...payload, arrivals: payload.arrivals.slice(0, limit) }, env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env), env);
      }

      const detail = pathname.match(/^\/stops\/([^/]+)\/detail$/);
      if (detail && method === "GET") {
        return json(await cachedStopDetail(env, decodeURIComponent(detail[1])), env);
      }

      if (pathname === "/stops/nearby" && method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        // searchParams.get returns null, and Number(null) is 0 — hence the
        // explicit has() checks; Madrid is not at 0,0.
        if (!url.searchParams.has("lat") || !url.searchParams.has("lon") ||
            !Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: "missing lat or lon parameter" }, env, 400);
        }
        const radius = Math.min(1000, Math.max(50, Number(url.searchParams.get("radius")) || 500));
        return json(await cachedNearby(env, lat, lon, radius), env);
      }

      const route = pathname.match(/^\/lines\/([^/]+)\/route$/);
      if (route && method === "GET") {
        const line = decodeURIComponent(route[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedRoute(env, line), env);
      }

      const timetable = pathname.match(/^\/lines\/([^/]+)\/timetable$/);
      if (timetable && method === "GET") {
        const line = decodeURIComponent(timetable[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedTimetable(env, line), env);
      }

      if (pathname === "/stops" && method === "POST") {
        const { stopId, label = null } = await request.json();
        return json(await addStop(env, { stopId, label }), env, 201);
      }

      const rename = pathname.match(/^\/stops\/([^/]+)$/);
      if (rename && method === "PATCH") {
        const { label = null } = await request.json();
        return json(await renameStop(env, decodeURIComponent(rename[1]), label), env);
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
