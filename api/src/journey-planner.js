const EARTH_M = 6_371_000;
const WALK_METRES_PER_SECOND = 1.3;
const RIDE_SECONDS_PER_STOP = 90;
const DEFAULT_HEADWAY_SECONDS = 10 * 60;
const TRANSFER_BUFFER_SECONDS = 60;

export function distanceMetres(a, b) {
  const rad = Math.PI / 180;
  const p1 = Number(a.lat) * rad;
  const p2 = Number(b.lat) * rad;
  const dp = (Number(b.lat) - Number(a.lat)) * rad;
  const dl = (Number(b.lon) - Number(a.lon)) * rad;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.sqrt(h));
}

function point(stop) {
  return { lat: Number(stop.coordinates?.[1]), lon: Number(stop.coordinates?.[0]) };
}

function lineCode(entry) {
  return String(entry?.line ?? entry?.label ?? "").trim();
}

function lineIdentity(entry) {
  const code = lineCode(entry).toUpperCase();
  return /^\d+$/.test(code) ? code.replace(/^0+(?=\d)/, "") : code;
}

export function linesMatch(a, b) {
  const left = lineIdentity(a);
  return Boolean(left) && left === lineIdentity(b);
}

function nextDeparture(arrivals, readyAt) {
  const times = (arrivals ?? []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const live = times.find((seconds) => seconds >= readyAt);
  if (live != null) return live;
  if (times.length === 0) return null;
  const observed = times.length > 1 ? times.at(-1) - times.at(-2) : DEFAULT_HEADWAY_SECONDS;
  const headway = Math.min(30 * 60, Math.max(3 * 60, observed || DEFAULT_HEADWAY_SECONDS));
  return times.at(-1) + Math.ceil((readyAt - times.at(-1)) / headway) * headway;
}

/** Estimate seconds from the user's current position to the Hub. */
export function estimateJourneySeconds(option) {
  const originWalk = Number.isFinite(option.originStop?.walkSeconds)
    ? option.originStop.walkSeconds
    : Number(option.originStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  const firstDeparture = nextDeparture(option.firstLeg?.arrivals, originWalk);
  if (firstDeparture == null) return null;
  option.firstLeg.selectedArrival = Math.round(firstDeparture);
  const firstRide = Number(option.firstLeg?.stops ?? 0) * RIDE_SECONDS_PER_STOP;
  const destinationWalk = Number(option.destinationStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  if (option.type === "direct") return Math.round(firstDeparture + firstRide + destinationWalk);

  const transferWalk = Number(option.transfer?.walkM ?? 0) / WALK_METRES_PER_SECOND;
  const readyForSecond = firstDeparture + firstRide + transferWalk + TRANSFER_BUFFER_SECONDS;
  const secondDeparture = nextDeparture(option.secondLeg?.arrivals, readyForSecond);
  if (secondDeparture == null) return null;
  option.secondLeg.selectedArrival = Math.round(secondDeparture);
  const secondRide = Number(option.secondLeg?.stops ?? 0) * RIDE_SECONDS_PER_STOP;
  return Math.round(secondDeparture + secondRide + destinationWalk);
}

/** What the journey *feels* like, for ranking only — never shown as an ETA.
 *
 * Time on a bus and time on foot are not the same minute. Walking is the part
 * people avoid, in August especially, so it is weighted above riding: without
 * this, ranking on raw predicted arrival happily recommends a stop 300m
 * further away to save two minutes, which is not a trade anyone makes.
 *
 * `estimatedSeconds` stays the honest prediction and is what the card shows.
 */
const WALK_AVERSION = 1.6;

export function rankJourneySeconds(option) {
  if (option?.estimatedSeconds == null) return null;
  const originWalk = Number.isFinite(option.originStop?.walkSeconds)
    ? option.originStop.walkSeconds
    : Number(option.originStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND;
  const onFoot = originWalk
    + Number(option.destinationStop?.distanceM ?? 0) / WALK_METRES_PER_SECOND
    + Number(option.transfer?.walkM ?? 0) / WALK_METRES_PER_SECOND;
  return Math.round(option.estimatedSeconds + onFoot * (WALK_AVERSION - 1));
}

/** Order options the way the rider would choose between them.
 *
 * A direct ride outranks every transfer, whatever the clock says. A transfer
 * is a second fare — about €0.70 without a subscription — and getting off,
 * walking, and waiting again is worse than staying on a bus already going
 * where you are going, even when it arrives a few minutes sooner. No Madrid
 * ride is long enough for that to backfire badly: by day a leg is 15–20
 * minutes, and at night the wider search radius is what buys the choice.
 *
 * Incidents and timing order each group internally, so a disrupted direct
 * falls behind a clean direct — just never behind a transfer.
 */
export function compareJourneyOptions(a, b) {
  const transfer = (option) => Number(option.type !== "direct");
  const disrupted = (option) => Number((option.incidents?.length ?? 0) > 0);
  const untimed = (option) => Number(option.rankSeconds == null);
  return transfer(a) - transfer(b)
    || disrupted(a) - disrupted(b)
    || untimed(a) - untimed(b)
    || (a.rankSeconds ?? Number.POSITIVE_INFINITY)
      - (b.rankSeconds ?? Number.POSITIVE_INFINITY)
    || a.score - b.score;
}

/** Collapse candidates that represent the same journey as experienced by the user.
 * Different nearby destination stops can otherwise produce duplicate legs. */
export function deduplicateJourneyOptions(options) {
  const seen = new Set();
  return (options ?? []).filter((option) => {
    const signature = [
      option.type,
      lineIdentity(option.firstLeg),
      option.firstLeg?.direction,
      option.type === "one_transfer" ? lineIdentity(option.secondLeg) : "",
      option.type === "one_transfer" ? option.secondLeg?.direction : "",
    ].join("|");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function boardHasLine(board, line) {
  const wanted = lineIdentity(line);
  return Boolean(wanted) && (board?.arrivals ?? [])
    .some((arrival) => lineIdentity(arrival) === wanted);
}

export function stopsWithLiveLines(stops, boards) {
  return (stops ?? []).map((stop) => {
    const arrivals = boards.get(String(stop.stopId))?.arrivals ?? [];
    const listed = new Map();
    for (const line of stop.lines ?? []) {
      listed.set(lineIdentity(line), line);
      if (line?.label != null) listed.set(lineIdentity({ line: line.label }), line);
    }
    const live = new Map();
    for (const arrival of arrivals) {
      const code = lineCode(arrival);
      const identity = lineIdentity(arrival);
      if (!code || live.has(identity)) continue;
      live.set(identity, listed.get(identity) ?? { line: code, label: code });
    }
    return { ...stop, lines: [...live.values()] };
  }).filter((stop) => stop.lines.length > 0);
}

export function nearbyAccess(stops, location, maxStops = 6) {
  return (stops ?? [])
    .map((stop) => ({ ...stop, distanceM: Math.round(distanceMetres(location, point(stop))) }))
    .filter((stop) => Number.isFinite(stop.distanceM))
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, maxStops);
}

/** Keep scarce live-arrival calls useful in dense areas.
 *
 * A merely nearest-first slice can discard a direct line 450m away because six
 * unrelated stops happen to be closer. So slots are reserved for stops that
 * share a line with the destination — but **one per shared line**, not simply
 * the nearest two stops that share any of them.
 *
 * That distinction is the whole thing at night. A destination served by
 * 9, 29, 52, 73 and N2 will have several stops within 300m serving 9 and 73,
 * and they take every reserved slot; the one stop carrying N2 is 1.3km away
 * and never gets considered. At 01:00 the day lines are asleep and N2 is the
 * only line running, so the hub reports "No route" while a direct bus exists.
 *
 * Reserving per line costs nothing by day — it just means each line the
 * destination is served by gets one chance to be boarded.
 */
export function prioritizeAccessStops(candidates, destinationGroups, maxStops = 6) {
  const selected = [];
  const selectedIds = new Set();
  const add = (stop) => {
    const id = String(stop?.stopId ?? "");
    if (!id || selectedIds.has(id) || selected.length >= maxStops) return;
    selectedIds.add(id);
    selected.push(stop);
  };
  for (const destinations of destinationGroups ?? []) {
    const seen = new Set();
    for (const destinationLine of (destinations ?? []).flatMap((stop) => stop.lines ?? [])) {
      const identity = lineIdentity(destinationLine);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      // Two per line, not one: a line's two directions are different platforms,
      // often across the street from each other, and only one of them is going
      // your way. `candidates` arrives sorted by walking distance.
      (candidates ?? [])
        .filter((candidate) => (candidate.lines ?? [])
          .some((line) => linesMatch(line, destinationLine)))
        .slice(0, 2)
        .forEach(add);
    }
  }
  for (const candidate of candidates ?? []) add(candidate);
  return selected;
}

export function linesAt(stops) {
  const result = new Map();
  for (const stop of stops ?? []) {
    for (const entry of stop.lines ?? []) {
      const code = lineCode(entry);
      if (!code || result.has(`${stop.stopId}:${code}`)) continue;
      result.set(`${stop.stopId}:${code}`, {
        code,
        label: String(entry.label ?? code).trim(),
        stop,
      });
    }
  }
  return [...result.values()];
}

function directedSections(route, fromStopIds, toStopIds) {
  const sections = [];
  for (const direction of ["toA", "toB"]) {
    const stops = route?.stops?.[direction] ?? [];
    for (let from = 0; from < stops.length; from += 1) {
      if (!fromStopIds.has(String(stops[from].stopId))) continue;
      for (let to = from + 1; to < stops.length; to += 1) {
        if (toStopIds.has(String(stops[to].stopId))) {
          sections.push({ direction, stops, from, to });
          break;
        }
      }
    }
  }
  return sections;
}

function routeFor(routes, code) {
  return routes instanceof Map ? routes.get(code) : routes?.[code];
}

function bestDirect(originLines, destinationLines, routes) {
  const destinationByCode = new Map(destinationLines.map((item) => [lineIdentity(item), item]));
  const candidates = [];
  for (const origin of originLines) {
    const destination = destinationByCode.get(lineIdentity(origin));
    if (!destination) continue;
    const route = routeFor(routes, origin.code);
    const sections = directedSections(route,
      new Set([String(origin.stop.stopId)]), new Set([String(destination.stop.stopId)]));
    for (const section of sections) {
      candidates.push({
        type: "direct",
        score: origin.stop.distanceM + destination.stop.distanceM + (section.to - section.from) * 420,
        originStop: origin.stop,
        destinationStop: destination.stop,
        firstLeg: { line: origin.code, label: origin.label, direction: section.direction,
          stops: section.to - section.from },
      });
    }
  }
  return candidates;
}

function bestTransfers(originLines, destinationLines, routes, thresholdM) {
  const candidates = [];
  for (const first of originLines) {
    const firstRoute = routeFor(routes, first.code);
    if (!firstRoute) continue;
    for (const second of destinationLines) {
      if (linesMatch(first, second)) continue;
      const secondRoute = routeFor(routes, second.code);
      if (!secondRoute) continue;
      for (const firstDirection of ["toA", "toB"]) {
        const firstStops = firstRoute.stops?.[firstDirection] ?? [];
        const start = firstStops.findIndex((stop) => String(stop.stopId) === String(first.stop.stopId));
        if (start < 0) continue;
        for (const secondDirection of ["toA", "toB"]) {
          const secondStops = secondRoute.stops?.[secondDirection] ?? [];
          const end = secondStops.findIndex((stop) => String(stop.stopId) === String(second.stop.stopId));
          if (end <= 0) continue;
          let best = null;
          for (let i = start + 1; i < firstStops.length; i += 1) {
            for (let j = 0; j < end; j += 1) {
              const walk = distanceMetres(point(firstStops[i]), point(secondStops[j]));
              if (walk <= thresholdM && (!best || walk < best.walk)) best = { i, j, walk };
            }
          }
          if (!best) continue;
          candidates.push({
            type: "one_transfer",
            score: first.stop.distanceM + second.stop.distanceM + best.walk +
              (best.i - start + end - best.j) * 420 + 600,
            originStop: first.stop,
            destinationStop: second.stop,
            firstLeg: { line: first.code, label: first.label, direction: firstDirection,
              stops: best.i - start },
            transfer: {
              fromStop: firstStops[best.i], toStop: secondStops[best.j], walkM: Math.round(best.walk),
            },
            secondLeg: { line: second.code, label: second.label, direction: secondDirection,
              stops: end - best.j },
          });
        }
      }
    }
  }
  return candidates;
}

export function planJourney({ originStops, destinationStops, routes, transferRadiusM = 200, limit = 8 }) {
  const originLines = linesAt(originStops);
  const destinationLines = linesAt(destinationStops);
  const byScore = (a, b) => a.score - b.score;
  const directs = [...bestDirect(originLines, destinationLines, routes)].sort(byScore);
  const transfers = [...bestTransfers(originLines, destinationLines, routes, transferRadiusM)]
    .sort(byScore);
  // Directs ahead of transfers, rather than one pool sorted by `score`.
  //
  // `score` is walking metres plus 420 per stop ridden. It is a reasonable
  // guess at which candidates deserve a slot, but it knows nothing about when
  // the next bus actually comes — that is what the live ranking in the caller
  // is for, and everything cut here never reaches it. A direct ride is always
  // rankable there, because its boarding stop's board was already read; a
  // transfer needs a second board that only `transferChecks()` of them ever
  // get, so most arrive unrankable and sort last anyway.
  //
  // Sorting the two together let six untimeable transfers take the slots that
  // the 29 at Arturo Soria needed: 431m from the door and direct to the
  // destination, cut at rank 9 of 8 by its longer ride, while the option that
  // won boarded 670m away and left 14 minutes later.
  return [...directs, ...transfers].slice(0, limit);
}

export function uniqueLineCodes(stops) {
  return [...new Set(linesAt(stops).map((item) => item.code))];
}
