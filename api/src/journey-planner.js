const EARTH_M = 6_371_000;

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

export function boardHasLine(board, line) {
  const wanted = lineCode(line).toUpperCase();
  return Boolean(wanted) && (board?.arrivals ?? [])
    .some((arrival) => lineCode(arrival).toUpperCase() === wanted);
}

export function stopsWithLiveLines(stops, boards) {
  return (stops ?? []).map((stop) => {
    const arrivals = boards.get(String(stop.stopId))?.arrivals ?? [];
    const listed = new Map((stop.lines ?? []).map((line) => [lineCode(line).toUpperCase(), line]));
    const live = new Map();
    for (const arrival of arrivals) {
      const code = lineCode(arrival);
      if (!code || live.has(code.toUpperCase())) continue;
      live.set(code.toUpperCase(), listed.get(code.toUpperCase()) ?? { line: code, label: code });
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
  const destinationByCode = new Map(destinationLines.map((item) => [item.code, item]));
  const candidates = [];
  for (const origin of originLines) {
    const destination = destinationByCode.get(origin.code);
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
      if (first.code === second.code) continue;
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

export function planJourney({ originStops, destinationStops, routes, transferRadiusM = 200, limit = 4 }) {
  const originLines = linesAt(originStops);
  const destinationLines = linesAt(destinationStops);
  return [...bestDirect(originLines, destinationLines, routes),
    ...bestTransfers(originLines, destinationLines, routes, transferRadiusM)]
    .sort((a, b) => a.score - b.score)
    .slice(0, limit);
}

export function uniqueLineCodes(stops) {
  return [...new Set(linesAt(stops).map((item) => item.code))];
}
