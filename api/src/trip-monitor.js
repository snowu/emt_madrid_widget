import { getBikeTrips } from "./bicimad-account.js";

const MONITOR_KEY = "bicimad:trip-monitor:v1";
const RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_REVISIONS = 4;
const MATERIAL_FIELDS = [
  "startedAt", "endedAt", "minutes", "cost", "previousBalance", "resultingBalance",
  "dockBonus", "undockBonus", "reservationBonus", "penaltyCount", "penaltyAmount",
  "extraAmount", "extraDate", "lockFailed",
  "dockIncident", "incorrectDockBlock", "forcedClosed",
];

function identity(trip) {
  if (trip?.tripId != null) return `id:${trip.tripId}`;
  return `row:${trip?.bikeNumber ?? ""}:${trip?.interval ?? ""}:${trip?.minutes ?? ""}:${trip?.cost ?? ""}`;
}

function snapshot(trip) {
  return Object.fromEntries([
    ["tripId", trip?.tripId ?? null],
    ["bikeNumber", trip?.bikeNumber ?? null],
    ["interval", trip?.interval ?? null],
    ...MATERIAL_FIELDS.map((field) => [field, trip?.[field] ?? null]),
  ]);
}

function same(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function changes(previous, current) {
  return MATERIAL_FIELDS.flatMap((field) => same(previous?.[field], current?.[field])
    ? []
    : [{ field, from: previous?.[field] ?? null, to: current?.[field] ?? null }]);
}

export function nextTripMonitorState(previous = {}, trips, observedAt = Date.now()) {
  const cutoff = observedAt - RETENTION_MS;
  const diagnostics = Object.fromEntries(Object.entries(previous.diagnostics || {})
    .filter(([, entry]) => Number(entry?.lastChangedAt) > cutoff));
  const previousTrips = previous.trips || {};
  const currentTrips = Object.fromEntries(trips.map((trip) => [identity(trip), snapshot(trip)]));

  for (const [key, current] of Object.entries(currentTrips)) {
    const before = previousTrips[key];
    if (!before) continue;
    const delta = changes(before, current);
    if (!delta.length) continue;
    const revisions = [...(diagnostics[key]?.revisions || []), { observedAt, changes: delta }]
      .slice(-MAX_REVISIONS);
    diagnostics[key] = { lastChangedAt: observedAt, revisions };
  }

  return { trips: currentTrips, diagnostics, updatedAt: observedAt };
}

function stableState(state) {
  return JSON.stringify({ trips: state?.trips || {}, diagnostics: state?.diagnostics || {} });
}

/** Poll only the newest page. It contains every trip likely to reconcile
 * within 48 hours, while keeping each scheduled run to one EMTPay request. */
export async function monitorBikeTrips(env, { observedAt = Date.now() } = {}) {
  const [previous, payload] = await Promise.all([
    env.KV.get(MONITOR_KEY, "json"),
    getBikeTrips(env, { page: 0 }),
  ]);
  const next = nextTripMonitorState(previous || {}, payload.matchedOnPage, observedAt);
  if (!previous || stableState(previous) !== stableState(next)) {
    await env.KV.put(MONITOR_KEY, JSON.stringify(next));
    return { changed: true, monitoredTrips: payload.matchedOnPage.length };
  }
  return { changed: false, monitoredTrips: payload.matchedOnPage.length };
}

export async function getBikeTripDiagnostics(env, now = Date.now()) {
  const state = await env.KV.get(MONITOR_KEY, "json");
  if (!state) return { monitoring: true, initialized: false, diagnostics: {} };
  const cutoff = now - RETENTION_MS;
  const diagnostics = Object.fromEntries(Object.entries(state.diagnostics || {})
    .filter(([, entry]) => Number(entry?.lastChangedAt) > cutoff));
  return {
    monitoring: true,
    initialized: true,
    updatedAt: Number(state.updatedAt) || null,
    diagnostics,
  };
}

export const tripMonitorInternals = { MONITOR_KEY, RETENTION_MS };
