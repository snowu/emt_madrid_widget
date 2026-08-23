import {
  readCache,
  writeCache,
  readStops,
  writeStops,
  readDetails,
  writeDetail,
} from "./cache.js";

const API = "https://emt-arrivals.zancato-t.workers.dev";
const APP_KEY = "a3ca225683a89f9f394968f1081ee2ad"; // public by design; filters scanners, not people

const listEl = document.getElementById("stops");
const statusEl = document.getElementById("status");
const mapEl = document.getElementById("map");
const viewListBtn = document.getElementById("view-list");
const viewMapBtn = document.getElementById("view-map");
const addDialog = document.getElementById("add-dialog");

// One fetch feeds both: the card glances at the first two, the sheet shows
// the board. The worker serves both from a single 20s-cached payload.
const CARD_ARRIVALS = 2;
const BOARD_ARRIVALS = 8;

let stops = readStops();
let arrivals = readCache();
let details = readDetails();

function stopTitle(stop) {
  return stop.label || details[stop.stop_id]?.name || `Stop ${stop.stop_id}`;
}

/** The lines EMT says serve this stop — the answer to "why is nothing due?".
 *
 * Detail gives objects with the signed label and today's service hours; area
 * search gives bare codes. Devices that cached the old string-only shape are
 * still out there, so tolerate both rather than blanking their cards.
 */
function normaliseLine(l) {
  return typeof l === "string"
    ? { line: l, label: l, from: null, to: null, dayType: null, headers: [] }
    : l;
}

/** A stable colour per line, used for its label everywhere and for its route
 *  on the map — same line, same colour, on every surface.
 *
 * Hue comes from the line code by golden-angle rotation, so neighbouring codes
 * land far apart on the wheel instead of in the same muddy corner. Saturation
 * and lightness are fixed where they stay readable on the dark card.
 */
const lineColorCache = new Map();

function lineColor(code) {
  const key = String(code ?? "");
  const hit = lineColorCache.get(key);
  if (hit) return hit;

  // FNV-1a: small keys like "5" and "107" have to land far apart, which a
  // plain multiply-and-add hash does not guarantee.
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  // Quantised into 24 hues and two tones: a free-running hue puts two lines
  // five degrees apart often enough to matter on a card listing six of them.
  // Colliding outright is fine; looking almost-the-same is not.
  const hue = (hash % 24) * 15;
  const light = ((hash >>> 5) & 1) ? 66 : 52;
  const sat = ((hash >>> 6) & 1) ? 75 : 55;
  const color = `hsl(${hue} ${sat}% ${light}%)`;
  lineColorCache.set(key, color);
  return color;
}

/** Which timetable applies today: LA (weekday), SA, or FE (Sunday/holiday).
 *
 * EMT stamps it on every stop detail it sends, which beats deriving it from
 * the date — that would call a public holiday an ordinary Tuesday. We only
 * fall back to the weekday when no saved stop has a detail record at all.
 */
function todayDayType() {
  for (const detail of Object.values(details)) {
    for (const line of detail?.lines ?? []) {
      const stamped = normaliseLine(line).dayType;
      if (stamped) return stamped;
    }
  }
  const day = new Date().getDay();
  return day === 0 ? "FE" : day === 6 ? "SA" : "LA";
}

function stopLines(stopId) {
  return (details[stopId]?.lines ?? []).map(normaliseLine);
}

/** "Nº 30 · 107 · 129 · 5", each line in its own colour.
 *
 * Built as nodes rather than a string so the labels carry the same colour here
 * as on the map and in the arrival rows — a plain grey run of numbers is the
 * one place the colours were missing.
 */
function stopMetaNode(stopId) {
  const wrap = document.createDocumentFragment();
  wrap.append(`Nº ${stopId}`);
  for (const line of stopLines(stopId)) {
    wrap.append(" · ");
    const label = document.createElement("span");
    label.className = "meta-line";
    label.textContent = line.label;
    label.style.color = lineColor(line.label);
    wrap.append(label);
  }
  return wrap;
}

/** A detail with no coordinates is the stub we save when EMT answers 81. */
function isStub(detail) {
  return !detail || !detail.coordinates;
}

