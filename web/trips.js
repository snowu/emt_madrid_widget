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
