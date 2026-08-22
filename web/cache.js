const ARRIVALS_KEY = "emt:arrivals";
const STOPS_KEY = "emt:stops";
const DETAILS_KEY = "emt:details";

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

/** Mirrors the stop list so a cold start with no network still renders. */
export function readStops() {
  return read(STOPS_KEY, []);
}

export function writeStops(stops) {
  localStorage.setItem(STOPS_KEY, JSON.stringify(stops));
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
