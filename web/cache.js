const ARRIVALS_KEY = "emt:arrivals";
const STOPS_KEY = "emt:stops";

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
