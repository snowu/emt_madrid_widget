import {
  getArrivals,
  getStopDetail,
  getNearbyStops,
  getLineTimetable,
  getLineRoute,
} from "./emt.js";
import {
  listStops,
  addStop,
  renameStop,
  removeStop,
  listBikeStations,
  addBikeStation,
  renameBikeStation,
  removeBikeStation,
  listBikeRatings,
  rateBike,
} from "./stops.js";
import {
  getBikeStations,
  getBikeStationInfo,
  getBikeStationStatus,
  mergeBikeStations,
  stationsNear,
} from "./bikes.js";
import { EmtError, errorResponse } from "./errors.js";
import { getBikeAccountStatus, getBikeTrips } from "./bicimad-account.js";
import { authenticatedUser, bearerToken } from "./auth.js";

// Short-lived, high-traffic data belongs in the Cache API, not KV. Cache API
// operations do not consume the Workers KV daily operation allowance.
const ARRIVALS_CACHE_TTL = 20;
// Bump when a cached payload's *shape* changes: old entries would otherwise
// keep serving the old shape until their TTL runs out (a week, for detail).
const CACHE_VERSION = "v4";
// Stop names/locations never move. A week of cache is quota-free.
const DETAIL_CACHE_TTL = 7 * 24 * 3600;
// Nearby searches are keyed on a ~110m grid so panning the map reuses cells.
const NEARBY_CACHE_TTL = 24 * 3600;
// A line's timetable changes with the season, not with the hour.
const TIMETABLE_CACHE_TTL = 24 * 3600;
// Route geometry changes when EMT redraws a line — a week is generous.
const ROUTE_CACHE_TTL = 7 * 24 * 3600;
// One operator-feed read serves the whole city and every area for 45 seconds.
const BIKES_CACHE_TTL = 45;
// Names and positions only change when a station is built or moved.
const BIKE_INFO_CACHE_TTL = 24 * 3600;
// Cards want the next bus and the one after it; the stop sheet wants the board.
const DEFAULT_ARRIVALS = 2;
const MAX_ARRIVALS = 20;
const edgeLoads = new Map();

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function json(body, env, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env), ...extraHeaders },
  });
}

