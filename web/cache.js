const ARRIVALS_KEY = "emt:arrivals";
const STOPS_KEY = "emt:stops";
const DETAILS_KEY = "emt:details";
let userScope = "signed-out";

export function setUserCacheScope(userId) {
  userScope = userId || "signed-out";
}

function userKey(key) {
  return `${key}:${userScope}`;
}

function read(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readCache() {
  return read(ARRIVALS_KEY, {});
}

export function writeCache(stopId, payload) {
  const all = readCache();
  all[stopId] = payload;
  localStorage.setItem(ARRIVALS_KEY, JSON.stringify(all));
}

export function writeArrivalCache(all) {
  localStorage.setItem(ARRIVALS_KEY, JSON.stringify(all));
}

/** Mirrors the stop list so a cold start with no network still renders. */
export function readStops() {
  return read(userKey(STOPS_KEY), []);
}

export function writeStops(stops) {
  localStorage.setItem(userKey(STOPS_KEY), JSON.stringify(stops));
}

/** Stop names/locations never move; a per-device cache of them is safe. */
export function readDetails() {
  return read(DETAILS_KEY, {});
}

export function writeDetail(stopId, detail) {
  const all = readDetails();
  all[stopId] = detail;
  localStorage.setItem(DETAILS_KEY, JSON.stringify(all));
}

const BIKE_SAVED_KEY = "emt:bikes:saved";
const BIKE_NEAR_KEY = "emt:bikes:near";
const BIKE_ACCOUNT_KEY = "emt:bikes:account";
// v6 repopulates histories after correctly treating EMTPay's timezone-less ISO
// timestamps as UTC instants rather than Madrid wall-clock values.
const BIKE_TRIPS_KEY = "emt:bikes:trips:v6";

/** Saved bike stations mirror the same rule as saved bus stops: the server
 *  owns them, this is only so a cold start renders something. */
export function readBikeSaved() {
  return read(userKey(BIKE_SAVED_KEY), []);
}

export function writeBikeSaved(rows) {
  localStorage.setItem(userKey(BIKE_SAVED_KEY), JSON.stringify(rows));
}

/** Last-known bike counts, so the list never opens empty. Counts move by the
 *  minute, so these are always rendered with their age. */
export function readBikeNear() {
  return read(BIKE_NEAR_KEY, { stations: [], fetchedAt: null });
}

export function writeBikeNear(payload) {
  localStorage.setItem(BIKE_NEAR_KEY, JSON.stringify(payload));
}

/** Private owner data is scoped to the signed-in Supabase user. */
export function readBikeAccount() {
  return read(userKey(BIKE_ACCOUNT_KEY), null);
}

export function writeBikeAccount(payload) {
  localStorage.setItem(userKey(BIKE_ACCOUNT_KEY), JSON.stringify(payload));
}

export function readBikeTrips() {
  return read(userKey(BIKE_TRIPS_KEY), null);
}

export function writeBikeTrips(payload) {
  localStorage.setItem(userKey(BIKE_TRIPS_KEY), JSON.stringify(payload));
}

/* ---- Nearby stop cells ------------------------------------------------ */

// One localStorage entry per grid cell rather than one blob for all of them:
// a pan writes the ~14KB cell it just fetched, not the whole cache.
const NEARBY_PREFIX = "emt:nearby:v1:";
// A dense central cell is ~124 stops at ~238 bytes each, so ~29KB. Forty of
// them is ~1.2MB against localStorage's ~5MB, which this shares with stop
// details, arrivals and trip history — and forty cells is already 150km².
const NEARBY_CELL_LIMIT = 40;

export function readNearbyCell(key) {
  return read(NEARBY_PREFIX + key, null);
}

/** Stops are public and do not move, so these are shared across users and
 *  kept for a day. Oldest cells go first once the cap is reached — panning
 *  across a city should not be able to fill the origin's storage. */
export function writeNearbyCell(key, cell) {
  try {
    localStorage.setItem(NEARBY_PREFIX + key, JSON.stringify(cell));
  } catch {
    // Storage full: drop everything cached and let it refill from the map.
    clearNearbyCells();
    return;
  }
  pruneNearbyCells();
}

function nearbyCellKeys() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith(NEARBY_PREFIX)) keys.push(key);
  }
  return keys;
}

function pruneNearbyCells() {
  const keys = nearbyCellKeys();
  if (keys.length <= NEARBY_CELL_LIMIT) return;
  const aged = keys
    .map((key) => ({ key, at: read(key, null)?.fetchedAt ?? 0 }))
    .sort((a, b) => a.at - b.at);
  for (const { key } of aged.slice(0, keys.length - NEARBY_CELL_LIMIT)) {
    localStorage.removeItem(key);
  }
}

export function clearNearbyCells() {
  for (const key of nearbyCellKeys()) localStorage.removeItem(key);
}
