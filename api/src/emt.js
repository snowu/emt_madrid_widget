import { EmtError } from "./errors.js";
import { emtEndpoint, recordUpstreamMetric } from "./metrics.js";

const BASE = "https://openapi.emtmadrid.es/";
const TOKEN_KEY = "emt:token";
let hotToken = null;
let hotTokenUntil = 0;
let tokenLoad = null;

export function clearTokenMemoryForTest() {
  hotToken = null;
  hotTokenUntil = 0;
  tokenLoad = null;
}

// EMT reports failure as a `code` inside a 200 response, not as an HTTP status.
const CODE_KIND = {
  "89": ["auth", "invalid EMT password"],
  "92": ["auth", "EMT user does not exist"],
  "98": ["quota", "EMT daily API quota exceeded"],
  "80": ["not_found", "stop not found or token invalid"],
  // Careful: EMT's detail table has holes for REAL stops (e.g. stop 30,
  // Plaza Castilla). Code 81 means "no detail record", not "stop does not
  // exist" — arrivals and arroundxy still know them.
  "81": ["not_found", "no such EMT record"],
};

function raiseForCode(code) {
  const known = CODE_KIND[String(code)];
  if (known) throw new EmtError(known[0], known[1]);
  throw new EmtError("upstream", `unexpected EMT code ${code}`);
}

/** fetch to EMT with one retry on a 5xx.
 *
 * Cloudflare's edge intermittently fails its own TLS handshake to
 * openapi.emtmadrid.es with an HTTP 5xx (525-class, workerd#776); a single
 * retry gets through. A 4xx is an answer, not a blip — pass it through.
 */
