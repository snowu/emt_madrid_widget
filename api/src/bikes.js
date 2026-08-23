import { EmtError } from "./errors.js";
import { getToken, emtFetch } from "./emt.js";

const BASE = "https://openapi.emtmadrid.es/";

/** One BiciMAD station, trimmed to what the page draws.
 *
 * EMT's raw record carries a dozen fields the page has no use for
 * (virtualDelete, geofenced_capacity, an always-empty image). 680 stations of
 * them is 318KB; this is about a fifth of that.
 */
function parseStation(raw) {
  return {
    id: String(raw.id),
    // `number` is what is painted on the station; `id` is EMT's key. They
    // differ (station 1409 is signed "5"), and both are worth keeping.
    number: String(raw.number ?? raw.id),
    name: raw.name ?? null,
    address: raw.address ?? null,
    // GeoJSON order: [lon, lat], as everywhere else in this API.
    coordinates: raw.geometry?.coordinates ?? null,
    bikes: Number(raw.dock_bikes ?? 0),
    freeBases: Number(raw.free_bases ?? 0),
    totalBases: Number(raw.total_bases ?? 0),
    reserved: Number(raw.reservations_count ?? 0),
    // 0 green, 1 amber, 2 red, 3 black — EMT's own occupancy signal.
    light: Number(raw.light ?? 0),
    // no_available is EMT's "out of service" flag, inverted here so the page
    // reads it the way it renders it.
    inService: Number(raw.no_available ?? 0) === 0 && raw.virtualDelete !== true,
    overflow: raw.overflow === true,
  };
}

async function requestStations(env, token) {
  // emtFetch, not fetch: Cloudflare's edge intermittently 5xxs on its own TLS
  // handshake to EMT, and a single retry gets through.
  const res = await emtFetch(`${BASE}v2/transport/bicimad/stations/`, {
    method: "GET",
    headers: { accessToken: token },
  });
  if (!res.ok) throw new EmtError("upstream", `BiciMAD stations HTTP ${res.status}`);
  return res.json();
}

/** Every BiciMAD station, with live counts.
 *
 * All 680 arrive in one answer, so there is no reason to ask EMT per area —
 * the worker caches this once and slices it for whatever the page asks about.
 */
export async function getBikeStations(env) {
  let token = await getToken(env);
  let body = await requestStations(env, token);

  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestStations(env, token);
  }
  if (body.code !== "00") {
    throw new EmtError("upstream", `unexpected BiciMAD code ${body.code}`);
  }

  return {
    stations: (body.data ?? []).filter((s) => s?.id != null).map(parseStation),
    fetchedAt: Date.now(),
  };
}

function metresBetween([lon1, lat1], [lon2, lat2]) {
  // Equirectangular approximation: over a few kilometres in Madrid the error
  // is centimetres, and it costs a fraction of what haversine does per station.
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const y = lat2 - lat1;
  return Math.sqrt(x * x + y * y) * 111_320;
}

/** Stations within `radius` metres of a point, nearest first. */
export function stationsNear(stations, { lat, lon, radius = 700, limit = 40 }) {
  return stations
    .filter((s) => Array.isArray(s.coordinates))
    .map((s) => ({ ...s, metres: Math.round(metresBetween([lon, lat], s.coordinates)) }))
    .filter((s) => s.metres <= radius)
    .sort((a, b) => a.metres - b.metres)
    .slice(0, limit);
}
