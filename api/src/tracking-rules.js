// Pure transitions: never consume an alert until its push has been accepted.
export const BUS_INTERVAL = 120_000;
export const BIKE_INTERVAL = 30_000;

export function bikeTransition(previous = {}, station) {
  if (!station || !station.inService || !station.renting ||
      !Number.isInteger(station.bikes) || station.bikes < 0) return { state: previous, alerts: [] };
  const count = station.bikes;
  const armed = count === 0 ? true : count > 4 ? false : previous.armed === true;
  const notify = armed && count > 0 && previous.count != null && count > previous.count;
  return {
    state: { armed, count },
    alerts: notify ? [{ body: `${count} ${count === 1 ? "bike is" : "bikes are"} now available.` }] : [],
  };
}

export function busTransition(previous = {}, arrivals, watch, now) {
  const seen = { ...previous.seen };
  // Keep vehicles through temporary board omissions and ETA corrections, but
  // allow the same vehicle to trigger again on a later circuit.
  for (const [key, time] of Object.entries(seen)) if (now - time > 30 * 60_000) delete seen[key];
  const eligible = arrivals.filter((bus) => String(bus.line).toUpperCase() === watch.line &&
    (!watch.destination || bus.destination === watch.destination) &&
    Number.isFinite(bus.seconds) && bus.seconds >= 0 && bus.seconds <= 900);
  const alerts = [];
  for (const bus of eligible) {
    const key = bus.vehicleId ? `${bus.vehicleId}:${bus.destination ?? ""}` : `unknown:${bus.destination ?? ""}`;
    if (!seen[key]) alerts.push({ body: `Line ${watch.line}${bus.destination ? ` → ${bus.destination}` : ""}: ${Math.ceil(bus.seconds / 60)} min away.`, vehicle: key });
    seen[key] = now;
  }
  return { state: { seen }, alerts };
}