async function edgeCachedJson(requestUrl, key, ttl, load, ctx) {
  const cache = caches.default;
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = `/__edge_cache/${CACHE_VERSION}/${key}`;
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  // Cache API writes happen after the response. Without an in-flight map, two
  // requests landing on the same warm isolate during that gap both call EMT.
  // Share the loader promise; the map contains public data only.
  const loadKey = cacheKey.url;
  if (edgeLoads.has(loadKey)) return edgeLoads.get(loadKey);
  const operation = (async () => {
    const fresh = await load();
    const write = cache.put(
      cacheKey,
      new Response(JSON.stringify(fresh), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${ttl}`,
        },
      }),
    );
    // Cache population is not part of the response's critical path. Workers'
    // execution context keeps it alive after returning without adding latency.
    if (ctx?.waitUntil) ctx.waitUntil(write);
    else await write;
    return fresh;
  })();
  edgeLoads.set(loadKey, operation);
  try {
    return await operation;
  } finally {
    if (edgeLoads.get(loadKey) === operation) edgeLoads.delete(loadKey);
  }
}

async function cachedArrivals(requestUrl, env, stopId, ctx) {
  return edgeCachedJson(requestUrl, `arrivals/${encodeURIComponent(stopId)}`, ARRIVALS_CACHE_TTL,
    () => getArrivals(env, stopId), ctx);
}

async function cachedStopDetail(requestUrl, env, stopId, ctx) {
  return edgeCachedJson(requestUrl, `detail/${encodeURIComponent(stopId)}`, DETAIL_CACHE_TTL,
    () => getStopDetail(env, stopId), ctx);
}

async function cachedTimetable(requestUrl, env, line, ctx) {
  return edgeCachedJson(requestUrl, `timetable/${encodeURIComponent(line)}`, TIMETABLE_CACHE_TTL,
    () => getLineTimetable(env, line), ctx);
}

async function cachedRoute(requestUrl, env, line, ctx) {
  return edgeCachedJson(requestUrl, `route/${encodeURIComponent(line)}`, ROUTE_CACHE_TTL,
    () => getLineRoute(env, line), ctx);
}

async function cachedBikeInfo(requestUrl, ctx) {
  return edgeCachedJson(requestUrl, "bike-info", BIKE_INFO_CACHE_TTL,
    () => getBikeStationInfo(), ctx);
}

/** Live stations, preferring the operator's own feed.
 *
 * GBFS counts bikes you can actually rent; MobilityLabs counts bikes that are
 * docked, broken ones included. When GBFS is unreachable the older source is
 * still better than an empty map, so it stands in — flagged, so the page can
 * say the counts are the rougher kind.
 */
async function cachedBikeStations(requestUrl, env, ctx) {
  return edgeCachedJson(requestUrl, "bikes", BIKES_CACHE_TTL, async () => {
    try {
      const [info, status] = await Promise.all([cachedBikeInfo(requestUrl, ctx), getBikeStationStatus()]);
      return { ...mergeBikeStations(info, status), source: "gbfs" };
    } catch {
      return { ...(await getBikeStations(env)), source: "mobilitylabs" };
    }
  }, ctx);
}

function grid3(n) {
  // ~110m cells: close enough to dedupe map pans, coarse enough to hit often.
  return Number(n).toFixed(3);
}

async function cachedNearby(requestUrl, env, lat, lon, radius, ctx) {
  const key = `nearby/${grid3(lon)}/${grid3(lat)}/${radius}`;
  return edgeCachedJson(requestUrl, key, NEARBY_CACHE_TTL,
    () => getNearbyStops(env, { lat, lon, radius }), ctx);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    try {
      if (pathname === "/auth/config" && method === "GET") {
        return json(
          { url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY },
          env,
          200,
          { "cache-control": "public, max-age=86400" },
        );
      }

      if (pathname === "/auth/me" && method === "GET") {
        const user = await authenticatedUser(env, request);
        return json({ id: user.id, email: user.email ?? null, owner: user.id === env.OWNER_USER_ID }, env);
      }

      if (pathname === "/arrivals" && method === "GET") {
        const stop = url.searchParams.get("stop");
        if (!stop) return json({ error: "missing stop parameter" }, env, 400);
        // One cached payload holds every arrival EMT sent; `limit` only trims
        // what this caller gets, so the sheet and the cards share one fetch.
        const limit = Math.min(
          MAX_ARRIVALS,
          Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_ARRIVALS)
        );
        const payload = await cachedArrivals(request.url, env, stop, ctx);
        return json({ ...payload, arrivals: payload.arrivals.slice(0, limit) }, env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env, bearerToken(request)), env);
      }

      const detail = pathname.match(/^\/stops\/([^/]+)\/detail$/);
      if (detail && method === "GET") {
        return json(await cachedStopDetail(request.url, env, decodeURIComponent(detail[1]), ctx), env);
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
        return json(await cachedNearby(request.url, env, lat, lon, radius, ctx), env);
      }

      const route = pathname.match(/^\/lines\/([^/]+)\/route$/);
      if (route && method === "GET") {
        const line = decodeURIComponent(route[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedRoute(request.url, env, line, ctx), env);
      }

      const timetable = pathname.match(/^\/lines\/([^/]+)\/timetable$/);
      if (timetable && method === "GET") {
        const line = decodeURIComponent(timetable[1]);
        if (!/^[0-9A-Za-z]+$/.test(line)) {
          return json({ error: "not a valid line" }, env, 400);
        }
        return json(await cachedTimetable(request.url, env, line, ctx), env);
      }

      /* ---- BiciMAD ----------------------------------------------------- */

      if (pathname === "/bikes/account" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD account status is owner-only");
        }
        return json(await getBikeAccountStatus(env), env);
      }

      if (pathname === "/bikes/trips" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD trip history is owner-only");
        }
        const page = Math.min(1000, Math.max(0, Number.parseInt(url.searchParams.get("page") || "0", 10) || 0));
        const bikeNumber = url.searchParams.get("bike");
        if (bikeNumber && !/^\d+$/.test(bikeNumber)) {
          return json({ error: "not a valid bike number" }, env, 400);
        }
        return json(await getBikeTrips(env, { page, bikeNumber }), env);
      }

      if (pathname === "/bikes/ratings" && method === "GET") {
        const token = bearerToken(request);
        return json(await listBikeRatings(env, token), env);
      }

      const bikeRating = pathname.match(/^\/bikes\/ratings\/(\d+)$/);
      if (bikeRating && method === "PUT") {
        const token = bearerToken(request);
        const body = await request.json();
        return json(await rateBike(env, token, {
          bikeNumber: bikeRating[1],
          rating: body.rating,
        }), env);
      }

      if (pathname === "/bikes/stations" && method === "GET") {
        const all = await cachedBikeStations(request.url, env, ctx);
        const ids = url.searchParams.get("ids");
        if (!ids) return json(all, env);
        // A page only ever wants its favourites plus what is on screen.
        const wanted = new Set(ids.split(",").filter(Boolean));
        return json(
          { ...all, stations: all.stations.filter((s) => wanted.has(s.id)) },
          env
        );
      }

      if (pathname === "/bikes/nearby" && method === "GET") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!url.searchParams.has("lat") || !url.searchParams.has("lon") ||
            !Number.isFinite(lat) || !Number.isFinite(lon)) {
          return json({ error: "missing lat or lon parameter" }, env, 400);
        }
        const radius = Math.min(3000, Math.max(50, Number(url.searchParams.get("radius")) || 700));
        const all = await cachedBikeStations(request.url, env, ctx);
        const savedIds = new Set((url.searchParams.get("ids") || "").split(",").filter(Boolean));
        return json(
          {
            fetchedAt: all.fetchedAt,
            source: all.source,
            stations: stationsNear(all.stations, { lat, lon, radius }),
            savedStations: savedIds.size
              ? all.stations.filter((station) => savedIds.has(station.id))
              : [],
          },
          env
        );
      }

      if (pathname === "/bikes/saved" && method === "GET") {
        return json(await listBikeStations(env, bearerToken(request)), env);
      }

      if (pathname === "/bikes/saved" && method === "POST") {
        const { stationId, label = null } = await request.json();
        return json(await addBikeStation(env, bearerToken(request), { stationId, label }), env, 201);
      }

      const bikeRow = pathname.match(/^\/bikes\/saved\/([^/]+)$/);
      if (bikeRow && method === "PATCH") {
        const { label = null } = await request.json();
        return json(await renameBikeStation(env, bearerToken(request), decodeURIComponent(bikeRow[1]), label), env);
      }
      if (bikeRow && method === "DELETE") {
        await removeBikeStation(env, bearerToken(request), decodeURIComponent(bikeRow[1]));
        return new Response(null, { status: 204, headers: cors(env) });
      }

      if (pathname === "/stops" && method === "POST") {
        const { stopId, label = null } = await request.json();
        return json(await addStop(env, bearerToken(request), { stopId, label }), env, 201);
      }

      const rename = pathname.match(/^\/stops\/([^/]+)$/);
      if (rename && method === "PATCH") {
        const { label = null } = await request.json();
        return json(await renameStop(env, bearerToken(request), decodeURIComponent(rename[1]), label), env);
      }

      const del = pathname.match(/^\/stops\/([^/]+)$/);
      if (del && method === "DELETE") {
        await removeStop(env, bearerToken(request), del[1]);
        return new Response(null, { status: 204, headers: cors(env) });
      }

      return json({ error: "not found" }, env, 404);
    } catch (err) {
      if (err instanceof EmtError) return errorResponse(err, cors(env));
      return errorResponse(new EmtError("upstream", err.message), cors(env));
    }
  },
};
