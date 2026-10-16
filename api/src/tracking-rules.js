// Pure transitions: never consume an alert until its push has been accepted.
export const BUS_INTERVAL = 120_000;
export const BIKE_INTERVAL = 30_000;
// A rack arms below 6 bikes and from then on alerts on every change, a bike
// docked or taken, so the phone always shows what is there now. The change
// that takes it above 6 alerts once more and disarms it; dropping below 6
// again re-arms it. Exactly 6 keeps whichever state it had.
export const BIKE_ARM_BELOW = 6;
export const BIKE_DISARM_ABOVE = 6;

export function bikeTransition(previous = {}, station) {
  if (!station || !station.inService || !station.renting ||
      !Number.isInteger(station.bikes) || station.bikes < 0) return { state: previous, alerts: [] };
  const count = station.bikes;
  const armed = count < BIKE_ARM_BELOW ? true : count > BIKE_DISARM_ABOVE ? false : previous.armed === true;
  const change = previous.count == null ? 0 : count - previous.count;
  const notify = change !== 0 && (armed || previous.armed === true);
  return {
    state: { armed, count },
    // The body is also the delivery key: one change, one alert.
    alerts: notify ? [{ bikes: count, change, paused: !armed, body: `${previous.count}→${count}` }] : [],
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
    // Leads with what is there now; then what just happened.
    const available = alert.bikes === 0 ? "No bikes available" : `${alert.bikes} ${alert.bikes === 1 ? "bike" : "bikes"} available`;
    const moved = Math.abs(alert.change ?? 0);
    const event = alert.paused ? "alerts paused above 6" : moved ? `${moved} ${alert.change > 0 ? "docked" : "taken"}` : "";
    return {
      title: watch.label || `Station ${watch.targetId}`,
      body: [available, event, watch.label ? place : ""].filter(Boolean).join(" · "),
    };
  }
  const destination = displayCase(alert.destination || watch.destination);
  return {
    title: destination ? `${watch.line} → ${destination}` : `Line ${watch.line}`,
    body: `${alert.minutes <= 0 ? "Due now" : `In ${alert.minutes} min`} · ${where}`,
  };
}
