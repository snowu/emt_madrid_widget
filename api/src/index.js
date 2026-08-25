import {
  getArrivals,
  getStopDetail,
  getNearbyStops,
  getLineIncidents,
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
  listPlaces,
  addPlace,
  updatePlace,
  removePlace,
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
import { getBikeTripDiagnostics, monitorBikeTrips } from "./trip-monitor.js";
import { queryMetrics, recordEdgeMetric } from "./metrics.js";
import {
  boardHasLine,
  deduplicateJourneyOptions,
  estimateJourneySeconds,
  linesMatch,
  nearbyAccess,
  planJourney,
  prioritizeAccessStops,
  stopsWithLiveLines,
  uniqueLineCodes,
} from "./journey-planner.js";

// Short-lived, high-traffic data belongs in the Cache API, not KV. Cache API
// operations do not consume the Workers KV daily operation allowance.
const ARRIVALS_CACHE_TTL = 8;
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
const INCIDENT_CACHE_TTL = 120;
const GEOCODE_CACHE_TTL = 30 * 24 * 3600;
const WALKING_CACHE_TTL = 7 * 24 * 3600;
// One operator-feed read serves the whole city and every area for 45 seconds.
const BIKES_CACHE_TTL = 45;
// Names and positions only change when a station is built or moved.
const BIKE_INFO_CACHE_TTL = 24 * 3600;
const JOURNEY_ORIGIN_STOP_LIMIT = 8;
const JOURNEY_INCIDENT_LINE_LIMIT = 4;
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

function metricCaller(requestUrl) {
  const pathname = new URL(requestUrl).pathname;
  if (pathname === "/journeys") return "journey";
  if (pathname === "/arrivals") return "arrivals";
  if (pathname.includes("nearby")) return "nearby";
  return "direct";
}

async function edgeCachedJson(requestUrl, key, ttl, load, ctx, env, endpoint = "") {
  const started = Date.now();
  const target = key.includes("/") ? key.slice(key.indexOf("/") + 1) : "";
  const metric = (cache, outcome = "ok", error = "") => recordEdgeMetric(env, {
    endpoint, cache, target, outcome, error, caller: metricCaller(requestUrl),
    duration: Date.now() - started,
  });
  const cache = caches.default;
  const cacheUrl = new URL(requestUrl);
  cacheUrl.pathname = `/__edge_cache/${CACHE_VERSION}/${key}`;
  cacheUrl.search = "";
  const cacheKey = new Request(cacheUrl.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    metric("hit");
    return hit.json();
  }

  // Cache API writes happen after the response. Without an in-flight map, two
  // requests landing on the same warm isolate during that gap both call EMT.
  // Share the loader promise; the map contains public data only.
  const loadKey = cacheKey.url;
  if (edgeLoads.has(loadKey)) {
    metric("coalesced");
    return edgeLoads.get(loadKey);
  }
  const operation = (async () => {
    let fresh;
    try {
      fresh = await load();
      metric("miss");
    } catch (error) {
      metric("miss", "error", error.kind ?? error.name ?? "error");
      throw error;
    }
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
    () => getArrivals(env, stopId), ctx, env, "arrivals");
}

async function cachedStopDetail(requestUrl, env, stopId, ctx) {
  return edgeCachedJson(requestUrl, `detail-v2/${encodeURIComponent(stopId)}`, DETAIL_CACHE_TTL,
    () => getStopDetail(env, stopId), ctx, env, "detail");
}

async function cachedTimetable(requestUrl, env, line, ctx) {
  return edgeCachedJson(requestUrl, `timetable/${encodeURIComponent(line)}`, TIMETABLE_CACHE_TTL,
    () => getLineTimetable(env, line), ctx, env, "timetable");
}

async function cachedRoute(requestUrl, env, line, ctx) {
  return edgeCachedJson(requestUrl, `route/${encodeURIComponent(line)}`, ROUTE_CACHE_TTL,
    () => getLineRoute(env, line), ctx, env, "route");
}

async function cachedIncidents(requestUrl, env, line, ctx) {
  return edgeCachedJson(requestUrl, `incidents/${encodeURIComponent(line)}`, INCIDENT_CACHE_TTL,
    () => getLineIncidents(env, line), ctx, env, "incidents");
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
  const key = `nearby-v2/${grid3(lon)}/${grid3(lat)}/${radius}`;
  return edgeCachedJson(requestUrl, key, NEARBY_CACHE_TTL,
    () => getNearbyStops(env, { lat, lon, radius }), ctx, env, "nearby");
}

async function geocodeMadrid(requestUrl, query, ctx) {
  const normalized = String(query ?? "").trim().replace(/\s+/g, " ");
  if (normalized.length < 3 || normalized.length > 120) {
    throw new EmtError("not_found", "address query must be 3–120 characters");
  }
  return edgeCachedJson(requestUrl, `geocode/${encodeURIComponent(normalized.toLocaleLowerCase("es"))}`,
    GEOCODE_CACHE_TTL, async () => {
      const target = new URL("https://nominatim.openstreetmap.org/search");
      target.search = new URLSearchParams({
        q: `${normalized}, Madrid`, format: "jsonv2", addressdetails: "1",
        countrycodes: "es", bounded: "1", viewbox: "-3.888,40.643,-3.517,40.312", limit: "6",
      }).toString();
      const response = await fetch(target, {
        headers: {
          "user-agent": "emt-madrid-widget/1.0 (https://snowu.github.io/emt_madrid_widget/)",
          referer: "https://snowu.github.io/emt_madrid_widget/",
          accept: "application/json",
        },
      });
      if (!response.ok) throw new EmtError("upstream", `address search HTTP ${response.status}`);
      const rows = await response.json();
      return rows.map((row) => ({
        displayName: String(row.display_name ?? ""),
        lat: Number(row.lat), lon: Number(row.lon), type: row.type ?? null,
      })).filter((row) => row.displayName && Number.isFinite(row.lat) && Number.isFinite(row.lon));
    }, ctx);
}

function madridPoint(value) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < 40.25 || lat > 40.65 || lon < -3.95 || lon > -3.45) {
    throw new EmtError("not_found", "invalid Madrid coordinate");
  }
  return { lat, lon };
}