function fmtCountdown(seconds) {
  // EMT's sentinel: "running on schedule, no GPS estimate yet". Not a
  // countdown; render it as words.
  if (seconds >= 888888) return "scheduled";
  if (seconds <= 0) return "due";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

function fmtAge(ms) {
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function render() {
  listEl.replaceChildren(
    ...stops.map((stop) => {
      const cached = arrivals[stop.stop_id];
      const card = document.createElement("article");
      card.className = "stop";

      const titleWrap = document.createElement("div");
      titleWrap.className = "title";
      const title = document.createElement("h2");
      title.textContent = stopTitle(stop);
      const num = document.createElement("span");
      num.className = "stop-num";
      num.replaceChildren(stopMetaNode(stop.stop_id));
      titleWrap.append(title, num);

      // Card taps open the stop; the buttons on it must not also open it.
      card.addEventListener("click", () => openStop(stop));

      const refresh = document.createElement("button");
      refresh.textContent = "↻";
      refresh.title = "Refresh this stop";
      refresh.addEventListener("click", (event) => {
        event.stopPropagation();
        refreshStop(stop.stop_id);
      });

      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove this stop";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStop(stop.id);
      });

      const list = document.createElement("ul");
      if (!cached) {
        list.innerHTML = `<li class="muted">No data yet</li>`;
      } else if (cached.arrivals.length === 0) {
        // EMT answering "no estimations" is not a failure — at night, or on a
        // daytime-only bay, it is the true answer. The lines above say which
        // buses this stop serves, so an empty board reads as "none running".
        list.innerHTML = `<li class="muted">No buses due right now</li>`;
      } else {
        // Count down from the age of the fetch, not from the raw value, so a
        // cached payload shows the time remaining now rather than when fetched.
        const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
        // The card is the glance: next bus and the one after it. The stop
        // sheet shows the rest of the board.
        for (const bus of cached.arrivals.slice(0, CARD_ARRIVALS)) {
          const li = document.createElement("li");
          const line = document.createElement("span");
          line.className = "line";
          line.textContent = bus.line;
          line.style.color = lineColor(bus.line);
          const eta = document.createElement("span");
          eta.className = "eta";
          eta.textContent = fmtCountdown(bus.seconds - elapsed);
          li.append(line, eta);
          list.append(li);
        }
      }

      // Every rendering of arrival data carries its age. A stale number is fine;
      // a stale number without its age is not.
      const age = document.createElement("p");
      age.className = "age";
      age.textContent = cached ? `updated ${fmtAge(cached.fetchedAt)}` : "never updated";

      const controls = document.createElement("div");
      controls.className = "controls";
      controls.append(refresh, remove);

      const head = document.createElement("div");
      head.className = "head";
      head.append(titleWrap, controls);

      card.append(head, list, age);
      return card;
    })
  );
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "content-type": "application/json", "X-App-Key": APP_KEY, ...init.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.message || body.error || `HTTP ${res.status}`);
    err.kind = body.error; // "quota" | "auth" | "not_found" | "upstream"
    throw err;
  }
  return res.status === 204 ? null : res.json();
}

async function refreshStop(stopId) {
  try {
    const payload = await api(
      `/arrivals?stop=${encodeURIComponent(stopId)}&limit=${BOARD_ARRIVALS}`
    );
    arrivals[stopId] = payload;
    writeCache(stopId, payload);
    statusEl.textContent = "";
    render();
    renderSheetArrivals();
  } catch (err) {
    // Keep whatever is on screen; it is labelled with its age already.
    statusEl.textContent =
      err.kind === "quota"
        ? "EMT daily quota spent — showing cached times until it resets."
        : `Could not refresh stop ${stopId}: ${err.message}`;
  }
}

async function refreshAll() {
  await Promise.all(stops.map((s) => refreshStop(s.stop_id)));
}

/** Fetch and remember what EMT knows about a stop; throws not_found if it
 *  genuinely does not exist.
 *
 * Detail is preferred (name + coordinates) but EMT's detail table has holes
 * for real stops — stop 30 Plaza Castilla answers 81 there while arrivals
 * serves it happily. So on a detail miss we ask arrivals: code 80 means
 * "disabled or not exists", anything else means the stop is real.
 */
async function resolveStop(stopId) {
  if (details[stopId]) return details[stopId];
  try {
    const detail = await api(`/stops/${encodeURIComponent(stopId)}/detail`);
    details[stopId] = detail;
    writeDetail(stopId, detail);
    return detail;
  } catch {
    // Detail knows nothing; arrivals is the authority on existence.
  }
  try {
    await api(`/arrivals?stop=${encodeURIComponent(stopId)}`);
  } catch (err) {
    throw err; // not_found = bogus id; quota/upstream = try again later
  }
  const stub = { stopId, name: null, address: null, coordinates: null, lines: [] };
  details[stopId] = stub;
  writeDetail(stopId, stub);
  return stub;
}

