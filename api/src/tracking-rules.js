// Pure transitions: never consume an alert until its push has been accepted.
export const BUS_INTERVAL = 120_000;
export const BIKE_INTERVAL = 30_000;
// A rack arms below 6 bikes and alerts on every bike docked until it holds
// more than 6; dropping below 6 again re-arms it. Exactly 6 keeps whichever
// state it had. Requiring exactly zero kept busy racks silent all night.
export const BIKE_ARM_BELOW = 6;
export const BIKE_DISARM_ABOVE = 6;

export function bikeTransition(previous = {}, station) {
  if (!station || !station.inService || !station.renting ||
      !Number.isInteger(station.bikes) || station.bikes < 0) return { state: previous, alerts: [] };
  const count = station.bikes;
  const armed = count < BIKE_ARM_BELOW ? true : count > BIKE_DISARM_ABOVE ? false : previous.armed === true;
  const notify = armed && count > 0 && previous.count != null && count > previous.count;
  return {
    state: { armed, count },
    alerts: notify ? [{
      bikes: count,
      body: `${count} ${count === 1 ? "bike is" : "bikes are"} now available.`,
    }] : [],
  };
}

export function busTransition(previous = {}, arrivals, watch, now) {
  const seen = { ...previous.seen };
  // Keep vehicles through temporary board omissions and ETA corrections, but
  // allow the same vehicle to trigger again on a later circuit.
  for (const [key, time] of Object.entries(seen)) if (now - time > 30 * 60_000) delete seen[key];
  // Every refresh of a time is a storage write, so a sighting is refreshed
  // at most every five minutes; the 30-minute expiry absorbs the slack.
  const eligible = arrivals.filter((bus) => String(bus.line).toUpperCase() === watch.line &&
    (!watch.destination || bus.destination === watch.destination) &&
    Number.isFinite(bus.seconds) && bus.seconds >= 0 && bus.seconds <= 900);
  const alerts = [];
  for (const bus of eligible) {
    const key = bus.vehicleId ? `${bus.vehicleId}:${bus.destination ?? ""}` : `unknown:${bus.destination ?? ""}`;
    if (!seen[key]) {
      const route = `${watch.line}${bus.destination ? ` → ${bus.destination}` : ""}`;
      const minutes = Math.ceil(bus.seconds / 60);
      alerts.push({ minutes, destination: bus.destination ?? "", body: `Line ${route}: ${minutes} min away.`, vehicle: key });
    }
    if (!seen[key] || now - seen[key] >= 5 * 60_000) seen[key] = now;
  }
  return { state: { seen }, alerts };
}

/** EMT signs destinations in capitals ("PLAZA CASTILLA"); a notification
 *  reads them faster in ordinary case. */
export function displayCase(text) {
  return String(text ?? "").toLowerCase().replace(/(^|[\s\-/(.])(\p{L})/gu, (_, gap, letter) => gap + letter.toUpperCase());
}

/** What the phone shows. Android gives the title one bold line and the body
 *  one more before truncating, so the title names the bus or station and the
 *  body leads with the news: minutes for a bus, the count for bikes. */
export function notificationText(watch, alert) {
  const place = watch.kind === "bike" ? `station ${watch.targetId}` : `stop ${watch.targetId}`;
  const where = watch.label ? `${watch.label} · ${place}` : place.charAt(0).toUpperCase() + place.slice(1);
  if (watch.kind === "bike") {
    return {
      title: watch.label || `Station ${watch.targetId}`,
      body: `${alert.bikes} ${alert.bikes === 1 ? "bike" : "bikes"} available now${watch.label ? ` · ${place}` : ""}`,
    };
  }
  const destination = displayCase(alert.destination || watch.destination);
  return {
    title: destination ? `${watch.line} → ${destination}` : `Line ${watch.line}`,
    body: `${alert.minutes <= 0 ? "Due now" : `In ${alert.minutes} min`} · ${where}`,
  };
}