async function walkingMatrix(requestUrl, body, ctx) {
  const origin = madridPoint(body?.origin);
  if (!Array.isArray(body?.destinations) || body.destinations.length < 1 || body.destinations.length > 25) {
    throw new EmtError("not_found", "destinations must contain 1–25 coordinates");
  }
  const destinations = body.destinations.map(madridPoint);
  const rounded = [origin, ...destinations]
    .map(({ lon, lat }) => `${lon.toFixed(5)},${lat.toFixed(5)}`);
  return edgeCachedJson(requestUrl, `walking/${rounded.join(";")}`, WALKING_CACHE_TTL, async () => {
    const target = `https://routing.openstreetmap.de/routed-foot/table/v1/driving/${rounded.join(";")}` +
      "?sources=0&annotations=distance,duration";
    const response = await fetch(target, {
      headers: {
        "user-agent": "emt-madrid-widget/1.0 (https://snowu.github.io/emt_madrid_widget/)",
        accept: "application/json",
      },
    });
    if (!response.ok) throw new EmtError("upstream", `walking routes HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.code !== "Ok" || !Array.isArray(payload.distances?.[0])) {
      throw new EmtError("upstream", "walking routes returned no matrix");
    }
    return {
      routes: destinations.map((_point, index) => ({
        metres: payload.distances[0][index + 1] == null
          ? null : Math.round(payload.distances[0][index + 1]),
        seconds: payload.durations?.[0]?.[index + 1] == null
          ? null : Math.round(payload.durations[0][index + 1]),
      })),
      fetchedAt: Date.now(),
    };
  }, ctx);
}

function plannerLocation(value, name) {
  const lat = Number(value?.lat);
  const lon = Number(value?.lon);
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lon) || Math.abs(lon) > 180) {
    throw new EmtError("not_found", `invalid ${name} coordinates`);
  }
  return { lat, lon };
}

function prioritizedRouteCodes(originStops, destinationGroups, max = 20) {
  const origin = uniqueLineCodes(originStops);
  const destinations = destinationGroups.map(uniqueLineCodes);
  const common = destinations.flatMap((codes) => codes.filter((code) => origin.includes(code)));
  const ordered = [...new Set(common)];
  const queues = [origin, ...destinations].map((codes) => [...codes]);
  while (ordered.length < max && queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      const code = queue.shift();
      if (code && !ordered.includes(code)) ordered.push(code);
      if (ordered.length === max) break;
    }
  }
  return ordered;
}

async function journeys(request, body, env, ctx) {
  const origin = plannerLocation(body?.origin, "origin");
  if (!Array.isArray(body?.destinations) || body.destinations.length < 1 || body.destinations.length > 3) {
    throw new EmtError("not_found", "destinations must contain 1–3 places");
  }
  const destinations = body.destinations.map((destination, index) => ({
    id: String(destination.id ?? index),
    name: String(destination.name ?? "Destination").slice(0, 80),
    ...plannerLocation(destination, `destination ${index + 1}`),
    radius: Math.min(700, Math.max(200, Number(destination.destinationRadiusM) || 700)),
  }));
  const originRaw = await cachedNearby(request.url, env, origin.lat, origin.lon, 700, ctx);
  const originCandidates = nearbyAccess(originRaw, origin, 50);
  const destinationStops = await Promise.all(destinations.map(async (destination) =>
    nearbyAccess(await cachedNearby(request.url, env, destination.lat, destination.lon,
      destination.radius, ctx), destination, 6)));
  const originStops = prioritizeAccessStops(
    originCandidates,
    destinationStops,
    JOURNEY_ORIGIN_STOP_LIMIT,
  );
  let walkingRouted = false;
  try {
    const matrix = await walkingMatrix(request.url, {
      origin,
      destinations: originStops.map((stop) => ({
        lat: stop.coordinates?.[1], lon: stop.coordinates?.[0],
      })),
    }, ctx);
    for (const [index, stop] of originStops.entries()) {
      const route = matrix.routes[index];
      if (!Number.isFinite(route?.metres) || !Number.isFinite(route?.seconds)) continue;
      stop.walkMetres = route.metres;
      stop.walkSeconds = route.seconds;
      walkingRouted = true;
    }
  } catch {
    // Journey planning remains available if the public pedestrian router is
    // temporarily down. Without routed timing the UI deliberately stays neutral.
  }
  // Read all candidate boarding boards first. Individual EMT failures are
  // isolated: one bad stop must not hold or reject the entire journey.
  const liveStopIds = originStops.map((stop) => String(stop.stopId));
  const live = new Map(await Promise.all(liveStopIds.map(async (stopId) => {
    try {
      return [stopId, await cachedArrivals(request.url, env, stopId, ctx)];
    } catch {
      return [stopId, null];
    }
  })));
  const activeOriginStops = stopsWithLiveLines(originStops, live);

  // Active lines get the scarce route slots first; static lines remain loaded
  // for the fallback used when EMT supplied no live boards at all.
  const plannerOrigins = activeOriginStops.length ? activeOriginStops : originStops;
  const routeCodes = prioritizedRouteCodes(plannerOrigins, destinationStops, 10);
  const routeEntries = await Promise.all(routeCodes.map(async (code) =>
    [code, await cachedRoute(request.url, env, code, ctx)]));
  const routes = new Map(routeEntries);
  const planned = destinations.map((destination, index) => {
    const active = planJourney({
      originStops: activeOriginStops,
      destinationStops: destinationStops[index],
      routes,
    });
    return {
      destination,
      options: activeOriginStops.length ? active : planJourney({
        originStops,
        destinationStops: destinationStops[index],
        routes,
      }),
    };
  });
  for (const item of planned) {
    for (const option of item.options) {
      const board = live.get(String(option.originStop.stopId));
      const arrivals = board?.arrivals ?? [];
      const matching = arrivals.filter((arrival) => linesMatch(arrival, option.firstLeg));
      option.firstLeg.arrivals = matching.map(({ seconds }) => seconds);
      option.firstLeg.fetchedAt = board?.fetchedAt ?? null;
    }
  }

  let transferStopIds = [];
  if (activeOriginStops.length) {
    transferStopIds = [...new Set(planned.flatMap((item) => item.options
      .filter((option) => option.type === "one_transfer")
      .slice(0, 3)
      .map((option) => String(option.transfer.toStop.stopId))))].slice(0, 3);
    const transferLive = new Map(await Promise.all(transferStopIds.map(async (stopId) => {
      try {
        return [stopId, await cachedArrivals(request.url, env, stopId, ctx)];
      } catch {
        return [stopId, null];
      }
    })));
    for (const item of planned) {
      item.options = item.options.filter((option) => {
        if (option.type === "direct") return true;
        const board = transferLive.get(String(option.transfer.toStop.stopId));
        const matching = (board?.arrivals ?? []).filter((arrival) => linesMatch(arrival, option.secondLeg));
        option.secondLeg.arrivals = matching.map(({ seconds }) => seconds);
        return matching.length > 0;
      });
    }
  }
  const incidentCodes = [...new Set(planned.flatMap((item) => item.options.flatMap((option) =>
    [option.firstLeg?.line, option.secondLeg?.line].filter(Boolean))))]
    .slice(0, JOURNEY_INCIDENT_LINE_LIMIT);
  const incidentsByLine = new Map(await Promise.all(incidentCodes.map(async (code) => {
    try {
      return [code, (await cachedIncidents(request.url, env, code, ctx)).incidents ?? []];
    } catch {
      // Incident data improves ranking, but must never make live journeys fail.
      return [code, []];
    }
  })));
  for (const item of planned) {
    for (const option of item.options) {
      option.incidents = [...new Map([
        ...(incidentsByLine.get(option.firstLeg?.line) ?? []),
        ...(incidentsByLine.get(option.secondLeg?.line) ?? []),
      ].map((incident) => [incident.id, incident])).values()];
      option.estimatedSeconds = estimateJourneySeconds(option);
    }
    item.options.sort((a, b) => Number(a.incidents.length > 0) - Number(b.incidents.length > 0)
      || (a.estimatedSeconds ?? Number.POSITIVE_INFINITY)
        - (b.estimatedSeconds ?? Number.POSITIVE_INFINITY)
      || a.score - b.score);
    item.options = deduplicateJourneyOptions(item.options);
  }
  return {
    origin,
    destinations: planned,
    generatedAt: Date.now(),
    calls: {
      nearby: 1 + destinations.length,
      walking: walkingRouted ? 1 : 0,
      routes: routeCodes.length,
      arrivals: liveStopIds.length + transferStopIds.length,
      incidents: incidentCodes.length,
    },
  };
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
        return json({
          id: user.id,
          email: user.email ?? null,
          owner: user.id === env.OWNER_USER_ID,
          metricsAvailable: Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_ANALYTICS_TOKEN),
        }, env);
      }

      if (pathname === "/admin/metrics" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "metrics are owner-only");
        }
        const hours = Math.min(720, Math.max(1,
          Number.parseInt(url.searchParams.get("hours") || "24", 10) || 24));
        return json(await queryMetrics(env, hours), env, 200, { "cache-control": "no-store" });
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

      if (pathname === "/places" && method === "GET") {
        return json(await listPlaces(env, bearerToken(request)), env);
      }
      if (pathname === "/places" && method === "POST") {
        return json(await addPlace(env, bearerToken(request), await request.json()), env, 201);
      }
      if (pathname === "/places/geocode" && method === "GET") {
        await authenticatedUser(env, request);
        return json(await geocodeMadrid(request.url, url.searchParams.get("q"), ctx), env);
      }
      const place = pathname.match(/^\/places\/([^/]+)$/);
      if (place && method === "PATCH") {
        return json(await updatePlace(env, bearerToken(request), decodeURIComponent(place[1]),
          await request.json()), env);
      }
      if (place && method === "DELETE") {
        await removePlace(env, bearerToken(request), decodeURIComponent(place[1]));
        return new Response(null, { status: 204, headers: cors(env) });
      }

      if (pathname === "/journeys" && method === "POST") {
        await authenticatedUser(env, request);
        return json(await journeys(request, await request.json(), env, ctx), env);
      }

      if (pathname === "/walking-distances" && method === "POST") {
        await authenticatedUser(env, request);
        return json(await walkingMatrix(request.url, await request.json(), ctx), env);
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
        const radius = Math.min(3000, Math.max(50, Number(url.searchParams.get("radius")) || 500));
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
        const refresh = url.searchParams.get("refresh") === "1";
        return json(await getBikeAccountStatus(env, { force: refresh }), env);
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

      if (pathname === "/bikes/trip-diagnostics" && method === "GET") {
        const user = await authenticatedUser(env, request);
        if (!env.OWNER_USER_ID || user.id !== env.OWNER_USER_ID) {
          throw new EmtError("forbidden", "BiciMAD trip diagnostics are owner-only");
        }
        return json(await getBikeTripDiagnostics(env), env);
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
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(monitorBikeTrips(env).catch((err) => {
      console.error(JSON.stringify({ event: "bicimad_trip_monitor_failed", message: err.message }));
      throw err;
    }));
  },
};