/** Stops saved before names were resolved get their titles filled in. */
async function hydrateNames() {
  const missing = stops.filter((s) => !details[s.stop_id]);
  if (missing.length > 0) {
    // One stop EMT blips on must not take the rest of the pass down with it:
    // a rejected Promise.all here would skip the healing below entirely.
    await Promise.all(missing.map((s) => resolveStop(s.stop_id).catch(() => null)));
    render();
    rebuildMarkers();
  }
  healStubs();
}

/** Fold area-search records into what we know about stops.
 *
 * arroundxy carries name, lines and coordinates for stops whose detail record
 * EMT simply does not have (stop 30 Plaza Castilla is the standing example).
 * It is strictly better than the empty stub we save on a code 81, so it wins.
 *
 * Only saved stops are kept by default: a pan across town returns dozens of
 * stops per cell, and none of them belong in a device cache until saved.
 */
function mergeNearbyDetails(found, { onlySaved = true } = {}) {
  const saved = savedIds();
  let healed = false;
  for (const s of found) {
    if (onlySaved && !saved.has(s.stopId)) continue;
    if (!isStub(details[s.stopId]) || !s.coordinates) continue;
    const detail = {
      stopId: s.stopId,
      name: s.name ?? null,
      address: null,
      coordinates: s.coordinates,
      lines: s.lines ?? [],
    };
    details[s.stopId] = detail;
    writeDetail(s.stopId, detail);
    healed = true;
  }
  return healed;
}

/** Fill in detail-less saved stops by searching around the ones we can place.
 *
 * A stop with no detail record has no coordinates of its own to search from,
 * but stops travel in clusters — a Plaza Castilla bay is metres from another
 * Plaza Castilla bay we do know. Searching around each known saved stop heals
 * its blind neighbours without the map ever being opened. Nearby results are
 * cached in the worker for a day, so this is close to free.
 */
async function healStubs() {
  if (!stops.some((s) => isStub(details[s.stop_id]))) return;
  const seen = new Set();
  const origins = [];
  for (const stop of stops) {
    const coords = details[stop.stop_id]?.coordinates;
    if (!coords) continue;
    const cell = `${coords[0].toFixed(3)},${coords[1].toFixed(3)}`;
    if (seen.has(cell)) continue;
    seen.add(cell);
    origins.push(coords);
  }
  if (origins.length === 0) return;

  const results = await Promise.all(
    origins.map(([lon, lat]) =>
      api(`/stops/nearby?lat=${lat}&lon=${lon}&radius=${NEARBY_RADIUS}`).catch(() => [])
    )
  );
  if (mergeNearbyDetails(results.flat())) {
    render();
    rebuildMarkers();
  }
}

/* ---- List / Map views ------------------------------------------------- */

let leafletMap = null;
let markers = null; // L.LayerGroup — saved stops
let nearbyLayer = null; // L.LayerGroup — unsaved stops around the view
let nearbyCell = null;
let nearbyStops = [];
let nearbySeq = 0;

const NEARBY_RADIUS = 500;

/* ---- Line routes on the map -------------------------------------------- */

let routeLayer = null;
const shownRoutes = new Map(); // line code → { layer, label }
const routeCache = new Map(); // line code → route payload

/** Draw or erase one line's route, in that line's colour.
 *
 * Route geometry is ~25KB a line and never changes during a session, so it is
 * fetched once and kept; the worker holds it for a week.
 */
async function toggleRoute(code, label) {
  if (!leafletMap) return;
  if (shownRoutes.has(code)) {
    routeLayer.removeLayer(shownRoutes.get(code).layer);
    shownRoutes.delete(code);
    renderRouteLegend();
    return;
  }

  statusEl.textContent = `Loading route ${label}…`;
  let route = routeCache.get(code);
  if (!route) {
    try {
      route = await api(`/lines/${encodeURIComponent(code)}/route`);
      routeCache.set(code, route);
    } catch (err) {
      statusEl.textContent = `Could not load route ${label}: ${err.message}`;
      return;
    }
  }
  statusEl.textContent = "";
  if (shownRoutes.has(code)) return; // toggled off again while loading

  const color = lineColor(label);
  // featureGroup, not layerGroup: only this one can report its own bounds.
  const group = L.featureGroup();
  for (const [direction, segments] of Object.entries(route.paths ?? {})) {
    if (!segments?.length) continue;
    // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon]. The way back is
    // dashed so the two directions stay tellable apart in one colour.
    const latlngs = segments.map((seg) => seg.map(([lon, lat]) => [lat, lon]));
    L.polyline(latlngs, {
      color,
      weight: 4,
      opacity: 0.85,
      dashArray: direction === "toB" ? "6 6" : null,
      // Decoration, not a target: an interactive line would swallow taps meant
      // for the stop pins it runs through.
      interactive: false,
    }).addTo(group);
  }
  addRouteStops(group, route, color);
  group.addTo(routeLayer);
  shownRoutes.set(code, { layer: group, label });
  renderRouteLegend();

  // Drawing a route you can only see a tenth of is not showing it. The legend
  // chip is how you get rid of it again.
  const bounds = group.getBounds();
  if (bounds.isValid()) leafletMap.fitBounds(bounds.pad(0.08));
}

