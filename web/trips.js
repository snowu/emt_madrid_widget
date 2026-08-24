/** Stable identity for deduplicating normalized EMTPay trip rows. */
export function tripIdentity(trip) {
  if (trip.tripId != null) return `id:${trip.tripId}`;
  return `row:${trip.bikeNumber ?? ""}:${trip.interval ?? ""}:${trip.minutes ?? ""}:${trip.cost ?? ""}`;
}

/** Infer pagination direction only when numeric trip ids provide evidence. */
export function tripsAreOldestFirst(trips) {
  const first = Number(trips[0]?.tripId);
  const last = Number(trips.at(-1)?.tripId);
  return trips.length > 1 && Number.isFinite(first) && Number.isFinite(last) && first < last;
}

/** Merge refreshed pages without changing the ordering direction.
 * Fresh copies replace matching cached rows in either direction. */
export function mergeTripHistory(existing, fetched, oldestFirst) {
  const merged = new Map();
  if (oldestFirst) {
    for (const trip of existing) merged.set(tripIdentity(trip), trip);
    for (const trip of fetched) merged.set(tripIdentity(trip), trip);
  } else {
    for (const trip of fetched) merged.set(tripIdentity(trip), trip);
    for (const trip of existing) {
      const key = tripIdentity(trip);
      if (!merged.has(key)) merged.set(key, trip);
    }
  }
  return [...merged.values()];
}

export const TRIP_DIAGNOSTIC_LABELS = Object.freeze({
  startedAt: "Start",
  endedAt: "End",
  minutes: "Duration",
  cost: "Cost",
  previousBalance: "Previous balance",
  resultingBalance: "Resulting balance",
  dockBonus: "Dock bonus",
  undockBonus: "Undock bonus",
  reservationBonus: "Reservation bonus",
  penaltyCount: "Penalty count",
  penaltyAmount: "Penalty amount",
  extraAmount: "Extra charge/credit",
  extraDate: "Extra charge date",
  lockFailed: "Lock failure",
  dockIncident: "Dock event",
  incorrectDockBlock: "Incorrect dock block",
  forcedClosed: "Forced closure",
});

const DIAGNOSTIC_FIELDS = Object.keys(TRIP_DIAGNOSTIC_LABELS);
export const TRIP_DIAGNOSTIC_RETENTION_MS = 48 * 60 * 60 * 1000;
const MAX_REVISIONS_PER_TRIP = 4;

function sameValue(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function changesKey(changes) {
  return JSON.stringify(changes || []);
}

export function mergeTripDiagnostics(local = {}, monitored = {}) {
  const merged = { ...local };
  for (const [key, remote] of Object.entries(monitored)) {
    const revisions = [...(local[key]?.revisions || []), ...(remote?.revisions || [])]
      .sort((left, right) => Number(left.observedAt) - Number(right.observedAt));
    const unique = new Map();
    for (const revision of revisions) unique.set(changesKey(revision.changes), revision);
    merged[key] = {
      lastChangedAt: Math.max(Number(local[key]?.lastChangedAt) || 0, Number(remote?.lastChangedAt) || 0),
      revisions: [...unique.values()].slice(-MAX_REVISIONS_PER_TRIP),
    };
  }
  return merged;
}

/** Store only material field deltas—not duplicate trips or raw EMT payloads. */
export function materialTripChanges(previous, current) {
  return DIAGNOSTIC_FIELDS.flatMap((field) => sameValue(previous?.[field], current?.[field])
    ? []
    : [{ field, from: previous?.[field] ?? null, to: current?.[field] ?? null }]);
}

/** Capture revisions seen during an ordinary refresh and discard diagnostics
 * after 48 hours without another change. The current trip remains elsewhere
 * in the normal cache; this object contains only its bounded change log. */
export function updateTripDiagnostics(existing, fetched, diagnostics = {}, observedAt = Date.now()) {
  const cutoff = observedAt - TRIP_DIAGNOSTIC_RETENTION_MS;
  const next = Object.fromEntries(Object.entries(diagnostics)
    .filter(([, entry]) => Number(entry?.lastChangedAt) > cutoff));
  const previousById = new Map(existing.map((trip) => [tripIdentity(trip), trip]));

  for (const trip of fetched) {
    const key = tripIdentity(trip);
    const previous = previousById.get(key);
    if (!previous) continue;
    const changes = materialTripChanges(previous, trip);
    if (!changes.length) continue;
    const retained = next[key]?.revisions || [];
    const duplicate = retained.some((revision) => changesKey(revision.changes) === changesKey(changes));
    const revisions = duplicate ? retained : [...retained, { observedAt, changes }]
      .slice(-MAX_REVISIONS_PER_TRIP);
    if (duplicate) continue;
    next[key] = { lastChangedAt: observedAt, revisions };
  }
  return next;
}