export async function emtFetch(url, init = {}, env = null) {
  const fetchWithDeadline = async () => {
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      recordUpstreamMetric(env, {
        endpoint: emtEndpoint(url),
        outcome: response.ok ? "ok" : "http_error",
        duration: Date.now() - started,
        status: response.status,
      });
      return response;
    } catch (error) {
      recordUpstreamMetric(env, {
        endpoint: emtEndpoint(url),
        outcome: error.name === "AbortError" ? "timeout" : "network_error",
        error: error.name ?? "error",
        duration: Date.now() - started,
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  let res;
  try {
    res = await fetchWithDeadline();
    if (res.status >= 500) {
      res = await fetchWithDeadline();
    }
  } catch (cause) {
    const reason = cause.name === "AbortError" ? "request timed out" : cause.message;
    throw new EmtError("upstream", `EMT unreachable: ${reason}`);
  }
  return res;
}

async function login(env) {
  const res = await emtFetch(`${BASE}v1/mobilitylabs/user/login/`, {
    method: "GET",
    headers: { email: env.EMT_EMAIL, password: env.EMT_PASSWORD },
  }, env);

  if (!res.ok) {
    throw new EmtError("upstream", `EMT login HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.code !== "01") raiseForCode(body.code);

  const entry = body.data?.[0];
  if (!entry?.accessToken) {
    throw new EmtError("upstream", "EMT login returned no accessToken");
  }
  return {
    token: entry.accessToken,
    // Expire ours a minute early so we never present a token mid-expiry.
    ttl: Math.max(60, Number(entry.tokenSecExpiration ?? 86400) - 60),
  };
}

/** Return a usable EMT access token, logging in only when needed. */
export async function getToken(env, { force = false } = {}) {
  if (!force && hotToken && Date.now() < hotTokenUntil) return hotToken;
  if (!force && tokenLoad) return tokenLoad;
  if (force) {
    hotToken = null;
    hotTokenUntil = 0;
  }
  const load = (async () => {
    if (!force) {
      const cached = await env.KV.get(TOKEN_KEY);
      if (cached) {
        hotToken = cached;
        // KV owns the real expiry; this short isolate-local window eliminates
        // bursts of repeated KV reads without trusting a token for too long.
        hotTokenUntil = Date.now() + 60_000;
        return cached;
      }
    }
    const { token, ttl } = await login(env);
    await env.KV.put(TOKEN_KEY, token, { expirationTtl: ttl });
    hotToken = token;
    hotTokenUntil = Date.now() + ttl * 1000;
    return token;
  })();
  if (!force) tokenLoad = load;
  try {
    return await load;
  } finally {
    if (tokenLoad === load) tokenLoad = null;
  }
}

async function requestArrivals(env, stopId, token) {
  const res = await emtFetch(`${BASE}v2/transport/busemtmad/stops/${stopId}/arrives/`, {
    method: "POST",
    headers: { accessToken: token, "content-type": "application/json" },
    body: JSON.stringify({
      stopId: String(stopId),
      Text_EstimationsRequired_YN: "Y",
    }),
  }, env);
  if (!res.ok) throw new EmtError("upstream", `EMT arrivals HTTP ${res.status}`);
  return res.json();
}

function parseArrivals(body) {
  // Arrivals live at data[0].Arrive[]. Capital D in DistanceBus is EMT's, not a typo.
  // Everything EMT sent is kept, sorted; the route layer decides how many to
  // serve — the cards want two, the stop sheet wants the whole board.
  const raw = body.data?.[0]?.Arrive ?? [];
  return raw
    .filter((a) => a.line != null && a.estimateArrive != null)
    .map((a) => ({
      line: String(a.line),
      seconds: Number(a.estimateArrive),
      metres: a.DistanceBus == null ? null : Number(a.DistanceBus),
      destination: a.destination ?? null,
      vehicleId: a.bus == null ? null : String(a.bus),
      ...(Number.isFinite(Number(a.bearing ?? a.heading))
        && (a.bearing ?? a.heading) != null
        ? { bearing: Number(a.bearing ?? a.heading) } : {}),
      coordinates: Array.isArray(a.geometry?.coordinates)
        ? a.geometry.coordinates.map(Number) : null,
    }))
    .sort((a, b) => a.seconds - b.seconds);
}

/** Fetch the next arrivals for one stop, re-logging in once if the token is stale. */
export async function getArrivals(env, stopId) {
  let token = await getToken(env);
  let body = await requestArrivals(env, stopId, token);

  // Code 80 is both "stop not found" and "invalid token" — indistinguishable
  // here, so retry once with a fresh token before believing the stop is bad.
  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestArrivals(env, stopId, token);
  }

  // Both are success: "00" carries estimations; "01" is
  // "No estimations found" with an empty Arrive[] (e.g. night hours).
  if (body.code !== "00" && body.code !== "01") raiseForCode(body.code);

  return { stopId: String(stopId), arrivals: parseArrivals(body), fetchedAt: Date.now() };
}

async function requestDetail(env, stopId, token) {
  // v2 answers identically to the documented v1 (verified live 2026-08-23,
  // stops 1547/28/29) — keeping every transport call on v2 means versioning
  // is one less thing to think about. Auth alone stays on v1.
  const res = await emtFetch(`${BASE}v2/transport/busemtmad/stops/${stopId}/detail/`, {
    method: "GET",
    headers: { accessToken: token },
  }, env);
  if (!res.ok) throw new EmtError("upstream", `EMT stop detail HTTP ${res.status}`);
  return res.json();
}

/** Normalise one line entry into the shape the page renders.
 *
 * EMT sends lines two different ways. Stop detail sends `dataLine[]`: one
 * entry per line for today's day type, carrying the human label ("5", never
 * "005"), the two route headers, and the hours that line actually runs — the
 * answer to "why is nothing due?" at 02:00. Area search sends bare codes with
 * none of that. The docs' `lines[]` on detail is not what v2 replies with.
 */
function lineEntry(l) {
  if (l && typeof l === "object") {
    const direction = String(l.direction ?? l.to ?? "").toUpperCase();
    return {
      line: String(l.line ?? l.label ?? ""),
      label: String(l.label ?? l.line ?? ""),
      from: l.startTime ?? null,
      to: l.stopTime ?? null,
      // EMT stamps the day type it is running today (LA weekday / SA / FE
      // holiday) — its own calendar, holidays included. Worth keeping: it is
      // the only way to pick the right row out of a line's timetable.
      dayType: l.dayType ?? null,
      headers: [l.headerA, l.headerB].filter(Boolean).map(String),
      ...(["A", "B"].includes(direction) ? { direction } : {}),
    };
  }
  // A bare code. The label is not derivable — night line 523 is signed N23 —
  // so show the code EMT gave rather than inventing a prettier one.
  const code = String(l ?? "");
  return { line: code, label: code, from: null, to: null, dayType: null, headers: [] };
}

function parseLines(raw) {
  const list = Array.isArray(raw.dataLine) ? raw.dataLine : raw.lines;
  return Array.isArray(list) ? list.map(lineEntry) : [];
}

function parseDetail(body) {
  const raw = body.data?.[0]?.stops?.[0];
  if (!raw) throw new EmtError("not_found", "EMT returned no stop detail");
  return {
    stopId: String(raw.stop),
    name: raw.name ?? null,
    address: raw.postalAddress ?? null,
    // GeoJSON order: [lon, lat]. Kept as-is; Leaflet wants [lat, lon].
    coordinates: raw.geometry?.coordinates ?? null,
    lines: parseLines(raw),
  };
}

/** Fetch one stop's static detail (name, address, location, lines). */
export async function getStopDetail(env, stopId) {
  let token = await getToken(env);
  let body = await requestDetail(env, stopId, token);

  // Same ambiguity as arrivals: 80 can mean a stale token.
  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestDetail(env, stopId, token);
  }

  if (body.code !== "00") raiseForCode(body.code);
  return parseDetail(body);
}

/** Parse EMT's "18/08/2026 7:00:00" into an instant.
 *
 * The date is a sample day, not a real one — but it is load-bearing: a night
 * line's service ends on the *following* date, which is the only thing that
 * distinguishes 23:40→05:45 from a 22-hour daytime span. */
function emtInstant(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  if (!m) return null;
  const [, d, mo, y, h, min] = m;
  return {
    at: Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(min)),
    clock: `${h.padStart(2, "0")}:${min}`,
  };
}

function sameDay(a, b) {
  return Math.floor(a / 86_400_000) === Math.floor(b / 86_400_000);
}

/** Widest window the line runs on one day type, across both directions. */
function serviceWindow(row) {
  const starts = [emtInstant(row.firstTimeServiceA), emtInstant(row.firstTimeServiceB)]
    .filter(Boolean);
  const ends = [emtInstant(row.endTimeServiceA), emtInstant(row.endTimeServiceB)]
    .filter(Boolean);
  if (starts.length === 0 || ends.length === 0) return { from: null, to: null, overnight: false };
  const start = starts.reduce((a, b) => (a.at <= b.at ? a : b));
  const end = ends.reduce((a, b) => (a.at >= b.at ? a : b));
  return {
    from: start.clock,
    to: end.clock,
    // Read off the dates, not the clocks. 23:40 → 05:45 crosses midnight, and
    // so does a Friday-night line running 04:40 → 06:15 the next morning —
    // clock order alone would call the second one a 95-minute window.
    overnight: !sameDay(start.at, end.at),
  };
}

/** When each line runs, per day type.
 *
 * The answer to an empty arrival board. Day types are LA (weekday), SA, FE
 * (Sunday/holiday) and V — Friday nights, which only night lines have. A line
 * with no row for today simply does not run today.
 */
export async function getLineTimetable(env, line) {
  let token = await getToken(env);
  let body = await requestTimetable(env, line, token);

  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestTimetable(env, line, token);
  }
  if (body.code !== "00") raiseForCode(body.code);

  return {
    line: String(line),
    days: (body.data ?? []).map((row) => ({
      dayType: row.dayType ?? null,
      ...serviceWindow(row),
      validFrom: row.dateIni ?? null,
      validTo: row.dateEnd ?? null,
    })),
  };
}

async function requestTimetable(env, line, token) {
  const res = await emtFetch(`${BASE}v2/transport/busemtmad/lines/${line}/timetable/`, {
    method: "GET",
    headers: { accessToken: token },
  }, env);
  if (!res.ok) throw new EmtError("upstream", `EMT line timetable HTTP ${res.status}`);
  return res.json();
}

async function requestRoute(env, line, token) {
  const res = await emtFetch(`${BASE}v2/transport/busemtmad/lines/${line}/route/`, {
    method: "GET",
    headers: { accessToken: token },
  }, env);
  if (!res.ok) throw new EmtError("upstream", `EMT line route HTTP ${res.status}`);
  return res.json();
}

// EMT sends 15 decimal places — nanometres. Six is ~10cm, which is finer than
// the map can draw, and cuts the payload roughly in half.
const COORD_PRECISION = 1e6;

function roundPair(pair) {
  return [
    Math.round(pair[0] * COORD_PRECISION) / COORD_PRECISION,
    Math.round(pair[1] * COORD_PRECISION) / COORD_PRECISION,
  ];
}

/** The drawn path of one direction, as segments of [lon, lat] pairs.
 *
 * EMT ships the itinerary as ~160 one-segment Features rather than a single
 * line, and they are not guaranteed to join end to end, so they stay separate
 * segments: Leaflet draws an array of them as one multi-polyline anyway.
 */
function parsePath(collection) {
  const segments = [];
  for (const feature of collection?.features ?? []) {
    const geom = feature.geometry;
    if (!geom) continue;
    const lists = geom.type === "MultiLineString" ? geom.coordinates : [geom.coordinates];
    for (const seg of lists ?? []) {
      if (Array.isArray(seg) && seg.length > 1) segments.push(seg.map(roundPair));
    }
  }
  return segments;
}

/** The stops the line calls at, in order, one direction.
 *
 * These ride along in the same route answer — showing them costs no extra
 * call. EMT names the id `stopNum` here and `stop` on detail; same number.
 */
function parseRouteStops(collection) {
  const stops = [];
  for (const feature of collection?.features ?? []) {
    const props = feature.properties ?? {};
    const point = feature.geometry?.coordinates;
    if (props.stopNum == null || !Array.isArray(point)) continue;
    stops.push({
      stopId: String(props.stopNum),
      name: props.stopName ?? null,
      coordinates: roundPair(point),
    });
  }
  return stops;
}

/** One bus line's route: both directions, drawable. */
export async function getLineRoute(env, line) {
  let token = await getToken(env);
  let body = await requestRoute(env, line, token);

  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestRoute(env, line, token);
  }
  if (body.code !== "00") raiseForCode(body.code);

  const raw = body.data;
  if (!raw?.itinerary) throw new EmtError("not_found", "EMT returned no route");
  return {
    line: String(raw.line ?? line),
    label: String(raw.label ?? raw.line ?? line),
    nameA: raw.nameSectionA ?? null,
    nameB: raw.nameSectionB ?? null,
    // GeoJSON order throughout this API: [lon, lat]. Leaflet wants them flipped.
    paths: {
      toA: parsePath(raw.itinerary.toA),
      toB: parsePath(raw.itinerary.toB),
    },
    stops: {
      toA: parseRouteStops(raw.stops?.toA),
      toB: parseRouteStops(raw.stops?.toB),
    },
  };
}

async function requestNearby(env, lat, lon, radius, token) {
  const res = await emtFetch(
    `${BASE}v2/transport/busemtmad/stops/arroundxy/${lon}/${lat}/${radius}/`,
    // v2 only: v1 answers "no records" for this family regardless of input.
    { method: "GET", headers: { accessToken: token } },
    env,
  );
  if (!res.ok) throw new EmtError("upstream", `EMT area search HTTP ${res.status}`);
  return res.json();
}

/** Stops within `radius` metres of a point. */
export async function getNearbyStops(env, { lat, lon, radius = 500 }) {
  const r = Math.min(3000, Math.max(50, Number(radius) || 500));
  let token = await getToken(env);
  let body = await requestNearby(env, lat, lon, r, token);

  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestNearby(env, lat, lon, r, token);
  }

  // Like arrivals, area search uses 01 for a valid empty result. This is
  // common for Hubs whose 700 m search area contains no EMT stops.
  if (body.code !== "00" && body.code !== "01") raiseForCode(body.code);

  return (body.data ?? [])
    .filter((s) => s.stopId != null)
    .map((s) => ({
      stopId: String(s.stopId),
      name: s.stopName ?? null,
      lines: Array.isArray(s.lines) ? s.lines.map(areaLine) : [],
      coordinates: Array.isArray(s.geometry?.coordinates)
        ? roundPair(s.geometry.coordinates) : null,
    }));
}

/** Area search's line record, carrying only what area search actually knows.
 *
 * `lineEntry` is shaped for stop detail, where the hours are real. Area search
 * has none of them, so every entry it produced carried
 * `"from":null,"to":null,"dayType":null,"headers":[]` — 130KB of nulls in a
 * 3km answer, against 102KB for everything the caller can use. The page caches
 * these by the thousand, so the padding is not free.
 */
function areaLine(l) {
  const entry = lineEntry(l);
  const compact = { line: entry.line, label: entry.label };
  if (entry.direction) compact.direction = entry.direction;
  return compact;
}

async function requestLineIncidents(env, line, token) {
  // This documented family exists only on v1; v2 responds with an HTML 404.
  const res = await emtFetch(
    `${BASE}v1/transport/busemtmad/lines/incidents/${encodeURIComponent(line)}/`,
    { method: "GET", headers: { accessToken: token } },
    env,
  );
  if (!res.ok) throw new EmtError("upstream", `EMT line incidents HTTP ${res.status}`);
  return res.json();
}

function incidentClock(value) {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/.exec(String(value ?? ""));
  if (!match) return null;
  const [, day, month, year, hour, minute] = match;
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}${hour.padStart(2, "0")}${minute}`);
}

function madridClock(now = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now).filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return Number(`${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`);
}

/** Currently active published diversions and service incidents for a line. */
export async function getLineIncidents(env, line) {
  let token = await getToken(env);
  let body = await requestLineIncidents(env, line, token);
  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestLineIncidents(env, line, token);
  }
  if (body.code !== "00" && body.code !== "01") raiseForCode(body.code);

  const now = madridClock();
  const raw = body.data?.flatMap((feed) => Array.isArray(feed.item)
    ? feed.item : feed.item ? [feed.item] : []) ?? [];
  return {
    line: String(line),
    incidents: raw.filter((item) => {
      const from = incidentClock(item.rssAfectaDesde);
      const to = incidentClock(item.rssAfectaHasta);
      return from != null && to != null && from <= now && now <= to;
    }).map((item) => ({
      id: String(item.guid ?? ""),
      title: item.title ?? null,
      cause: item.GoogleTransitCause ?? null,
      effect: item.GoogleTransitEffect ?? null,
      from: item.rssAfectaDesde ?? null,
      to: item.rssAfectaHasta ?? null,
      link: item.link ?? null,
    })),
  };
}