/** Every stop the line calls at, drawn as small dots along its route.
 *
 * These come in the same payload as the geometry, so showing them costs no
 * extra request. Saved stops keep their own pin and are skipped, and a stop
 * served in both directions is drawn once.
 */
function addRouteStops(group, route, color) {
  const saved = savedIds();
  const seen = new Set();
  for (const stop of [...(route.stops?.toA ?? []), ...(route.stops?.toB ?? [])]) {
    if (seen.has(stop.stopId) || saved.has(stop.stopId) || !stop.coordinates) continue;
    seen.add(stop.stopId);
    L.circleMarker([stop.coordinates[1], stop.coordinates[0]], {
      radius: 4,
      color,
      weight: 2,
      fillColor: "#12141a",
      fillOpacity: 1,
    })
      // The same popup a nearby pin gets: live times, and a way to save it.
      .bindPopup(() => nearbyPopupHtml({ ...stop, lines: [] }))
      .addTo(group).nearbyStop = { ...stop, lines: [] }; // for popup refresh ticks
  }
}

function clearRoutes() {
  routeLayer?.clearLayers();
  shownRoutes.clear();
  renderRouteLegend();
}

/** Chips naming what is drawn — the only way to tell one route from another
 *  once several are up, and the way to take them down again. */
function renderRouteLegend() {
  const legend = document.getElementById("route-legend");
  legend.hidden = shownRoutes.size === 0 || mapEl.hidden;
  legend.replaceChildren(
    ...(shownRoutes.size > 1 ? [clearRoutesChip()] : []),
    ...[...shownRoutes].map(([code, { label }]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "route-chip";
      chip.textContent = `${label} ×`;
      chip.style.borderColor = lineColor(label);
      chip.style.color = lineColor(label);
      chip.title = `Hide route ${label}`;
      chip.addEventListener("click", () => toggleRoute(code, label));
      return chip;
    })
  );
}

function clearRoutesChip() {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "route-chip clear";
  chip.textContent = "Clear all";
  chip.addEventListener("click", clearRoutes);
  return chip;
}

/** The line list inside a popup, each line a button that draws its route. */
function lineChips(lines) {
  const wrap = document.createElement("p");
  wrap.className = "chips";
  for (const raw of lines ?? []) {
    const l = normaliseLine(raw);
    const chip = document.createElement("button");
    chip.type = "button";
    // Drawn-or-not is read from the map, never held on the chip: popups are
    // rebuilt every second by the countdown tick, which would lose it.
    chip.className = shownRoutes.has(l.line) ? "line-chip on" : "line-chip";
    chip.textContent = l.label;
    chip.style.color = lineColor(l.label);
    chip.style.borderColor = lineColor(l.label);
    chip.title = `${shownRoutes.has(l.line) ? "Hide" : "Show"} route ${l.label}`;
    chip.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleRoute(l.line, l.label);
    });
    wrap.append(chip);
  }
  return wrap;
}

function popupHtml(stop) {
  // Built as DOM, never as a string: line names/labels come from EMT.
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = stopTitle(stop);
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = `Nº ${stop.stop_id}`;
  const chips = lineChips(stopLines(stop.stop_id));
  const ul = document.createElement("ul");

  const open = document.createElement("button");
  open.type = "button";
  open.textContent = "Open";
  open.addEventListener("click", () => {
    leafletMap.closePopup();
    openStop(stop);
  });

  const cached = arrivals[stop.stop_id];
  if (!cached || cached.arrivals.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = cached ? "No buses due right now" : "No data yet";
    ul.append(li);
  } else {
    const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
    for (const bus of cached.arrivals.slice(0, CARD_ARRIVALS)) {
      const li = document.createElement("li");
      const line = document.createElement("span");
      line.className = "line";
      line.textContent = String(bus.line);
      line.style.color = lineColor(bus.line);
      const eta = document.createElement("span");
      eta.className = "eta";
      eta.textContent = fmtCountdown(bus.seconds - elapsed);
      li.append(line, eta);
      ul.append(li);
    }
    const age = document.createElement("p");
    age.className = "muted";
    age.textContent = `updated ${fmtAge(cached.fetchedAt)}`;
    wrap.append(title, num, chips, ul, age, open);
    return wrap;
  }
  wrap.append(title, num, chips, ul, open);
  return wrap;
}

