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
const DETAIL_KV_TTL = 7 * 24 * 3600;
// Nearby searches are keyed on a ~110m grid so panning the map reuses cells.
const NEARBY_KV_TTL = 24 * 3600;
// A line's timetable changes with the season, not with the hour.
const TIMETABLE_KV_TTL = 24 * 3600;
// Route geometry changes when EMT redraws a line — a week is generous.
const ROUTE_KV_TTL = 7 * 24 * 3600;
// Bike counts move constantly. KV's floor is 60s, so that is the contract:
// one EMT call a minute serves every station and every area.
const BIKES_CACHE_TTL = 45;
// Names and positions only change when a station is built or moved.
const BIKE_INFO_KV_TTL = 24 * 3600;
// Cards want the next bus and the one after it; the stop sheet wants the board.
const DEFAULT_ARRIVALS = 2;
const MAX_ARRIVALS = 20;

function cors(env) {
  return {
    "access-control-allow-origin": env.ALLOWED_ORIGIN,
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
  };
}

function json(body, env, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...cors(env) },
  });
}

async function edgeCachedJson(requestUrl, key, ttl, load) {
  const cache = caches.default;
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = `/__edge_cache/${CACHE_VERSION}/${key}`;
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit.json();

  const fresh = await load();
  await cache.put(
    cacheKey,
    new Response(JSON.stringify(fresh), {
      headers: {
        "content-type": "application/json",
        "cache-control": `public, max-age=${ttl}`,
      },
    }),
  );
  return fresh;
}

async function cachedArrivals(requestUrl, env, stopId) {
  return edgeCachedJson(requestUrl, `arrivals/${encodeURIComponent(stopId)}`, ARRIVALS_CACHE_TTL,
    () => getArrivals(env, stopId));
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

async function cachedBikeInfo(env) {
  const key = `bikeinfo:${CACHE_VERSION}`;
  const hit = await env.KV.get(key, "json");
  if (hit) return hit;
  const fresh = await getBikeStationInfo();
  await env.KV.put(key, JSON.stringify(fresh), { expirationTtl: BIKE_INFO_KV_TTL });
  return fresh;
}

/** Live stations, preferring the operator's own feed.
 *
 * GBFS counts bikes you can actually rent; MobilityLabs counts bikes that are
 * docked, broken ones included. When GBFS is unreachable the older source is
 * still better than an empty map, so it stands in — flagged, so the page can
 * say the counts are the rougher kind.
 */
async function cachedBikeStations(requestUrl, env) {
  return edgeCachedJson(requestUrl, "bikes", BIKES_CACHE_TTL, async () => {
    try {
      const [info, status] = await Promise.all([cachedBikeInfo(env), getBikeStationStatus()]);
      return { ...mergeBikeStations(info, status), source: "gbfs" };
    } catch {
      return { ...(await getBikeStations(env)), source: "mobilitylabs" };
    }
  });
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

    try {
      if (pathname === "/auth/config" && method === "GET") {
        return json({ url: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY }, env);
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
        const payload = await cachedArrivals(request.url, env, stop);
        return json({ ...payload, arrivals: payload.arrivals.slice(0, limit) }, env);
      }

      if (pathname === "/stops" && method === "GET") {
        return json(await listStops(env, bearerToken(request)), env);
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

      if (pathname === "/bikes/stations" && method === "GET") {
        const all = await cachedBikeStations(request.url, env);
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
        const all = await cachedBikeStations(request.url, env);
        return json(
          {
            fetchedAt: all.fetchedAt,
            source: all.source,
            stations: stationsNear(all.stations, { lat, lon, radius }),
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
