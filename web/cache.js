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