function ensureMap() {
  if (leafletMap) return;
  leafletMap = L.map(mapEl, { tap: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(leafletMap);

  // Routes go down first so pins stay clickable on top of them.
  routeLayer = L.layerGroup().addTo(leafletMap);
  markers = L.layerGroup().addTo(leafletMap);
  nearbyLayer = L.layerGroup().addTo(leafletMap);
  rebuildMarkers();
  leafletMap.on("moveend", loadNearby);

  // Fit once, on the first build, when all pins are known.
  const points = stops
    .map((s) => details[s.stop_id]?.coordinates)
    .filter(Boolean)
    .map(([lon, lat]) => [lat, lon]);
  if (points.length > 0) {
    leafletMap.fitBounds(L.latLngBounds(points).pad(0.35));
  } else if (points.length === 0 && stops.length > 0) {
    // Madrid centre; details may still be resolving.
    leafletMap.setView([40.4168, -3.7038], 12);
  }
  loadNearby();
}

function rebuildMarkers() {
  if (!markers) return;
  markers.clearLayers();
  for (const stop of stops) {
    const coords = details[stop.stop_id]?.coordinates;
    if (!coords) continue;
    // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon].
    const marker = L.marker([coords[1], coords[0]]);
    marker.bindPopup(() => popupHtml(stop));
    marker.stopId = stop.stop_id; // for popup refresh ticks
    marker.addTo(markers);
  }
}

/** Re-render any open popup so its countdown ticks like the list. */
function tickPopups() {
  if (mapEl.hidden) return;
  markers?.eachLayer((marker) => {
    if (marker.isPopupOpen()) {
      marker.setPopupContent(popupHtml(stops.find((s) => s.stop_id === marker.stopId)));
    }
  });
  for (const layer of [nearbyLayer, routeLayer]) {
    // Route stops live one level down, inside their line's group.
    layer?.eachLayer((child) => tickUnsavedPopup(child));
  }
}

function tickUnsavedPopup(layer) {
  if (layer.eachLayer && !layer.nearbyStop) {
    layer.eachLayer(tickUnsavedPopup);
    return;
  }
  if (layer.nearbyStop && layer.isPopupOpen?.()) {
    layer.setPopupContent(nearbyPopupHtml(layer.nearbyStop));
  }
}

function showView(view) {
  const isMap = view === "map";
  listEl.hidden = isMap;
  mapEl.hidden = !isMap;
  viewListBtn.setAttribute("aria-selected", String(!isMap));
  viewMapBtn.setAttribute("aria-selected", String(isMap));
  if (isMap) {
    ensureMap();
    rebuildMarkers();
    renderNearbyPins();
    renderRouteLegend();
    leafletMap.invalidateSize();
  } else {
    renderRouteLegend(); // it lives over the map; the list has no use for it
    render(); // the interval skips list renders while the map is up
  }
}

/* ---- Nearby stops on the map ------------------------------------------ */

function savedIds() {
  return new Set(stops.map((s) => s.stop_id));
}

/** Arrivals for stops that are not saved, kept in memory only — localStorage
 *  is the cache for stops you actually keep. undefined = never asked,
 *  null = asked and EMT did not answer. */
const previewArrivals = new Map();

async function loadPreviewArrivals(stopId) {
  if (previewArrivals.has(stopId)) return;
  previewArrivals.set(stopId, undefined);
  try {
    previewArrivals.set(
      stopId,
      await api(`/arrivals?stop=${encodeURIComponent(stopId)}&limit=${BOARD_ARRIVALS}`)
    );
  } catch {
    previewArrivals.set(stopId, null);
  }
  tickPopups();
}

function nearbyPopupHtml(s) {
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = s.name || `Stop ${s.stopId}`;
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = `Nº ${s.stopId}`;
  wrap.append(title, num);
  if (s.lines?.length) wrap.append(lineChips(s.lines));

  // What you actually want to know before saving a stop: is a bus coming.
  const ul = document.createElement("ul");
  const preview = previewArrivals.get(s.stopId);
  if (preview === undefined) {
    ul.innerHTML = `<li class="muted">Checking arrivals…</li>`;
    loadPreviewArrivals(s.stopId);
  } else if (preview === null) {
    ul.innerHTML = `<li class="muted">Could not reach EMT</li>`;
  } else if (preview.arrivals.length === 0) {
    ul.innerHTML = `<li class="muted">No buses due right now</li>`;
  } else {
    const elapsed = Math.floor((Date.now() - preview.fetchedAt) / 1000);
    for (const bus of preview.arrivals.slice(0, CARD_ARRIVALS)) {
      const li = document.createElement("li");
      const line = document.createElement("span");
      line.className = "line";
      line.textContent = bus.line;
      line.style.color = lineColor(bus.line);
      const eta = document.createElement("span");
      eta.className = "eta";
      eta.textContent = fmtCountdown(bus.seconds - elapsed);
      li.append(line, eta);
      ul.append(li);
    }
  }
  wrap.append(ul);

  const add = document.createElement("button");
  add.type = "button";
  add.textContent = "Add this stop";
  add.addEventListener("click", async () => {
    add.disabled = true;
    try {
      await addStopById(s.stopId, null, s);
      leafletMap.closePopup();
      statusEl.textContent = "";
    } catch {
      add.disabled = false;
    }
  });
  wrap.append(add);
  return wrap;
}

function renderNearbyPins() {
  if (!nearbyLayer) return;
  const saved = savedIds();
  nearbyLayer.clearLayers();
  for (const s of nearbyStops) {
    if (saved.has(s.stopId) || !s.coordinates) continue;
    // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon].
    L.circleMarker([s.coordinates[1], s.coordinates[0]], {
      radius: 7,
      color: "#8b93a7",
      weight: 2,
      fillColor: "#3a4150",
      fillOpacity: 0.9,
    })
      .bindPopup(() => nearbyPopupHtml(s))
      .addTo(nearbyLayer).nearbyStop = s; // for popup refresh ticks
  }
}

/** Load stops within 500m of the map centre; one fetch per ~110m cell. */
async function loadNearby() {
  if (!leafletMap || mapEl.hidden) return;
  const centre = leafletMap.getCenter();
  const cell = `${centre.lat.toFixed(3)},${centre.lng.toFixed(3)}`;
  if (cell === nearbyCell) return;
  const seq = ++nearbySeq;
  try {
    const found = await api(
      `/stops/nearby?lat=${centre.lat}&lon=${centre.lng}&radius=${NEARBY_RADIUS}`
    );
    if (seq !== nearbySeq) return; // a newer pan superseded this request
    nearbyStops = found;
    nearbyCell = cell;
    // A pan over a saved-but-detail-less stop is a free chance to learn it.
    if (mergeNearbyDetails(found)) {
      render();
      rebuildMarkers();
    }
    renderNearbyPins();
  } catch {
    // Map stays usable without the halo of nearby pins.
  }
}

viewListBtn.addEventListener("click", () => showView("list"));
viewMapBtn.addEventListener("click", () => showView("map"));

async function loadStops() {
  try {
    stops = await api("/stops");
    writeStops(stops);
  } catch (err) {
    statusEl.textContent = `Showing saved stops: ${err.message}`;
  }
  render();
  refreshAll();
  hydrateNames();
}

async function deleteStop(id) {
  try {
    await api(`/stops/${id}`, { method: "DELETE" });
    stops = stops.filter((s) => s.id !== id);
    writeStops(stops);
    render();
    rebuildMarkers();
    renderNearbyPins(); // the removed stop may now show as nearby
  } catch (err) {
    statusEl.textContent = `Could not remove stop: ${err.message}`;
  }
}


/* ---- Stop sheet: one saved stop, up close ------------------------------ */

const stopDialog = document.getElementById("stop-dialog");
const sheetForm = document.getElementById("stop-form");
const sheetHeading = document.getElementById("sheet-heading");
const sheetMeta = document.getElementById("sheet-meta");
const sheetMapEl = document.getElementById("sheet-map");
const sheetNoMap = document.getElementById("sheet-no-map");
const sheetArrivals = document.getElementById("sheet-arrivals");
const sheetAge = document.getElementById("sheet-age");
const sheetLabel = document.getElementById("sheet-label");
const sheetName = document.getElementById("sheet-name");
const sheetEdit = document.getElementById("sheet-edit");
const sheetSave = document.getElementById("sheet-save");
const sheetService = document.getElementById("sheet-service");
const sheetServiceWrap = document.getElementById("sheet-service-wrap");
const sheetNote = document.getElementById("sheet-service-note");

let sheetStop = null;
let sheetMap = null;
let sheetMarker = null;

function openStop(stop) {
  sheetStop = stop;
  sheetHeading.textContent = stopTitle(stop);
  sheetMeta.replaceChildren(stopMetaNode(stop.stop_id));
  sheetLabel.value = stop.label ?? "";
  sheetLabel.placeholder = details[stop.stop_id]?.name || "EMT's name";
  showNameEditor(false);
  renderSheetArrivals();
  renderSheetService();
  stopDialog.showModal();
  showSheetMap();
  // A card's numbers can be a minute old; opening the stop is asking for now.
  refreshStop(stop.stop_id);
}

/** Leaflet measures its container, so the map can only be built once the
 *  dialog is actually laid out. */
function showSheetMap() {
  const coords = details[sheetStop.stop_id]?.coordinates;
  sheetMapEl.hidden = !coords;
  sheetNoMap.hidden = !!coords;
  if (!coords) return;
  const latlng = [coords[1], coords[0]]; // GeoJSON is [lon, lat]

  requestAnimationFrame(() => {
    if (!sheetMap) {
      sheetMap = L.map(sheetMapEl, {
        zoomControl: false,
        attributionControl: false,
        // A 150px map inside a dialog is a picture, not something to navigate.
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        keyboard: false,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 })
        .addTo(sheetMap);
      sheetMarker = L.marker(latlng).addTo(sheetMap);
    } else {
      sheetMarker.setLatLng(latlng);
    }
    sheetMap.invalidateSize();
    sheetMap.setView(latlng, 17);
  });
}

function renderSheetArrivals() {
  if (!sheetStop || !stopDialog.open) return;
  const cached = arrivals[sheetStop.stop_id];
  sheetMeta.replaceChildren(stopMetaNode(sheetStop.stop_id));

  if (!cached || cached.arrivals.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = cached ? "No buses due right now" : "No data yet";
    sheetArrivals.replaceChildren(li);
  } else {
    const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
    sheetArrivals.replaceChildren(
      ...cached.arrivals.map((bus) => {
        const li = document.createElement("li");
        const line = document.createElement("span");
        line.className = "line";
        line.textContent = bus.line;
        line.style.color = lineColor(bus.line);
        const eta = document.createElement("span");
        eta.className = "eta";
        eta.textContent = fmtCountdown(bus.seconds - elapsed);
        li.append(line);
        if (bus.destination) {
          const dest = document.createElement("span");
          dest.className = "dest";
          dest.textContent = bus.destination;
          li.append(dest);
        }
        li.append(eta);
        return li;
      })
    );
  }
  sheetAge.textContent = cached ? `updated ${fmtAge(cached.fetchedAt)}` : "never updated";
}

/** Which lines call here and between what hours — an empty board at 02:00 is
 *  a stop whose lines stop at 23:45, not a stop that is broken. Only stop
 *  detail carries the hours; a stop EMT has no detail record for lists its
 *  lines without them. */
/** Hours for lines whose stop has no detail record, keyed by line code.
 *  undefined = never asked or in flight, null = asked and got nothing. */
const lineHours = new Map();

/** Ask the line itself when the stop cannot say.
 *
 * A stop EMT has no detail record for still lists its line codes, and those
 * are exactly what the timetable endpoint is keyed on — so hours borrowed from
 * the line beat "unknown". Answers are cached in the worker for a day and here
 * for the session; a line with no row for today does not run today.
 */
async function fetchLineHours(code) {
  if (lineHours.has(code)) return;
  lineHours.set(code, undefined); // in flight — don't ask twice
  try {
    const { days } = await api(`/lines/${encodeURIComponent(code)}/timetable`);
    lineHours.set(code, days ?? []);
  } catch {
    // Record the miss rather than leaving the row saying "checking…" forever.
    // Closing the sheet forgets it, so reopening retries.
    lineHours.set(code, null);
  }
  if (stopDialog.open) renderSheetService();
}

function renderSheetService() {
  if (!sheetStop) return;
  const lines = stopLines(sheetStop.stop_id);
  sheetServiceWrap.hidden = lines.length === 0;
  const today = todayDayType();
  let borrowed = false;

  sheetService.replaceChildren(
    ...lines.map((l) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "line";
      label.textContent = l.label;
      label.style.color = lineColor(l.label);
      li.append(label);

      const hours = document.createElement("span");
      hours.className = "hours";
      let window = l.from && l.to ? { from: l.from, to: l.to, overnight: false } : null;

      if (!window) {
        const days = lineHours.get(l.line);
        if (days === undefined) {
          hours.textContent = "checking…";
          fetchLineHours(l.line);
        } else if (days === null || days.length === 0) {
          hours.textContent = "hours unknown";
        } else {
          window = days.find((d) => d.dayType === today) ?? null;
          // A line with no row for today's day type is not running today —
          // that is an answer, not a gap.
          if (!window) hours.textContent = "no service today";
        }
      }
      if (window) {
        hours.textContent = `${window.from}–${window.to}`;
        if (window.overnight) hours.textContent += " (+1d)";
        // Borrowed from the line, not this stop: the line's first and last bus
        // anywhere on the route, which can be wider than this stop's own.
        if (!l.from) {
          hours.textContent += "*";
          borrowed = true;
        }
      }
      li.append(hours);

      if (l.headers?.length) {
        const route = document.createElement("span");
        route.className = "route";
        route.textContent = l.headers.join(" ↔ ");
        li.append(route);
      }
      return li;
    })
  );

  sheetNote.hidden = !borrowed;
}

/** The name shows as a heading until the pencil is tapped: focusing an input
 *  on open would raise the phone keyboard over everything worth reading. */
function showNameEditor(editing) {
  sheetName.hidden = !editing;
  sheetSave.hidden = !editing;
  sheetEdit.hidden = editing;
  if (editing) sheetLabel.focus();
}

sheetEdit.addEventListener("click", () => showNameEditor(true));

sheetForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const stop = sheetStop;
  const label = sheetLabel.value.trim();
  if (label === (stop.label ?? "")) {
    stopDialog.close();
    return;
  }
  try {
    // An empty name is not a blank title: it hands the stop back to EMT's own.
    const row = await api(`/stops/${encodeURIComponent(stop.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ label: label || null }),
    });
    stops = stops.map((s) => (s.id === row.id ? row : s));
    writeStops(stops);
    render();
    rebuildMarkers();
    stopDialog.close();
  } catch (err) {
    statusEl.textContent = `Could not rename stop: ${err.message}`;
  }
});

// Forget failed lookups on close so the next open asks again; keep the hits.
stopDialog.addEventListener("close", () => {
  for (const [code, days] of lineHours) if (!days) lineHours.delete(code);
});

document.getElementById("sheet-close").addEventListener("click", () => stopDialog.close());
document.getElementById("sheet-refresh").addEventListener("click", () =>
  refreshStop(sheetStop.stop_id)
);
document.getElementById("sheet-remove").addEventListener("click", async () => {
  const id = sheetStop.id;
  stopDialog.close();
  await deleteStop(id);
});

const fab = document.getElementById("fab");
const addForm = document.getElementById("add-stop");

/** Shared by the dialog form and the map's nearby-pin buttons. */
async function addStopById(stopId, label, seed = null) {
  if (!/^[0-9]+$/.test(stopId)) {
    const err = new Error("Stop numbers are digits only.");
    err.kind = "invalid";
    throw err;
  }
  // Added from a map pin: the area search already told us everything, and it
  // knows stops whose detail record EMT is missing. Don't throw that away.
  if (seed) mergeNearbyDetails([seed], { onlySaved: false });
  statusEl.textContent = `Looking up stop ${stopId}…`;
  let detail;
  try {
    detail = await resolveStop(stopId);
  } catch (err) {
    statusEl.textContent =
      err.kind === "not_found"
        ? `No EMT stop ${stopId} — check the number on the stop sign.`
        : `Could not check stop ${stopId}: ${err.message}`;
    throw err;
  }
  try {
    const row = await api("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId, label: label || detail.name }),
    });
    stops.push(row);
    writeStops(stops);
    statusEl.textContent = "";
    render();
    rebuildMarkers();
    renderNearbyPins(); // its grey pin becomes an accent one
    refreshStop(row.stop_id);
    return row;
  } catch (err) {
    statusEl.textContent = `Could not add stop: ${err.message}`;
    throw err;
  }
}

fab.addEventListener("click", () => {
  statusEl.textContent = "";
  addDialog.showModal();
  document.getElementById("stop-id").focus();
});

document.getElementById("add-cancel").addEventListener("click", () => addDialog.close());

addForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const idInput = document.getElementById("stop-id");
  const labelInput = document.getElementById("stop-label");
  const stopId = idInput.value.trim();
  const userLabel = labelInput.value.trim();
  fab.disabled = true;
  document.getElementById("add-save").disabled = true;
  try {
    await addStopById(stopId, userLabel || null);
    idInput.value = "";
    labelInput.value = "";
    addDialog.close();
  } catch {
    // statusEl already explains; dialog stays open for correcting.
  } finally {
    fab.disabled = false;
    document.getElementById("add-save").disabled = false;
  }
});

document.getElementById("refresh-all").addEventListener("click", refreshAll);

// Re-render every second so countdowns and ages tick without refetching.
setInterval(() => {
  if (mapEl.hidden) render();
  tickPopups();
  renderSheetArrivals();
}, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAll();
});

render(); // paint cached data immediately; never show an empty screen
loadStops();
