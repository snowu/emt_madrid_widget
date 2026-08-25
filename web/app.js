import {
  readCache,
  writeCache,
  writeArrivalCache,
  readStops,
  writeStops,
  readDetails,
  writeDetail,
  readBikeSaved,
  writeBikeSaved,
  readBikeNear,
  writeBikeNear,
  readBikeAccount,
  writeBikeAccount,
  readBikeTrips,
  writeBikeTrips,
  setUserCacheScope,
} from "./cache.js";
import {
  mergeTripHistory,
  tripIdentity,
  tripsAreOldestFirst,
  updateTripDiagnostics,
  mergeTripDiagnostics,
  TRIP_DIAGNOSTIC_LABELS,
} from "./trips.js";

const API = "https://emt-arrivals.zancato-t.workers.dev";
const THEME_KEY = "emt:theme";
const HUB_CARD_LIMIT = 3;
const NEAREST_BIKE_STATION_LIMIT = 2;
const JOURNEY_BATCH_SIZE = 3;
const savedTheme = localStorage.getItem(THEME_KEY);
let themeChoice = ["light", "dark"].includes(savedTheme) ? savedTheme : "system";
if (themeChoice === "system") document.documentElement.removeAttribute("data-theme");
else document.documentElement.dataset.theme = themeChoice;
let authClient = null;
let authSession = null;
let authUser = null;
let isOwner = false;
let myLocation = null;
let places = [];
let journeyPayload = null;
let journeyCell = null;
let journeyLoadedAt = 0;
let journeyTimer = null;
let busListMode = localStorage.getItem("emt:bus-list-mode") === "stops" ? "stops" : "places";

const listEl = document.getElementById("stops");
const statusEl = document.getElementById("status");
const mapEl = document.getElementById("map");
const viewListBtn = document.getElementById("view-list");
const viewMapBtn = document.getElementById("view-map");
const addDialog = document.getElementById("add-dialog");
const addStopMapEl = document.getElementById("add-stop-map");
const addStopNearbyList = document.getElementById("add-stop-nearby");
const addStopMessage = document.getElementById("add-stop-message");
const authButton = document.getElementById("auth-button");
const authDialog = document.getElementById("auth-dialog");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authMessage = document.getElementById("auth-message");
const accountMenu = document.getElementById("account-menu");
const accountMenuEmail = document.getElementById("account-menu-email");
const accountSignout = document.getElementById("account-signout");
const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
const placesDialog = document.getElementById("places-dialog");
const placesForm = document.getElementById("places-form");
const placesList = document.getElementById("places-list");
const placesMessage = document.getElementById("places-message");
const busModePlaces = document.getElementById("bus-mode-places");
const busModeStops = document.getElementById("bus-mode-stops");
const menuBikes = document.getElementById("menu-bikes");
const headerContext = document.getElementById("header-context");
const nearbyStopsDialog = document.getElementById("nearby-stops-dialog");
const nearbyStopsList = document.getElementById("nearby-stops-list");
const nearbyStopsMessage = document.getElementById("nearby-stops-message");
const placeEditor = document.getElementById("place-editor");
const placeSearchResults = document.getElementById("place-search-results");
const placePicked = document.getElementById("place-picked");
let placePickerMap = null;
let placePickerMarker = null;
let placeDraft = null;

function setTheme(choice) {
  themeChoice = ["light", "dark"].includes(choice) ? choice : "system";
  if (themeChoice === "system") {
    document.documentElement.removeAttribute("data-theme");
    localStorage.removeItem(THEME_KEY);
  } else {
    document.documentElement.dataset.theme = themeChoice;
    localStorage.setItem(THEME_KEY, themeChoice);
  }
  for (const button of themeButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.themeChoice === themeChoice));
  }
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.content = themeChoice === "system"
      ? (meta.media.includes("light") ? "#f4f6fa" : "#12141a")
      : (themeChoice === "light" ? "#f4f6fa" : "#12141a");
  }
}

for (const button of themeButtons) {
  button.addEventListener("click", () => setTheme(button.dataset.themeChoice));
}
setTheme(themeChoice);

// One fetch feeds both: the card glances at the first two, the sheet shows
// the board. The worker serves both from a single 20s-cached payload.
const CARD_ARRIVALS = 2;
const BOARD_ARRIVALS = 8;

let stops = [];
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
 * Hue comes from the line code by an FNV-1a hash quantised into 24 steps, so
 * neighbouring codes land far apart on the wheel instead of in the same muddy
 * corner. Saturation and lightness each get a hash bit, kept to values that
 * stay readable on the dark card.
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

/** Hours for lines whose stop has no detail record, keyed by line code.
 *  undefined = never asked or in flight, null = asked and got nothing. */
const lineHours = new Map();

function minutesOf(clock) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock ?? "");
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Today's service windows for every line at this stop.
 *
 * Two sources, same shape: a stop with a detail record carries its own hours,
 * and one without borrows the line's. `fetchMissing` is off for stops you have
 * not saved — browsing the map should not fire a request per line per pin.
 */
function serviceWindows(stopId, { fetchMissing = false } = {}) {
  const today = todayDayType();
  const windows = [];
  for (const line of stopLines(stopId)) {
    if (line.from && line.to) {
      windows.push({
        label: line.label,
        from: line.from,
        to: line.to,
        overnight: minutesOf(line.to) < minutesOf(line.from),
      });
      continue;
    }
    const days = lineHours.get(line.line);
    if (days === undefined) {
      if (fetchMissing) fetchLineHours(line.line);
      continue;
    }
    const row = days?.find((d) => d.dayType === today);
    if (row?.from && row?.to) windows.push({ ...row, label: line.label });
  }
  return windows;
}

/** When the first bus is expected, for a stop with nothing due.
 *
 * Returns null when a line should be running right now — then an empty board
 * means EMT has no estimate, not that the stop is asleep, and promising a
 * first bus at 07:00 when it is 09:00 would be a lie.
 */
function nextServiceStart(stopId, { fetchMissing = false } = {}) {
  const windows = serviceWindows(stopId, { fetchMissing });
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  let best = null;
  for (const w of windows) {
    const from = minutesOf(w.from);
    const to = minutesOf(w.to);
    if (from == null || to == null) continue;
    const running = w.overnight ? nowMins >= from || nowMins <= to : nowMins >= from && nowMins <= to;
    if (running) return null;
    // Already past today: the next one is tomorrow's.
    const wait = from >= nowMins ? from - nowMins : from + 1440 - nowMins;
    if (!best || wait < best.wait) best = { wait, at: w.from, label: w.label };
  }
  return best;
}

function fmtWait(mins) {
  if (mins < 60) return `in ${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `in ${h}h` : `in ${h}h ${m}m`;
}

/** What an empty arrival board should say. */
function emptyBoardText(stopId, { fetchMissing = false } = {}) {
  const next = nextServiceStart(stopId, { fetchMissing });
  if (!next) return "No buses due right now";
  return `First bus ${next.at} · ${next.label} · ${fmtWait(next.wait)}`;
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
  const known = (details[stopId]?.lines ?? []).map(normaliseLine);
  const seen = new Set(known.map((line) => String(line.line)));
  // EMT's stop-detail catalogue has holes for valid stops. Arrivals is a
  // separate source and still identifies the routes serving those stops, so
  // use it to complete (but never overwrite) the richer detail metadata.
  for (const arrival of arrivals[stopId]?.arrivals ?? []) {
    const code = String(arrival.line ?? "");
    if (!code || seen.has(code)) continue;
    known.push(normaliseLine(code));
    seen.add(code);
  }
  return known;
}

function metresBetweenCoordinates([lon1, lat1], [lon2, lat2]) {
  const x = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
  const y = lat2 - lat1;
  return Math.round(Math.sqrt(x * x + y * y) * 111_320);
}

function metresFromCurrent(coordinates) {
  if (!myLocation || !Array.isArray(coordinates)) return null;
  return metresBetweenCoordinates([myLocation[1], myLocation[0]], coordinates);
}

function proximity(value) {
  return value == null ? Number.POSITIVE_INFINITY : value;
}

function formatDistance(metres) {
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
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
  const distance = formatDistance(metresFromCurrent(details[stopId]?.coordinates));
  if (distance) wrap.append(` · ◎ ${distance}`);
  return wrap;
}

/** A detail with no coordinates is the stub we save when EMT answers 81. */
function isStub(detail) {
  return !detail || !detail.coordinates;
}

function fmtCountdown(seconds) {
  // EMT's sentinel: "running on schedule, no GPS estimate yet". Not a
  // countdown; render it as words.
  if (seconds >= 24 * 3600) return "scheduled";
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

function openWalkingDirections(coordinates) {
  if (!coordinates) return;
  const [lon, lat] = coordinates;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${lat},${lon}`);
  url.searchParams.set("travelmode", "walking");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

const WALKING_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="13" cy="4" r="1.8"></circle><path d="m10.5 8 2.5-1 2.5 2.5 2.5 1"></path><path d="m13 7-2 5 3 2 1.5 5"></path><path d="m11 12-3 3-2 4"></path></svg>';
const ROUTE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s6-5.4 6-11a6 6 0 1 0-12 0c0 5.6 6 11 6 11Z"></path><circle cx="12" cy="10" r="2"></circle></svg>';

function openTransitDirections(place) {
  if (!myLocation || !place) return;
  const [lat, lon] = myLocation;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("origin", `${lat},${lon}`);
  url.searchParams.set("destination", `${place.lat},${place.lon}`);
  url.searchParams.set("travelmode", "transit");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

function placeDistance(place) {
  if (!myLocation) return null;
  return metresBetweenCoordinates([myLocation[1], myLocation[0]], [place.lon, place.lat]);
}

function activeDestinations() {
  return places.filter((place) => place.enabled !== false &&
    (placeDistance(place) == null || placeDistance(place) > place.geofence_radius_m))
    .sort((a, b) => proximity(placeDistance(a)) - proximity(placeDistance(b)))
    .slice(0, HUB_CARD_LIMIT);
}

function journeyFor(placeId) {
  return journeyPayload?.destinations?.find((item) => item.destination.id === placeId);
}

function setPlaceReachability(card, waitSeconds, walkSeconds) {
  card.classList.remove("reachability-comfortable", "reachability-tight", "reachability-missed");
  const margin = Number(waitSeconds) - Number(walkSeconds);
  if (!Number.isFinite(margin)) return;
  card.classList.add(margin < 0
    ? "reachability-missed"
    : margin < 120 ? "reachability-tight" : "reachability-comfortable");
}

function placeCard(place) {
  const card = document.createElement("article");
  card.className = "place-card";
  const heading = document.createElement("div");
  heading.className = "place-card-heading";
  const title = document.createElement("h2");
  title.textContent = place.name;
  const distance = document.createElement("span");
  distance.className = "muted";
  distance.textContent = formatDistance(placeDistance(place)) || "—";
  const planned = journeyFor(place.id);
  const option = planned?.options?.[0];
  const stopDirections = document.createElement("button");
  stopDirections.className = "place-directions";
  stopDirections.type = "button";
  stopDirections.title = option ? `Walk to stop ${option.originStop.stopId}` : "No boarding stop available";
  stopDirections.setAttribute("aria-label", stopDirections.title);
  stopDirections.innerHTML = WALKING_ICON;
  stopDirections.disabled = !option?.originStop?.coordinates;
  stopDirections.addEventListener("click", () => openWalkingDirections(option?.originStop?.coordinates));

  const fullRoute = document.createElement("button");
  fullRoute.className = "place-directions place-transit-directions";
  fullRoute.type = "button";
  fullRoute.title = `Transit directions to ${place.name}`;
  fullRoute.setAttribute("aria-label", fullRoute.title);
  fullRoute.innerHTML = ROUTE_ICON;
  fullRoute.disabled = !myLocation;
  fullRoute.addEventListener("click", () => openTransitDirections(place));
  heading.append(title, distance, stopDirections, fullRoute);
  card.append(heading);

  const route = document.createElement("div");
  route.className = "place-route";
  if (!myLocation || !journeyPayload || !option) {
    const status = document.createElement("span");
    status.className = "place-route-status";
    status.textContent = !myLocation
      ? "Waiting for your location…"
      : !journeyPayload ? "Loading…" : "No route";
    route.append(status);
  }
  else {
    const first = document.createElement("strong");
    first.className = "place-line";
    first.style.color = lineColor(option.firstLeg.label);
    first.textContent = option.firstLeg.label;
    const copy = document.createElement("p");
    const wait = option.firstLeg.selectedArrival ?? option.firstLeg.arrivals?.[0];
    const connection = option.type === "direct"
      ? "direct"
      : `then ${option.secondLeg.label} · ${option.transfer.walkM} m transfer`;
    const origin = document.createElement("b");
    const walkMetres = option.originStop.walkMetres ?? option.originStop.distanceM;
    origin.textContent = `Stop ${option.originStop.stopId} · ${Math.round(walkMetres)} m walk`;
    const detail = document.createElement("small");
    detail.textContent = connection;
    if (option.incidents?.length) {
      const warning = document.createElement("span");
      warning.className = "route-incident";
      warning.textContent = " · ⚠ Detour";
      warning.title = option.incidents.map((incident) => incident.title).filter(Boolean).join("\n");
      detail.append(warning);
    }
    copy.append(origin, document.createElement("br"), detail);
    const eta = document.createElement("time");
    const fetchedAt = option.firstLeg.fetchedAt ?? journeyPayload.generatedAt;
    const elapsed = Math.floor((Date.now() - fetchedAt) / 1000);
    eta.className = "eta";
    eta.textContent = wait == null ? "—" : fmtCountdown(wait - elapsed);
    if (wait != null) {
      eta.dataset.seconds = String(wait);
      eta.dataset.fetchedAt = String(fetchedAt);
      eta.dataset.walkSeconds = String(option.originStop.walkSeconds ?? "");
      setPlaceReachability(card, wait - elapsed, option.originStop.walkSeconds);
    }
    route.append(first, copy, eta);
  }
  const age = document.createElement("p");
  age.className = "age";
  const fetchedAt = option?.firstLeg?.fetchedAt ?? journeyPayload?.generatedAt;
  age.textContent = fetchedAt ? `updated ${fmtAge(fetchedAt)}` : "never updated";
  if (fetchedAt) age.dataset.fetchedAt = String(fetchedAt);
  card.append(route, age);
  return card;
}

function renderPlaces() {
  const destinations = activeDestinations();
  const blocks = [];
  blocks.push(...destinations.map(placeCard));
  if (destinations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = places.length ? "No other hubs" : "No hubs saved";
    blocks.push(empty);
  }
  const nearestBikes = (bikeNear.stations ?? [])
    .filter((station) => Array.isArray(station.coordinates))
    .sort((a, b) => proximity(distanceToStation(a)) - proximity(distanceToStation(b)))
    .slice(0, NEAREST_BIKE_STATION_LIMIT);
  if (nearestBikes.length) {
    blocks.push(sectionHeading("Nearest BiciMAD"));
    for (const station of nearestBikes) {
      const bike = bikeCard(station, bikeSaved.find((row) => row.station_id === station.id) ?? null);
      bike.classList.add("place-nearest-bike");
      blocks.push(bike);
    }
  }
  listEl.replaceChildren(...blocks);
}

function renderSavedStops() {
  listEl.replaceChildren(
    ...[...stops]
      .sort((a, b) => proximity(metresFromCurrent(details[a.stop_id]?.coordinates)) -
        proximity(metresFromCurrent(details[b.stop_id]?.coordinates)))
      .map((stop) => {
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
        refreshStop(stop.stop_id, { force: true });
      });

      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove this stop";
      remove.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteStop(stop.id);
      });

      const coordinates = details[stop.stop_id]?.coordinates;
      const walking = document.createElement("button");
      walking.className = "stop-directions-icon";
      walking.innerHTML = WALKING_ICON;
      walking.title = `Walk to stop ${stop.stop_id}`;
      walking.setAttribute("aria-label", walking.title);
      walking.disabled = !coordinates;
      walking.addEventListener("click", (event) => {
        event.stopPropagation();
        openWalkingDirections(coordinates);
      });

      const list = document.createElement("ul");
      if (!cached) {
        list.innerHTML = `<li class="muted">No data yet</li>`;
      } else if (cached.arrivals.length === 0) {
        // EMT answering "no estimations" is not a failure — at night, or on a
        // daytime-only bay, it is the true answer. Saying when the first bus
        // is due turns "nothing here" into something you can act on, and makes
        // one stop's empty board legible next to another stop's full one.
        const li = document.createElement("li");
        li.className = "muted";
        li.textContent = emptyBoardText(stop.stop_id, { fetchMissing: true });
        list.replaceChildren(li);
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
          eta.dataset.seconds = String(bus.seconds);
          eta.dataset.fetchedAt = String(cached.fetchedAt);
          const destination = document.createElement("span");
          destination.className = "destination";
          destination.textContent = bus.destination || "";
          destination.hidden = !bus.destination;
          li.append(line, destination, eta);
          list.append(li);
        }
      }

      // Every rendering of arrival data carries its age. A stale number is fine;
      // a stale number without its age is not.
      const age = document.createElement("p");
      age.className = "age";
      age.textContent = cached ? `updated ${fmtAge(cached.fetchedAt)}` : "never updated";
      if (cached) age.dataset.fetchedAt = String(cached.fetchedAt);

      const controls = document.createElement("div");
      controls.className = "controls";
      controls.append(walking, refresh, remove);

      const head = document.createElement("div");
      head.className = "head";
      head.append(titleWrap, controls);

      card.append(head, list, age);
      return card;
    })
  );
}

function render() {
  const current = places.find((place) => place.enabled !== false &&
    placeDistance(place) != null && placeDistance(place) <= place.geofence_radius_m);
  headerContext.hidden = !current;
  headerContext.querySelector("span").textContent = current ? `At ${current.name}` : "";
  if (authSession && busListMode === "places") return renderPlaces();
  return renderSavedStops();
}

const pendingGets = new Map();

async function api(path, init = {}) {
  const isWrite = init.method && init.method !== "GET";
  const requestKey = isWrite ? null : `${authUser?.id ?? "public"}:${path}`;
  if (requestKey && pendingGets.has(requestKey)) return pendingGets.get(requestKey);
  const authorization = authSession?.access_token
    ? { Authorization: `Bearer ${authSession.access_token}` }
    : {};
  const operation = (async () => {
    const res = await fetch(`${API}${path}`, {
      ...init,
      headers: isWrite
        ? { "content-type": "application/json", ...authorization, ...init.headers }
        : { ...authorization, ...init.headers },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(body.message || body.error || `HTTP ${res.status}`);
      err.kind = body.error; // "quota" | "auth" | "not_found" | "upstream"
      if (err.kind === "user_auth") showSignedOut("Session expired — sign in again.");
      throw err;
    }
    return res.status === 204 ? null : res.json();
  })();
  if (requestKey) pendingGets.set(requestKey, operation);
  try {
    return await operation;
  } finally {
    if (requestKey && pendingGets.get(requestKey) === operation) pendingGets.delete(requestKey);
  }
}

function showSignedOut(message = "") {
  authSession = null;
  authUser = null;
  isOwner = false;
  setUserCacheScope(null);
  stops = [];
  places = [];
  journeyPayload = null;
  bikeSaved = [];
  resetBikePrivateState();
  authButton.textContent = "Sign in";
  authButton.title = "Sign in with an email link";
  authButton.setAttribute("aria-label", "Sign in");
  if (accountMenu.open) accountMenu.close();
  fab.hidden = true;
  bikeAccountEl.hidden = true;
  render();
  renderBikes();
  if (message) statusEl.textContent = message;
}

async function applySession(session) {
  if (!session) return showSignedOut();
  if (authSession?.access_token === session.access_token && authUser) return;
  authSession = session;
  authUser = session.user;
  setUserCacheScope(authUser.id);
  resetBikePrivateState();
  stops = readStops();
  bikeSaved = readBikeSaved();
  authButton.textContent = "☰";
  authButton.title = "Account menu";
  authButton.setAttribute("aria-label", "Open account menu");
  accountMenuEmail.textContent = authUser.email || "Signed in";
  fab.hidden = section === "bikes";
  render();
  renderBikes();

  try {
    const me = await api("/auth/me");
    isOwner = me.owner === true;
  } catch {
    isOwner = false;
  }
  bikeAccountEl.hidden = section !== "bikes" || !isOwner;
  if (isOwner) showCachedBikeAccount();
  await Promise.all([loadStops(), loadBikeSaved(), loadPlaces()]);
}

async function loadPlaces() {
  if (!authSession) return;
  try {
    places = await api("/places");
    render();
    scheduleJourneys({ force: true });
    renderPlacesDialog();
  } catch (err) {
    // The migration is deliberately non-breaking: saved stops remain the UI
    // until places.sql has been applied.
    statusEl.textContent = `Hubs unavailable: ${err.message}`;
    render();
  }
}

let journeyLoad = null;

async function loadJourneys({ force = false } = {}) {
  if (journeyLoad) return journeyLoad;
  if (!authSession || !myLocation || places.length === 0) return;
  const destinations = activeDestinations();
  if (destinations.length === 0) return;
  const cell = `${myLocation[0].toFixed(3)},${myLocation[1].toFixed(3)}`;
  if (!force && cell === journeyCell && Date.now() - journeyLoadedAt < 60_000) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25_000);
  const operation = (async () => { try {
    const batches = [];
    for (let index = 0; index < destinations.length; index += JOURNEY_BATCH_SIZE) {
      batches.push(destinations.slice(index, index + JOURNEY_BATCH_SIZE));
    }
    const payloads = await Promise.all(batches.map((batch) => api("/journeys", {
      method: "POST",
      signal: controller.signal,
      body: JSON.stringify({
        origin: { lat: myLocation[0], lon: myLocation[1] },
        destinations: batch.map((place) => ({
          id: place.id, name: place.name, lat: place.lat, lon: place.lon,
          destinationRadiusM: place.destination_radius_m,
        })),
      }),
    })));
    journeyPayload = {
      origin: payloads[0]?.origin,
      destinations: payloads.flatMap((payload) => payload.destinations ?? []),
      generatedAt: Math.max(...payloads.map((payload) => payload.generatedAt ?? 0)),
      calls: payloads.reduce((total, payload) => {
        for (const [key, value] of Object.entries(payload.calls ?? {})) {
          total[key] = (total[key] ?? 0) + Number(value ?? 0);
        }
        return total;
      }, {}),
    };
    journeyCell = cell;
    journeyLoadedAt = Date.now();
    render();
  } catch (err) {
    statusEl.textContent = err.name === "AbortError"
      ? "Journey request timed out"
      : `Could not plan journeys: ${err.message}`;
  } finally {
    clearTimeout(timeout);
  } })();
  journeyLoad = operation;
  try {
    return await operation;
  } finally {
    if (journeyLoad === operation) journeyLoad = null;
  }
}

function scheduleJourneys({ force = false } = {}) {
  if (journeyTimer != null) clearTimeout(journeyTimer);
  journeyTimer = setTimeout(() => { journeyTimer = null; void loadJourneys({ force }); }, 250);
}

async function initAuth() {
  try {
    const config = await api("/auth/config");
    authClient = window.supabase.createClient(config.url, config.anonKey);
    const { data, error } = await authClient.auth.getSession();
    if (error) throw error;
    await applySession(data.session);
    authClient.auth.onAuthStateChange((_event, session) => {
      // The callback must return immediately: Supabase warns against awaiting
      // more auth methods while its internal session lock is held.
      setTimeout(() => { void applySession(session); }, 0);
    });
  } catch (err) {
    showSignedOut(`Could not initialize sign-in: ${err.message}`);
  }
}

authButton.addEventListener("click", async () => {
  if (authSession) {
    accountMenu.showModal();
    return;
  }
  authMessage.textContent = "";
  authDialog.showModal();
});

accountSignout.addEventListener("click", async () => {
  accountSignout.disabled = true;
  try {
    await authClient.auth.signOut();
  } finally {
    accountSignout.disabled = false;
    if (accountMenu.open) accountMenu.close();
  }
});

function renderPlacesDialog() {
  placesList.replaceChildren(...places.map((place) => {
    const row = document.createElement("div");
    row.className = "place-manage-row";
    const label = document.createElement("span");
    const name = document.createElement("b");
    name.textContent = place.name;
    const coordinates = document.createElement("small");
    coordinates.textContent = `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
    label.append(name, coordinates);
    const actions = document.createElement("div");
    actions.className = "place-manage-actions";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.textContent = "✎";
    edit.setAttribute("aria-label", `Edit ${place.name}`);
    edit.addEventListener("click", () => openPlaceEditor(place));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${place.name}`);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await api(`/places/${encodeURIComponent(place.id)}`, { method: "DELETE" });
        places = places.filter((item) => item.id !== place.id);
        journeyPayload = null;
        renderPlacesDialog();
        render();
        scheduleJourneys({ force: true });
      } catch (err) {
        placesMessage.textContent = `Could not delete hub: ${err.message}`;
        remove.disabled = false;
      }
    });
    actions.append(edit, remove);
    row.append(label, actions);
    return row;
  }));
}

function setPlacePin(lat, lon, { recenter = true } = {}) {
  const point = [Number(lat), Number(lon)];
  if (!point.every(Number.isFinite)) return;
  placeDraft = { ...(placeDraft ?? {}), lat: point[0], lon: point[1] };
  if (!placePickerMarker) {
    placePickerMarker = L.marker(point, { draggable: true }).addTo(placePickerMap);
    placePickerMarker.on("dragend", () => {
      const moved = placePickerMarker.getLatLng();
      setPlacePin(moved.lat, moved.lng, { recenter: false });
    });
  } else {
    placePickerMarker.setLatLng(point);
  }
  if (recenter) placePickerMap.setView(point, 17);
  placePicked.textContent = `Pin: ${point[0].toFixed(5)}, ${point[1].toFixed(5)}`;
}

function ensurePlacePicker() {
  if (!placePickerMap) {
    placePickerMap = L.map("place-picker-map", { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(placePickerMap);
    placePickerMap.on("click", ({ latlng }) => setPlacePin(latlng.lat, latlng.lng, { recenter: false }));
  }
  requestAnimationFrame(() => {
    placePickerMap.invalidateSize();
    const initial = placeDraft?.lat != null
      ? [placeDraft.lat, placeDraft.lon]
      : myLocation ?? [40.4168, -3.7038];
    setPlacePin(initial[0], initial[1]);
  });
}

function closePlaceEditor() {
  placeEditor.hidden = true;
  document.getElementById("place-editor-open").hidden = false;
  placeSearchResults.replaceChildren();
  placeDraft = null;
}

function openPlaceEditor(place = null) {
  placeDraft = place ? { ...place } : null;
  document.getElementById("place-name").value = place?.name ?? "";
  document.getElementById("place-address").value = place?.address ?? "";
  document.getElementById("place-add").textContent = place ? "Save changes" : "Save hub";
  placeSearchResults.replaceChildren();
  placesMessage.textContent = "";
  placeEditor.hidden = false;
  document.getElementById("place-editor-open").hidden = true;
  ensurePlacePicker();
}

document.getElementById("manage-places").addEventListener("click", () => {
  accountMenu.close();
  placesMessage.textContent = "";
  renderPlacesDialog();
  placesDialog.showModal();
});
document.getElementById("places-close").addEventListener("click", () => {
  closePlaceEditor();
  placesDialog.close();
});
document.getElementById("place-editor-open").addEventListener("click", () => openPlaceEditor());
document.getElementById("place-editor-cancel").addEventListener("click", closePlaceEditor);
document.getElementById("place-gps").addEventListener("click", () => {
  if (myLocation) setPlacePin(myLocation[0], myLocation[1]);
  else placesMessage.textContent = "GPS has not returned a location yet.";
});
document.getElementById("place-search").addEventListener("click", async () => {
  const input = document.getElementById("place-address");
  const query = input.value.trim();
  if (query.length < 3) return;
  const button = document.getElementById("place-search");
  button.disabled = true;
  placesMessage.textContent = "Searching Madrid…";
  try {
    const results = await api(`/places/geocode?q=${encodeURIComponent(query)}`);
    placeSearchResults.replaceChildren(...results.map((result) => {
      const choice = document.createElement("button");
      choice.type = "button";
      choice.textContent = result.displayName;
      choice.addEventListener("click", () => {
        input.value = result.displayName;
        placeDraft = { ...(placeDraft ?? {}), address: result.displayName };
        setPlacePin(result.lat, result.lon);
        placeSearchResults.replaceChildren();
      });
      return choice;
    }));
    placesMessage.textContent = results.length ? "" : "No address found";
  } catch (err) {
    placesMessage.textContent = `Could not search addresses: ${err.message}`;
  } finally {
    button.disabled = false;
  }
});
placesForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.getElementById("place-name").value.trim();
  if (!name) return;
  if (!placeDraft || !Number.isFinite(placeDraft.lat) || !Number.isFinite(placeDraft.lon)) {
    placesMessage.textContent = "Pin required";
    return;
  }
  const add = document.getElementById("place-add");
  add.disabled = true;
  try {
    const editingId = placeDraft.id;
    const place = await api(editingId ? `/places/${encodeURIComponent(editingId)}` : "/places", {
      method: editingId ? "PATCH" : "POST",
      body: JSON.stringify({
        name, address: document.getElementById("place-address").value.trim() || null,
        lat: placeDraft.lat, lon: placeDraft.lon,
      }),
    });
    if (editingId) places = places.map((item) => item.id === editingId ? place : item);
    else places.push(place);
    document.getElementById("place-name").value = "";
    journeyPayload = null;
    placesMessage.textContent = `${place.name} saved.`;
    renderPlacesDialog();
    render();
    scheduleJourneys({ force: true });
    closePlaceEditor();
  } catch (err) {
    placesMessage.textContent = `Could not save hub: ${err.message}`;
  } finally {
    add.disabled = false;
  }
});

document.getElementById("auth-cancel").addEventListener("click", () => authDialog.close());

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = authEmail.value.trim();
  if (!email || !authClient) return;
  document.getElementById("auth-send").disabled = true;
  authMessage.textContent = "Sending…";
  const { error } = await authClient.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: `${location.origin}${location.pathname}`,
      // The link verifies email ownership before Supabase creates the user.
      // First-time sign-up and returning sign-in can therefore share one flow.
      shouldCreateUser: true,
    },
  });
  document.getElementById("auth-send").disabled = false;
  authMessage.textContent = error
    ? error.message
    : "Check your email for the secure sign-in link.";
});

const ARRIVALS_REFRESH_MS = 20_000;
const stopRefreshes = new Map();

async function refreshStop(stopId, { force = false, updateView = true, persist = true } = {}) {
  const cached = arrivals[stopId];
  if (!force && cached && Date.now() - cached.fetchedAt < ARRIVALS_REFRESH_MS) return cached;
  if (stopRefreshes.has(stopId)) return stopRefreshes.get(stopId);
  const operation = (async () => {
    try {
      const payload = await api(
        `/arrivals?stop=${encodeURIComponent(stopId)}&limit=${BOARD_ARRIVALS}`
      );
      arrivals[stopId] = payload;
      if (persist) writeCache(stopId, payload);
      statusEl.textContent = "";
      if (updateView) {
        render();
        renderSheetArrivals();
      }
      return payload;
    } catch (err) {
      // Keep whatever is on screen; it is labelled with its age already.
      statusEl.textContent =
        err.kind === "quota"
          ? "EMT daily quota spent — showing cached times until it resets."
          : `Could not refresh stop ${stopId}: ${err.message}`;
      return null;
    }
  })();
  stopRefreshes.set(stopId, operation);
  try {
    return await operation;
  } finally {
    if (stopRefreshes.get(stopId) === operation) stopRefreshes.delete(stopId);
  }
}

async function refreshAll({ force = false } = {}) {
  const before = new Map(stops.map((stop) => [stop.stop_id, arrivals[stop.stop_id]?.fetchedAt]));
  await Promise.all(stops.map((s) => refreshStop(s.stop_id, {
    force,
    updateView: false,
    persist: false,
  })));
  const changed = stops.some((stop) => before.get(stop.stop_id) !== arrivals[stop.stop_id]?.fetchedAt);
  if (!changed) return;
  writeArrivalCache(arrivals);
  render();
  renderSheetArrivals();
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
  const origins = [];
  for (const stop of stops) {
    const coords = details[stop.stop_id]?.coordinates;
    if (!coords) continue;
    // One 500m search covers a whole stop cluster. The old 110m grid could
    // issue several heavily-overlapping queries around the same interchange.
    if (origins.some((origin) => metresBetweenCoordinates(origin, coords) < 350)) continue;
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
let busUserMarker = null;
let nearbyCell = null;
let nearbyStops = [];
let nearbySeq = 0;
let closestWalking = new Map();
let closestWalkingOrigin = null;

const NEARBY_RADIUS = 700;

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

  // One direction at a time, cycling out → back → off. Drawn together the two
  // run along the same streets, so whichever is on top hides the other and the
  // arrows point both ways a few pixels apart.
  const current = shownRoutes.get(code);
  const next = !current ? "toA" : current.direction === "toA" ? "toB" : null;
  if (current) {
    routeLayer.removeLayer(current.layer);
    shownRoutes.delete(code);
    if (!next) {
      renderRouteLegend();
      return;
    }
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
  if (shownRoutes.has(code)) return; // toggled again while loading

  const color = lineColor(label);
  const segments = route.paths?.[next] ?? [];
  // featureGroup, not layerGroup: only this one can report its own bounds.
  const group = L.featureGroup();
  if (segments.length) {
    // GeoJSON order is [lon, lat]; Leaflet wants [lat, lon].
    const latlngs = segments.map((seg) => seg.map(([lon, lat]) => [lat, lon]));
    L.polyline(latlngs, {
      color,
      weight: 5,
      opacity: 0.9,
      // Decoration, not a target: an interactive line would swallow taps meant
      // for the stop pins it runs through.
      interactive: false,
    }).addTo(group);
    addDirectionArrows(group, segments, color);
  }
  addRouteStops(group, route.stops?.[next] ?? [], color);
  group.addTo(routeLayer);
  shownRoutes.set(code, {
    layer: group,
    label,
    direction: next,
    towards: next === "toA" ? route.nameA : route.nameB,
  });
  renderRouteLegend();

  // Drawing a route you can only see a tenth of is not showing it. The legend
  // chip is how you get rid of it again.
  const bounds = group.getBounds();
  if (bounds.isValid()) leafletMap.fitBounds(bounds.pad(0.08));
}

/** EMT's segments chain end to start, so concatenating them gives the path in
 *  travel order — which is what tells us which way the arrows point. */
function orderedPoints(segments) {
  const points = [];
  for (const seg of segments ?? []) {
    for (const pair of seg) {
      const last = points[points.length - 1];
      if (!last || last[0] !== pair[0] || last[1] !== pair[1]) points.push(pair);
    }
  }
  return points;
}

const ARROWS_PER_ROUTE = 12;

/** Arrowheads along the path, pointing the way the bus goes.
 *
 * Solid-versus-dashed is not readable at the zoom a phone map sits at, and the
 * two directions usually run along the same street anyway, one hiding the
 * other. An arrow says which way without depending on either.
 */
function addDirectionArrows(group, segments, color) {
  const points = orderedPoints(segments);
  if (points.length < 2) return;
  const step = Math.max(1, Math.floor(points.length / ARROWS_PER_ROUTE));

  for (let i = 0; i + 1 < points.length; i += step) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[i + 1];
    // Bearing in screen terms: longitude degrees shrink with latitude, and the
    // glyph points north at 0.
    const dx = (lon2 - lon1) * Math.cos((lat1 * Math.PI) / 180);
    const dy = lat2 - lat1;
    if (dx === 0 && dy === 0) continue;
    const angle = (Math.atan2(dx, dy) * 180) / Math.PI;

    const icon = L.divIcon({
      className: "route-arrow",
      iconSize: [16, 16],
      iconAnchor: [8, 8],
      html:
        `<svg viewBox="0 0 16 16" width="16" height="16" ` +
        `style="transform: rotate(${angle.toFixed(1)}deg)">` +
        `<path d="M8 1 L14 14 L8 11 L2 14 Z" fill="${color}" ` +
        // A thin dark edge keeps the arrow legible over pale map tiles without
        // eating the fill that identifies the line.
        `stroke="#0d0f14" stroke-width="0.9" stroke-linejoin="round"/></svg>`,
    });
    L.marker([lat1, lon1], { icon, interactive: false, keyboard: false }).addTo(group);
  }
}

/** Every stop the line calls at, drawn as small dots along its route.
 *
 * These come in the same payload as the geometry, so showing them costs no
 * extra request. Only the direction on screen is drawn, and saved stops are
 * skipped — they have their own pin already.
 */
function addRouteStops(group, stops, color) {
  const saved = savedIds();
  const seen = new Set();
  for (const stop of stops) {
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
    ...[...shownRoutes].map(([code, { label, towards }]) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "route-chip";
      // Where this direction ends up — the point of showing one at a time.
      chip.textContent = towards ? `${label} → ${towards} ×` : `${label} ×`;
      chip.style.borderColor = lineColor(label);
      chip.style.color = lineColor(label);
      chip.title = `Next tap: the other direction, then off`;
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
    const drawn = shownRoutes.get(l.line);
    chip.className = drawn ? "line-chip on" : "line-chip";
    chip.textContent = drawn?.towards ? `${l.label} → ${drawn.towards}` : l.label;
    chip.style.color = lineColor(l.label);
    chip.style.borderColor = lineColor(l.label);
    chip.title = drawn ? `Route ${l.label}: other direction, then off` : `Show route ${l.label}`;
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
    li.textContent = cached ? emptyBoardText(stop.stop_id) : "No data yet";
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
  if (myLocation) busUserMarker = addUserMarker(leafletMap, myLocation);
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
  viewListBtn.setAttribute("aria-selected", String(!isMap));
  viewMapBtn.setAttribute("aria-selected", String(isMap));
  // List/Map applies to whichever section is open; the menu decides which.
  if (section === "bikes") {
    showSection("bikes");
    return;
  }
  listEl.hidden = isMap;
  mapEl.hidden = !isMap;
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
  syncMapControls();
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
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = emptyBoardText(s.stopId);
    ul.replaceChildren(li);
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

/** Load stops around an explicit point so location can update the bus data
 * even while the bike section (or list view) is on screen. */
async function loadNearbyAt(lat, lon, { force = false } = {}) {
  const cell = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!force && cell === nearbyCell) return;
  const seq = ++nearbySeq;
  try {
    const found = await api(
      `/stops/nearby?lat=${lat}&lon=${lon}&radius=${NEARBY_RADIUS}`
    );
    if (seq !== nearbySeq) return; // a newer pan superseded this request
    nearbyStops = found.sort((a, b) =>
      proximity(metresFromCurrent(a.coordinates)) - proximity(metresFromCurrent(b.coordinates)));
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

function closestStops() {
  return [...nearbyStops].sort((a, b) =>
    proximity(closestWalking.get(String(a.stopId))?.metres ?? metresFromCurrent(a.coordinates)) -
    proximity(closestWalking.get(String(b.stopId))?.metres ?? metresFromCurrent(b.coordinates))).slice(0, 8);
}

function nearbyStopCard(stop) {
    const card = document.createElement("article");
    card.className = "nearby-stop-card";
    const head = document.createElement("div");
    const name = document.createElement("b");
    name.textContent = stop.name || `Stop ${stop.stopId}`;
    const meta = document.createElement("small");
    const lineLabels = (stop.lines ?? []).map(normaliseLine).map((line) => line.label).filter(Boolean);
    const walk = closestWalking.get(String(stop.stopId));
    meta.textContent = `Nº ${stop.stopId}${walk?.metres != null ? ` · ${formatDistance(walk.metres)}` : ""}${lineLabels.length ? ` · ${lineLabels.join(" · ")}` : ""}`;
    head.append(name, meta);
    const actions = document.createElement("div");
    const directions = document.createElement("button");
    directions.type = "button";
    directions.innerHTML = WALKING_ICON;
    directions.title = `Directions to stop ${stop.stopId}`;
    directions.setAttribute("aria-label", directions.title);
    directions.addEventListener("click", () => openWalkingDirections(stop.coordinates));
    const saved = stops.find((row) => row.stop_id === String(stop.stopId));
    const save = document.createElement("button");
    save.type = "button";
    save.className = "nearby-stop-favourite";
    save.textContent = saved ? "★" : "☆";
    save.title = saved ? `Remove stop ${stop.stopId} from saved` : `Save stop ${stop.stopId}`;
    save.setAttribute("aria-label", save.title);
    save.addEventListener("click", async () => {
      save.disabled = true;
      try {
        if (saved) await deleteStop(saved.id);
        else await addStopById(String(stop.stopId), stop.name, stop);
        renderClosestStopsDialog();
      } catch {
        save.disabled = false;
      }
    });
    actions.append(directions, save);
    card.append(head, actions);
    return card;
}

let addStopMap = null;
let addStopMapMarkers = null;

function renderAddStopMap() {
  if (!addDialog.open || !myLocation) return;
  if (!addStopMap) {
    addStopMap = L.map(addStopMapEl, { zoomControl: true, attributionControl: false });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(addStopMap);
    addStopMapMarkers = L.layerGroup().addTo(addStopMap);
  }
  addStopMapMarkers.clearLayers();
  L.circleMarker(myLocation, {
    radius: 7, color: "#fff", weight: 3, fillColor: "#4ea3ff", fillOpacity: 1,
  }).bindTooltip("You").addTo(addStopMapMarkers);
  const saved = savedIds();
  for (const stop of closestStops()) {
    if (!Array.isArray(stop.coordinates)) continue;
    L.circleMarker([stop.coordinates[1], stop.coordinates[0]], {
      radius: 7,
      color: saved.has(String(stop.stopId)) ? "#ffbf3f" : "#8b93a7",
      weight: 2,
      fillColor: "#202631",
      fillOpacity: 1,
    }).bindTooltip(`${stop.stopId} · ${stop.name || "Stop"}`).addTo(addStopMapMarkers);
  }
  addStopMap.setView(myLocation, 15);
  requestAnimationFrame(() => addStopMap.invalidateSize());
}

function renderClosestStopsDialog() {
  const waiting = !myLocation;
  const closest = waiting ? [] : closestStops();
  const message = waiting ? "Finding your location…" : closest.length ? "" : "No stops within 700 m";
  nearbyStopsMessage.textContent = message;
  addStopMessage.textContent = message;
  nearbyStopsList.replaceChildren(...closest.map(nearbyStopCard));
  addStopNearbyList.replaceChildren(...closest.map(nearbyStopCard));
  renderAddStopMap();
}

async function updateClosestStopsDialog() {
  if ((!nearbyStopsDialog.open && !addDialog.open) || !myLocation) return;
  nearbyStopsMessage.textContent = "Finding nearby stops…";
  addStopMessage.textContent = "Finding nearby stops…";
  await loadNearbyAt(myLocation[0], myLocation[1], { force: true });
  const originKey = `${myLocation[0].toFixed(5)},${myLocation[1].toFixed(5)}`;
  if (closestWalkingOrigin !== originKey) {
    closestWalkingOrigin = originKey;
    closestWalking = new Map();
  }
  renderClosestStopsDialog();
  const candidates = [...nearbyStops]
    .filter((stop) => Array.isArray(stop.coordinates))
    .sort((a, b) => proximity(metresFromCurrent(a.coordinates)) - proximity(metresFromCurrent(b.coordinates)))
    .slice(0, 20);
  if (candidates.length === 0) return;
  try {
    const payload = await api("/walking-distances", {
      method: "POST",
      body: JSON.stringify({
        origin: { lat: myLocation[0], lon: myLocation[1] },
        destinations: candidates.map((stop) => ({
          lat: stop.coordinates[1], lon: stop.coordinates[0],
        })),
      }),
    });
    if (closestWalkingOrigin !== originKey) return;
    closestWalking = new Map(candidates.map((stop, index) =>
      [String(stop.stopId), payload.routes[index]]));
    renderClosestStopsDialog();
  } catch {
    // With no pedestrian route, omit distance rather than relabel air distance.
  }
}

document.getElementById("nearby-stops-open").addEventListener("click", () => {
  nearbyStopsDialog.showModal();
  if (!myLocation) {
    renderClosestStopsDialog();
    refreshLocation({ userInitiated: true, forceNearby: true });
  } else {
    nearbyStopsMessage.textContent = "Loading…";
    nearbyStopsList.replaceChildren();
    void updateClosestStopsDialog();
  }
});
document.getElementById("nearby-stops-close").addEventListener("click", () => nearbyStopsDialog.close());

/** Load stops within 500m of the map centre; one fetch per ~110m cell. */
async function loadNearby() {
  if (!leafletMap || mapEl.hidden) return;
  const centre = leafletMap.getCenter();
  return loadNearbyAt(centre.lat, centre.lng);
}

viewListBtn.addEventListener("click", () => showView("list"));
viewMapBtn.addEventListener("click", () => showView("map"));

function setBusListMode(mode) {
  busListMode = mode === "stops" ? "stops" : "places";
  localStorage.setItem("emt:bus-list-mode", busListMode);
  busModePlaces.setAttribute("aria-selected", String(busListMode === "places"));
  busModeStops.setAttribute("aria-selected", String(busListMode === "stops"));
  const button = document.getElementById("fab");
  const purpose = busListMode === "places" ? "Add hub" : "Add bus stop";
  button.title = purpose;
  button.setAttribute("aria-label", purpose);
  render();
}
busModePlaces.addEventListener("click", () => {
  showSection("buses");
  setBusListMode("places");
});
busModeStops.addEventListener("click", () => {
  showSection("buses");
  setBusListMode("stops");
});
setBusListMode(busListMode);

async function loadStops() {
  if (!authSession) return;
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
const sheetDirections = document.getElementById("sheet-directions");

let sheetStop = null;
let sheetMap = null;
let sheetMarker = null;

function openStop(stop) {
  sheetStop = stop;
  sheetHeading.textContent = stopTitle(stop);
  sheetMeta.replaceChildren(stopMetaNode(stop.stop_id));
  sheetLabel.value = stop.label ?? "";
  sheetLabel.placeholder = details[stop.stop_id]?.name || "EMT's name";
  sheetDirections.hidden = !details[stop.stop_id]?.coordinates;
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
    li.textContent = cached
      ? emptyBoardText(sheetStop.stop_id, { fetchMissing: true })
      : "No data yet";
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
  render();
  if (stopDialog.open) {
    renderSheetService();
    renderSheetArrivals();
  }
}

function renderSheetService() {
  if (!sheetStop) return;
  const lines = stopLines(sheetStop.stop_id);
  sheetServiceWrap.hidden = lines.length === 0;
  const today = todayDayType();

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
sheetDirections.addEventListener("click", () => {
  openWalkingDirections(details[sheetStop?.stop_id]?.coordinates);
});
document.getElementById("sheet-refresh").addEventListener("click", () =>
  refreshStop(sheetStop.stop_id, { force: true })
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
  if (busListMode === "places") {
    placesMessage.textContent = "";
    renderPlacesDialog();
    placesDialog.showModal();
    openPlaceEditor();
    return;
  }
  addDialog.showModal();
  renderClosestStopsDialog();
  if (!myLocation) refreshLocation({ userInitiated: true, forceNearby: true });
  else void updateClosestStopsDialog();
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

document.getElementById("refresh-all").addEventListener("click", () => {
  if (section !== "bikes") {
    return busListMode === "places" ? loadJourneys({ force: true }) : refreshAll({ force: true });
  }
  const c = bikeMap?.getCenter();
  loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038, {
    force: true,
  });
});

function tickStopList() {
  const now = Date.now();
  for (const eta of listEl.querySelectorAll(".eta[data-seconds][data-fetched-at]")) {
    const elapsed = Math.floor((now - Number(eta.dataset.fetchedAt)) / 1000);
    const remaining = Number(eta.dataset.seconds) - elapsed;
    eta.textContent = fmtCountdown(remaining);
    if (eta.dataset.walkSeconds) {
      const card = eta.closest(".place-card");
      if (card) setPlaceReachability(card, remaining, eta.dataset.walkSeconds);
    }
  }
  for (const age of listEl.querySelectorAll(".age[data-fetched-at]")) {
    age.textContent = `updated ${fmtAge(Number(age.dataset.fetchedAt))}`;
  }
}

// Update only time-bearing text. Rebuilding every card once a second caused
// needless layout, garbage collection and event-listener churn.
setInterval(() => {
  if (section === "bikes") {
    bikeAgeEl.textContent = bikeAgeText();
    return;
  }
  if (mapEl.hidden) tickStopList();
  tickPopups();
  renderSheetArrivals();
}, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") {
    stopLocationRefresh();
    return;
  }
  startLocationRefresh();
  if (section === "bikes") {
    const c = bikeMap?.getCenter();
    loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038);
  } else {
    if (busListMode === "places") loadJourneys();
    else refreshAll();
  }
});

render();

/* ---- BiciMAD ------------------------------------------------------------ */

const bikesEl = document.getElementById("bikes");
const bikeMapEl = document.getElementById("bike-map");
const bikeAgeEl = document.getElementById("bike-age");
const locateBtn = document.getElementById("locate");
const bikeAccountEl = document.getElementById("bike-account");
const bikeAccountDot = document.getElementById("bike-account-dot");
const bikeAccountText = document.getElementById("bike-account-text");
const bikeAccountCheck = document.getElementById("bike-account-check");
const bikeTripsOpen = document.getElementById("bike-trips-open");
const mapActions = document.getElementById("map-actions");
const mapFullscreenBtn = document.getElementById("map-fullscreen");

const BIKE_RADIUS = 700;

let section = "buses";
let bikeSaved = [];
let bikeNear = readBikeNear(); // last-known counts, so the list never starts empty
let bikeFetchedAt = bikeNear.fetchedAt ?? null;
let bikeMap = null;
let bikeMarkers = null;
let pendingBikePopupId = null;
let bikeCell = null;
let bikeSeq = 0;
let bikeUserMarker = null;
// Live counts by station id, from whichever call last saw them: the nearby
// sweep, or the by-ids lookup that keeps saved stations current even when
// they are nowhere near the map.
const bikeById = new Map();
function showBikeAccount(text, tone = "") {
  bikeAccountText.textContent = text;
  bikeAccountDot.className = `bike-account-dot${tone ? ` ${tone}` : ""}`;
}

function renderBikeAccountStatus(payload) {
  const age = payload?.checkedAt ? ` · checked ${fmtAge(payload.checkedAt)}` : "";
  if (payload?.blocked) {
    showBikeAccount(`Account blocked by BiciMAD${age}`, "blocked");
  } else if (!payload?.accountEnabled || !payload?.activeContract) {
    showBikeAccount(`Account not ready to rent${age}`, "warn");
  } else {
    showBikeAccount(`Account active · not blocked${age}`, "ready");
  }
}

function showCachedBikeAccount() {
  const cached = readBikeAccount();
  if (cached) renderBikeAccountStatus(cached);
  else showBikeAccount("Account status not checked");
}

async function loadBikeAccount({ force = false } = {}) {
  if (!force) {
    const cached = readBikeAccount();
    if (cached) {
      renderBikeAccountStatus(cached);
      return;
    }
  }
  bikeAccountCheck.disabled = true;
  showBikeAccount("Checking account…");
  try {
    const payload = await api(`/bikes/account${force ? "?refresh=1" : ""}`);
    writeBikeAccount(payload);
    renderBikeAccountStatus(payload);
  } catch (err) {
    if (err.kind === "auth") {
      showBikeAccount("BiciMAD session expired", "warn");
    } else if (err.kind === "forbidden") {
      showBikeAccount("Account status is owner-only", "warn");
    } else {
      showBikeAccount("Account status unavailable", "warn");
    }
  } finally {
    bikeAccountCheck.disabled = false;
  }
}

bikeAccountCheck.addEventListener("click", () => loadBikeAccount({ force: true }));

const bikeTripsDialog = document.getElementById("bike-trips-dialog");
const bikeTripsForm = document.getElementById("bike-trips-form");
const bikeTripsNumber = document.getElementById("bike-trips-number");
const bikeTripsStatus = document.getElementById("bike-trips-status");
const bikeTripsResults = document.getElementById("bike-trips-results");
const bikeTripsChronological = document.getElementById("bike-trips-chronological");
const bikeTripsGrouped = document.getElementById("bike-trips-grouped");
const bikeTripsRefresh = document.getElementById("bike-trips-refresh");
const bikeTripsSearch = document.getElementById("bike-trips-search");
let loadedBikeTrips = [];
let allBikeTrips = null;
let bikeTripPages = 0;
let bikeTripFieldsSeen = [];
let bikeRatingsLoaded = false;
let bikeTripsSynced = false;
let bikeTripsSync = null;
let bikeTripsCachedAt = null;
let groupBikeTrips = false;
let bikeTripDiagnostics = {};
let bikeTripDiagnosticsLoaded = false;
const bikeRatings = new Map();

function resetBikePrivateState() {
  loadedBikeTrips = [];
  allBikeTrips = null;
  bikeTripPages = 0;
  bikeTripFieldsSeen = [];
  bikeRatingsLoaded = false;
  bikeTripsSynced = false;
  bikeTripsSync = null;
  bikeTripsCachedAt = null;
  bikeTripDiagnostics = {};
  bikeTripDiagnosticsLoaded = false;
  bikeRatings.clear();
}

function euro(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(numeric)
    : null;
}

function tripDate(value, { timeOnly = false } = {}) {
  if (value == null || value === "") return null;
  let date;
  if (typeof value === "number") {
    date = new Date(value < 10_000_000_000 ? value * 1000 : value);
  } else {
    const text = String(value).trim();
    const local = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/);
    const timezoneLessIso = /^\d{4}-\d{2}-\d{2}T\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/.test(text);
    date = local
      ? new Date(Number(local[3]), Number(local[2]) - 1, Number(local[1]),
        Number(local[4]), Number(local[5]), Number(local[6] || 0))
      : new Date(timezoneLessIso ? `${text}Z` : text);
  }
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, timeOnly ? {
    hour: "2-digit",
    minute: "2-digit",
  } : {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function renderTripRow(trip) {
  const shownBikeNumber = trip.bikeNumber == null
    ? null
    : String(trip.bikeNumber).replace(/^0+(?=\d)/, "");
  const row = document.createElement("div");
  row.className = "trip-row";
  const started = tripDate(trip.startedAt);
  const ended = tripDate(trip.endedAt, { timeOnly: true });
  if (started || ended) {
    const dates = document.createElement("span");
    dates.className = "trip-dates";
    dates.textContent = `${started ?? "Start unavailable"} → ${ended ?? "End unavailable"}`;
    row.append(dates);
  }
  const timing = document.createElement("span");
  timing.textContent = [trip.interval, trip.minutes == null ? null : `${trip.minutes} min`]
    .filter(Boolean).join(" · ") || "Time unavailable";
  const money = document.createElement("span");
  money.textContent = euro(trip.cost) ?? "Cost unavailable";
  row.append(timing, money);
  if (Number(trip.penaltyCount) || Number(trip.penaltyAmount)) {
    const penalty = document.createElement("span");
    penalty.className = "warn";
    penalty.textContent = `Penalty: ${trip.penaltyCount || 0} · ${euro(trip.penaltyAmount) ?? trip.penaltyAmount ?? 0}`;
    row.append(penalty);
  }
  if (trip.lockFailed || trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed) {
    const incident = document.createElement("span");
    incident.className = "warn";
    incident.textContent = trip.lockFailed ? "Lock failed" : "Dock event recorded";
    row.append(incident);
  }
  return row;
}

function hasTripIssue(trip) {
  return Boolean(Number(trip.penaltyCount) || Number(trip.penaltyAmount) ||
    trip.lockFailed || trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed);
}

function diagnosticValue(field, value) {
  if (value == null || value === "") return "—";
  if ([
    "cost", "previousBalance", "resultingBalance", "dockBonus", "undockBonus",
    "reservationBonus", "penaltyAmount", "extraAmount",
  ].includes(field)) {
    return euro(value) ?? String(value);
  }
  if (["startedAt", "endedAt", "extraDate"].includes(field)) return tripDate(value) ?? String(value);
  if (field === "minutes") return `${value} min`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function renderTripDiagnostics(trip) {
  const entry = bikeTripDiagnostics[tripIdentity(trip)];
  if (!entry?.revisions?.length) return null;
  const history = document.createElement("details");
  history.className = "trip-history";
  const summary = document.createElement("summary");
  summary.textContent = `Updated by EMT · ${entry.revisions.length}`;
  const list = document.createElement("div");
  for (const revision of [...entry.revisions].reverse()) {
    const item = document.createElement("div");
    item.className = "trip-history-revision";
    const observed = new Date(revision.observedAt);
    const time = document.createElement("time");
    time.dateTime = observed.toISOString();
    time.textContent = new Intl.DateTimeFormat(undefined, {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
    }).format(observed);
    const changes = document.createElement("span");
    changes.textContent = revision.changes.map((change) =>
      `${TRIP_DIAGNOSTIC_LABELS[change.field] ?? change.field}: `
      + `${diagnosticValue(change.field, change.from)} → ${diagnosticValue(change.field, change.to)}`)
      .join(" · ");
    item.append(time, changes);
    list.append(item);
  }
  history.append(summary, list);
  return history;
}

function ratingControl(bikeNumber) {
  const control = document.createElement("div");
  control.className = "bike-rating";
  control.setAttribute("role", "group");
  control.setAttribute("aria-label", `Rate bike ${bikeNumber}`);
  const current = bikeRatings.get(bikeNumber) || 0;
  for (let rating = 1; rating <= 5; rating += 1) {
    const star = document.createElement("button");
    star.type = "button";
    star.className = rating <= current ? "rated" : "";
    star.textContent = rating <= current ? "★" : "☆";
    star.title = `${rating} star${rating === 1 ? "" : "s"}`;
    star.setAttribute("aria-label", `Rate bike ${bikeNumber} ${star.title}`);
    star.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      [...control.children].forEach((button, index) => {
        button.textContent = index < rating ? "★" : "☆";
        button.classList.toggle("rated", index < rating);
      });
      try {
        await api(`/bikes/ratings/${encodeURIComponent(bikeNumber)}`, {
          method: "PUT",
          body: JSON.stringify({ rating }),
        });
        bikeRatings.set(bikeNumber, rating);
        bikeTripsStatus.textContent = `Bike ${bikeNumber} rated ${rating}/5`;
      } catch (err) {
        bikeTripsStatus.textContent = `Could not save rating: ${err.message}`;
        renderBikeTrips();
      }
    });
    control.append(star);
  }
  return control;
}

function copyBikeButton(bikeNumber) {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-bike";
  copy.textContent = "⧉";
  copy.title = `Copy bike ${bikeNumber}`;
  copy.setAttribute("aria-label", copy.title);
  copy.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(bikeNumber);
      bikeTripsStatus.textContent = `Copied bike ${bikeNumber}`;
    } catch {
      bikeTripsStatus.textContent = `Bike number: ${bikeNumber}`;
    }
  });
  return copy;
}

function renderBikeTripGroup(bikeNumber, trips) {
  const group = document.createElement("details");
  group.className = `trip-group${trips.length > 1 || trips.some((trip) =>
    hasTripIssue(trip) || bikeTripDiagnostics[tripIdentity(trip)]) ? " noteworthy" : ""}`;
  const summary = document.createElement("summary");
  const heading = document.createElement("span");
  const name = document.createElement("strong");
  name.textContent = `Bike ${bikeNumber}`;
  const total = trips.reduce((sum, trip) => {
    const cost = Number(trip.cost);
    return sum + (Number.isFinite(cost) ? cost : 0);
  }, 0);
  const meta = document.createElement("small");
  meta.textContent = `${trips.length} trip${trips.length === 1 ? "" : "s"} · ${euro(total)}`;
  heading.append(name, meta);
  summary.append(heading, copyBikeButton(bikeNumber));
  const rows = document.createElement("div");
  rows.className = "trip-rows";
  const tripRows = trips.flatMap((trip) => [renderTripRow(trip), renderTripDiagnostics(trip)].filter(Boolean));
  rows.replaceChildren(ratingControl(bikeNumber), ...tripRows);
  group.append(summary, rows);
  return group;
}

function renderChronologicalTrip(trip, counts) {
  const bikeNumber = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
  const card = document.createElement("article");
  const diagnostic = renderTripDiagnostics(trip);
  card.className = `trip-card${counts.get(bikeNumber) > 1 || hasTripIssue(trip) || diagnostic ? " noteworthy" : ""}`;
  const head = document.createElement("div");
  head.className = "trip-card-head";
  const title = document.createElement("strong");
  title.textContent = `Bike ${bikeNumber}`;
  const badges = document.createElement("span");
  badges.className = "trip-badges";
  const badge = (text) => {
    const item = document.createElement("span");
    item.textContent = text;
    badges.append(item);
  };
  if (counts.get(bikeNumber) > 1) badge(`${counts.get(bikeNumber)} rides`);
  if (Number(trip.penaltyCount) || Number(trip.penaltyAmount)) badge("Penalty");
  if (trip.lockFailed) badge("Lock failed");
  else if (trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed) badge("Dock event");
  if (diagnostic) badge("Updated by EMT");
  head.append(title, badges, copyBikeButton(bikeNumber));
  card.append(head, renderTripRow(trip));
  if (diagnostic) card.append(diagnostic);
  card.append(ratingControl(bikeNumber));
  return card;
}

function renderBikeTrips() {
  const counts = new Map();
  for (const trip of loadedBikeTrips) {
    const number = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
    counts.set(number, (counts.get(number) || 0) + 1);
  }
  if (!groupBikeTrips) {
    bikeTripsResults.replaceChildren(...loadedBikeTrips.map((trip) => renderChronologicalTrip(trip, counts)));
    return;
  }
  const grouped = new Map();
  for (const trip of loadedBikeTrips) {
    const number = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
    if (!grouped.has(number)) grouped.set(number, []);
    grouped.get(number).push(trip);
  }
  bikeTripsResults.replaceChildren(...[...grouped].map(([number, trips]) => renderBikeTripGroup(number, trips)));
}

async function loadBikeRatings() {
  if (bikeRatingsLoaded) return;
  const rows = await api("/bikes/ratings");
  bikeRatings.clear();
  for (const row of rows) bikeRatings.set(String(row.bike_number).replace(/^0+(?=\d)/, ""), row.rating);
  bikeRatingsLoaded = true;
  if (loadedBikeTrips.length) renderBikeTrips();
}

function restoreBikeTrips() {
  if (allBikeTrips) return true;
  const cached = readBikeTrips();
  if (!cached || !Array.isArray(cached.trips)) return false;
  allBikeTrips = cached.trips;
  bikeTripPages = Number(cached.pages) || 0;
  bikeTripFieldsSeen = Array.isArray(cached.fields) ? cached.fields : [];
  bikeTripsCachedAt = Number(cached.syncedAt) || null;
  bikeTripDiagnostics = updateTripDiagnostics(
    [],
    [],
    cached.diagnostics && typeof cached.diagnostics === "object" ? cached.diagnostics : {},
  );
  return true;
}

function filterAndRenderBikeTrips(status = null) {
  const bike = bikeTripsNumber.value.trim();
  if (bike && !/^\d+$/.test(bike)) {
    bikeTripsStatus.textContent = "Enter the number painted on the bike.";
    return false;
  }
  loadedBikeTrips = bike
    ? (allBikeTrips ?? []).filter((trip) => String(trip.bikeNumber) === bike.replace(/^0+(?=\d)/, ""))
    : (allBikeTrips ?? []);
  renderBikeTrips();
  const uniqueBikes = new Set(loadedBikeTrips.map((trip) => trip.bikeNumber)).size;
  if (status) {
    bikeTripsStatus.textContent = status;
  } else if (loadedBikeTrips.length) {
    const cached = bikeTripsCachedAt ? ` · synced ${fmtAge(bikeTripsCachedAt)}` : "";
    bikeTripsStatus.textContent = `${loadedBikeTrips.length} trips · ${uniqueBikes} bikes${cached}`;
  } else {
    bikeTripsStatus.textContent = bike ? `No rides for bike ${bike}` : "No rides cached";
  }
  return true;
}

/** EMTPay exposes page only—there is no observed since/date parameter. Fetch
 * newest-first pages until one overlaps our persistent history, then merge.
 * With no cache this naturally walks the complete history once. */
async function syncBikeTrips({ force = false } = {}) {
  if (bikeTripsSync) return bikeTripsSync;
  if (!force && bikeTripsSynced) return;
  const operation = (async () => {
    restoreBikeTrips();
    if (!bikeTripDiagnosticsLoaded) {
      try {
        const monitored = await api("/bikes/trip-diagnostics");
        bikeTripDiagnostics = mergeTripDiagnostics(bikeTripDiagnostics, monitored.diagnostics);
        bikeTripDiagnosticsLoaded = true;
      } catch {
        // Local comparison remains a complete fallback if monitoring is
        // temporarily unavailable; trip loading itself should still work.
      }
    }
    const existing = allBikeTrips ?? [];
    const known = new Set(existing.map(tripIdentity));
    const fetched = [];
    const fields = new Set();
    const pageSignatures = new Set();
    const oldestFirst = tripsAreOldestFirst(existing);
    const startPage = oldestFirst ? Math.max(0, bikeTripPages - 1) : 0;
    let fetchedPages = 0;
    let maxPageSeen = startPage - 1;
    let overlap = false;
    const maxPages = 50;
    for (let page = startPage; fetchedPages < maxPages; page += 1) {
      bikeTripsStatus.textContent = known.size
        ? `Checking for new trips · page ${page + 1}…`
        : `Loading history · page ${page + 1}…`;
      const query = new URLSearchParams({ page: String(page) });
      const payload = await api(`/bikes/trips?${query}`);
      fetchedPages += 1;
      maxPageSeen = page;
      const signature = payload.matchedOnPage
        .map(tripIdentity)
        .join("|");
      if (signature && pageSignatures.has(signature)) break;
      pageSignatures.add(signature);
      fetched.push(...payload.matchedOnPage);
      for (const field of payload.fields) fields.add(field);
      overlap = known.size > 0 && payload.matchedOnPage.some((trip) => known.has(tripIdentity(trip)));
      if (overlap && !oldestFirst) break;
      if (payload.countOnPage < 30) break;
    }

    const newCount = new Set(
      fetched.filter((trip) => !known.has(tripIdentity(trip))).map(tripIdentity),
    ).size;
    bikeTripDiagnostics = updateTripDiagnostics(existing, fetched, bikeTripDiagnostics);
    allBikeTrips = mergeTripHistory(existing, fetched, oldestFirst);
    bikeTripPages = Math.max(bikeTripPages, maxPageSeen + 1);
    bikeTripFieldsSeen = [...new Set([...bikeTripFieldsSeen, ...fields])].sort();
    bikeTripsCachedAt = Date.now();
    bikeTripsSynced = true;
    writeBikeTrips({
      trips: allBikeTrips,
      pages: bikeTripPages,
      fields: bikeTripFieldsSeen,
      diagnostics: bikeTripDiagnostics,
      syncedAt: bikeTripsCachedAt,
    });
    const suffix = newCount ? `${newCount} new trip${newCount === 1 ? "" : "s"}` : "No new trips";
    filterAndRenderBikeTrips(`${allBikeTrips.length} trips cached · ${suffix}`);
  })();
  bikeTripsSync = operation;
  try {
    await operation;
  } catch (err) {
    bikeTripsStatus.textContent = `Showing cached trips · ${err.message}`;
  } finally {
    if (bikeTripsSync === operation) bikeTripsSync = null;
  }
}

async function loadBikeTrips() {
  if (!filterAndRenderBikeTrips()) return;
  if (!restoreBikeTrips()) {
    bikeTripsStatus.textContent = "Loading history…";
    bikeTripsResults.replaceChildren();
  } else {
    filterAndRenderBikeTrips();
  }
  await syncBikeTrips();
}

bikeTripsOpen.addEventListener("click", () => {
  bikeTripsDialog.showModal();
  void loadBikeRatings().catch((err) => {
    bikeTripsStatus.textContent = `Ratings unavailable: ${err.message}`;
  });
  bikeTripsStatus.textContent = "";
  void loadBikeTrips();
});
bikeTripsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadBikeTrips();
});
function setBikeSearchOpen(open) {
  bikeTripsNumber.hidden = !open;
  bikeTripsSearch.setAttribute("aria-expanded", String(open));
  bikeTripsSearch.title = open ? "Search this bike" : "Open bike search";
  bikeTripsSearch.setAttribute("aria-label", bikeTripsSearch.title);
  if (open) requestAnimationFrame(() => bikeTripsNumber.focus());
}

bikeTripsSearch.addEventListener("click", () => {
  if (bikeTripsNumber.hidden) setBikeSearchOpen(true);
  else void loadBikeTrips();
});
document.getElementById("bike-trips-close").addEventListener("click", () => {
  bikeTripsDialog.close();
  bikeTripsNumber.value = "";
  setBikeSearchOpen(false);
});
bikeTripsRefresh.addEventListener("click", () => void syncBikeTrips({ force: true }));
bikeTripsChronological.addEventListener("click", () => {
  groupBikeTrips = false;
  bikeTripsChronological.setAttribute("aria-pressed", "true");
  bikeTripsGrouped.setAttribute("aria-pressed", "false");
  renderBikeTrips();
});
bikeTripsGrouped.addEventListener("click", () => {
  groupBikeTrips = true;
  bikeTripsChronological.setAttribute("aria-pressed", "false");
  bikeTripsGrouped.setAttribute("aria-pressed", "true");
  renderBikeTrips();
});

function availabilityClass(value, enabled = true) {
  if (!enabled || value == null) return "unavailable";
  if (value === 0) return "empty";
  if (value <= 2) return "low";
  return "good";
}

function distanceToStation(station) {
  if (station.metres != null) return station.metres;
  return metresFromCurrent(station.coordinates);
}

function distanceText(station) {
  return formatDistance(distanceToStation(station));
}

function bikeTitle(station, saved) {
  return saved?.label || station?.name || `Station ${station?.number ?? ""}`;
}

/** Rentable bikes as a share of the station's physical capacity. Disabled
 * bikes are separate in GBFS and therefore never included in `bikes`. */
function bikeCounts(station) {
  const wrap = document.createElement("div");
  wrap.className = "bike-counts";

  const metric = document.createElement("div");
  metric.className = `bike-metric ${availabilityClass(station.bikes,
    station.inService && station.renting !== false)}`;
  const description = document.createElement("span");
  description.textContent = "🚲 Available";
  const count = document.createElement("strong");
  count.textContent = `${station.bikes ?? "—"}/${station.totalBases || "—"}`;
  count.title = "Rentable bikes / total station capacity";
  metric.append(description, count);
  wrap.append(metric);

  // What the operator's feed knows and the old one did not: a station can be
  // in service but refusing one direction, and docked bikes are not the same
  // thing as rentable ones.
  const trouble =
    !station.inService
      ? "out of service"
      : station.renting === false
          ? "not renting"
          : null;
  if (trouble) {
    const out = document.createElement("span");
    out.className = "bike-note warn";
    out.textContent = trouble;
    wrap.append(out);
  }
  if (station.broken > 0) {
    const broken = document.createElement("span");
    broken.className = "bike-note muted";
    broken.textContent = `🔧 ${station.broken} broken`;
    broken.title = `${station.broken} broken bike${station.broken === 1 ? "" : "s"}`;
    broken.setAttribute("aria-label", broken.title);
    wrap.append(broken);
  }
  return wrap;
}

function bikeCard(station, saved) {
  const card = document.createElement("article");
  card.className = "stop bike";
  const known = station.bikes != null;
  card.classList.toggle("station-unavailable",
    known && (!station.inService || station.renting === false));
  card.addEventListener("click", () => openBikeStation(station));

  const titleWrap = document.createElement("div");
  titleWrap.className = "title";
  const h2 = document.createElement("h2");
  h2.textContent = bikeTitle(station, saved);
  titleWrap.append(h2);

  const distance = document.createElement("span");
  distance.className = "bike-card-distance";
  distance.textContent = distanceText(station) ?? "";
  distance.hidden = !distance.textContent;

  const fav = document.createElement("button");
  fav.className = "bike-favourite";
  fav.textContent = saved ? "★" : "☆";
  fav.title = saved ? "Remove from saved" : "Save this station";
  fav.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleBikeSaved(station, saved);
  });

  const directions = document.createElement("button");
  directions.className = "bike-directions";
  directions.textContent = "➤";
  directions.title = `Walking directions to ${bikeTitle(station, saved)}`;
  directions.setAttribute("aria-label", directions.title);
  directions.disabled = !station.coordinates;
  directions.addEventListener("click", (event) => {
    event.stopPropagation();
    openWalkingDirections(station.coordinates);
  });

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.append(directions, fav);

  const head = document.createElement("div");
  head.className = "head bike-head";
  head.append(titleWrap, distance, controls);

  if (known) {
    card.append(head, bikeCounts(station));
  } else {
    // Saved but not yet looked up: "0 bikes" would be a lie, "unknown" is not.
    const pending = document.createElement("p");
    pending.className = "muted";
    pending.textContent = "Counts not loaded yet";
    card.append(head, pending);
  }
  return card;
}

function renderBikes() {
  if (section !== "bikes") return;
  for (const s of bikeNear.stations ?? []) bikeById.set(s.id, s);
  for (const s of bikeNear.savedStations ?? []) {
    bikeById.set(s.id, { ...bikeById.get(s.id), ...s });
  }
  const savedIdSet = new Set(bikeSaved.map((s) => s.station_id));

  const blocks = [];
  if (bikeSaved.length) {
    blocks.push(sectionHeading("Saved"));
    const orderedSaved = [...bikeSaved].sort((a, b) =>
      proximity(distanceToStation(bikeById.get(a.station_id) ?? {})) -
      proximity(distanceToStation(bikeById.get(b.station_id) ?? {})));
    for (const row of orderedSaved) {
      const station = bikeById.get(row.station_id) ?? {
        id: row.station_id,
        number: row.station_id,
        bikes: null,
        inService: true,
      };
      blocks.push(bikeCard(station, row));
    }
  }

  const nearby = (bikeNear.stations ?? [])
    .filter((s) => !savedIdSet.has(s.id))
    .sort((a, b) => proximity(distanceToStation(a)) - proximity(distanceToStation(b)));
  blocks.push(sectionHeading(myLocation ? "Nearest to you" : "Around the map"));
  if (nearby.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No stations nearby";
    blocks.push(empty);
  }
  for (const station of nearby.slice(0, 15)) blocks.push(bikeCard(station, null));

  bikesEl.replaceChildren(...blocks);
  bikeAgeEl.textContent = bikeAgeText();
  bikeAgeEl.hidden = section !== "bikes";
}

/** Counts carry their age, and say when they are the rougher kind. */
function bikeAgeText() {
  if (!bikeFetchedAt) return "never updated";
  const age = `updated ${fmtAge(bikeFetchedAt)}`;
  return bikeNear.source === "mobilitylabs"
    ? `${age} · counts include broken bikes (operator feed unreachable)`
    : age;
}

function sectionHeading(text) {
  const h = document.createElement("h3");
  h.className = "section-heading";
  h.textContent = text;
  return h;
}

async function loadBikesNear(lat, lon, { force = false } = {}) {
  const cell = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  if (!force && cell === bikeCell && Date.now() - (bikeFetchedAt ?? 0) < 45_000) return;
  const seq = ++bikeSeq;
  try {
    const query = new URLSearchParams({ lat: String(lat), lon: String(lon), radius: String(BIKE_RADIUS) });
    if (bikeSaved.length) query.set("ids", bikeSaved.map((row) => row.station_id).join(","));
    const payload = await api(`/bikes/nearby?${query}`);
    if (seq !== bikeSeq) return;
    bikeNear = payload;
    for (const st of payload.stations ?? []) bikeById.set(st.id, st);
    for (const st of payload.savedStations ?? []) {
      bikeById.set(st.id, { ...bikeById.get(st.id), ...st });
    }
    bikeFetchedAt = payload.fetchedAt;
    bikeCell = cell;
    writeBikeNear(payload);
    renderBikes();
    if (section === "buses" && places.length) render();
    rebuildBikeMarkers();
  } catch (err) {
    statusEl.textContent = `Could not load bike stations: ${err.message}`;
  }
}

async function loadBikeSaved() {
  if (!authSession) {
    bikeSaved = [];
    renderBikes();
    return;
  }
  try {
    bikeSaved = await api("/bikes/saved");
    writeBikeSaved(bikeSaved);
  } catch (err) {
    // The favourites table is optional: bikes work without it. Say so once
    // rather than breaking the whole section.
    statusEl.textContent =
      "Saved stations unavailable";
  }
  renderBikes();
  if (section === "bikes" && bikeSaved.some((row) => !bikeById.has(row.station_id))) {
    const centre = bikeMap?.getCenter() ?? {
      lat: myLocation?.[0] ?? 40.4168,
      lng: myLocation?.[1] ?? -3.7038,
    };
    void loadBikesNear(centre.lat, centre.lng, { force: true });
  }
}

async function toggleBikeSaved(station, saved) {
  if (!authSession) {
    authDialog.showModal();
    return;
  }
  try {
    if (saved) {
      await api(`/bikes/saved/${encodeURIComponent(saved.id)}`, { method: "DELETE" });
      bikeSaved = bikeSaved.filter((s) => s.id !== saved.id);
    } else {
      const row = await api("/bikes/saved", {
        method: "POST",
        body: JSON.stringify({ stationId: station.id, label: station.name }),
      });
      bikeSaved.push(row);
    }
    writeBikeSaved(bikeSaved);
    statusEl.textContent = "";
    renderBikes();
    render();
    rebuildBikeMarkers();
  } catch (err) {
    statusEl.textContent = `Could not save station: ${err.message}`;
  }
}

/* ---- Bike station sheet ------------------------------------------------ */

const bikeDialog = document.getElementById("bike-dialog");
const bikeForm = document.getElementById("bike-form");
const bikeSheetHeading = document.getElementById("bike-sheet-heading");
const bikeSheetMeta = document.getElementById("bike-sheet-meta");
const bikeSheetCounts = document.getElementById("bike-sheet-counts");
const bikeSheetName = document.getElementById("bike-sheet-name");
const bikeSheetLabel = document.getElementById("bike-sheet-label");
const bikeSheetEdit = document.getElementById("bike-sheet-edit");
const bikeSheetSave = document.getElementById("bike-sheet-save");
const bikeSheetRemove = document.getElementById("bike-sheet-remove");
const bikeSheetFavourite = document.getElementById("bike-sheet-favourite");
const bikeSheetMapEl = document.getElementById("bike-sheet-map");
const bikeSheetDirections = document.getElementById("bike-sheet-directions");

let bikeSheetStation = null;
let bikeSheetMap = null;
let bikeSheetMarker = null;

function currentBikeSheetStation() {
  return bikeById.get(bikeSheetStation?.id) || bikeSheetStation;
}

function bikeSavedRow(station) {
  return bikeSaved.find((row) => row.station_id === station?.id) ?? null;
}

function showBikeNameEditor(editing) {
  bikeSheetName.hidden = !editing;
  bikeSheetSave.hidden = !editing;
  bikeSheetEdit.hidden = editing;
  if (editing) bikeSheetLabel.focus();
}

function showBikeSheetMap(station) {
  bikeSheetMapEl.hidden = !station.coordinates;
  if (!station.coordinates) return;
  const latlng = [station.coordinates[1], station.coordinates[0]];
  requestAnimationFrame(() => {
    if (!bikeSheetMap) {
      bikeSheetMap = L.map(bikeSheetMapEl, {
        zoomControl: false,
        attributionControl: false,
        dragging: false,
        scrollWheelZoom: false,
        doubleClickZoom: false,
        touchZoom: false,
        keyboard: false,
      });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 })
        .addTo(bikeSheetMap);
      bikeSheetMarker = L.marker(latlng).addTo(bikeSheetMap);
    } else {
      bikeSheetMarker.setLatLng(latlng);
    }
    bikeSheetMap.invalidateSize();
    bikeSheetMap.setView(latlng, 17);
  });
}

function renderBikeSheet() {
  const station = currentBikeSheetStation();
  if (!station) return;
  const saved = bikeSavedRow(station);
  bikeSheetStation = station;
  bikeSheetHeading.textContent = bikeTitle(station, saved);
  bikeSheetMeta.textContent = station.address
    ? `Nº ${station.number} · ${station.address}`
    : `Nº ${station.number}`;
  bikeSheetCounts.replaceChildren(bikeCounts(station));

  bikeSheetLabel.value = saved?.label ?? "";
  bikeSheetLabel.placeholder = station.name || "BiciMAD station";
  bikeSheetRemove.hidden = !saved;
  bikeSheetFavourite.hidden = !!saved;
  bikeSheetDirections.hidden = !station.coordinates;
  showBikeNameEditor(false);
  showBikeSheetMap(station);
}

function openBikeStation(station) {
  bikeSheetStation = station;
  bikeDialog.showModal();
  renderBikeSheet();
}

bikeSheetEdit.addEventListener("click", () => showBikeNameEditor(true));
document.getElementById("bike-sheet-close").addEventListener("click", () => bikeDialog.close());
bikeSheetDirections.addEventListener("click", () => {
  openWalkingDirections(currentBikeSheetStation()?.coordinates);
});

bikeSheetFavourite.addEventListener("click", async () => {
  await toggleBikeSaved(currentBikeSheetStation(), null);
  renderBikeSheet();
});

bikeSheetRemove.addEventListener("click", async () => {
  const station = currentBikeSheetStation();
  const saved = bikeSavedRow(station);
  if (!saved) return;
  await toggleBikeSaved(station, saved);
  bikeDialog.close();
});

bikeForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const station = currentBikeSheetStation();
  const saved = bikeSavedRow(station);
  const label = bikeSheetLabel.value.trim();
  try {
    if (saved) {
      const row = await api(`/bikes/saved/${encodeURIComponent(saved.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ label: label || null }),
      });
      bikeSaved = bikeSaved.map((item) => item.id === row.id ? row : item);
    } else {
      const row = await api("/bikes/saved", {
        method: "POST",
        body: JSON.stringify({ stationId: station.id, label: label || station.name }),
      });
      bikeSaved.push(row);
    }
    writeBikeSaved(bikeSaved);
    renderBikes();
    rebuildBikeMarkers();
    bikeDialog.close();
  } catch (err) {
    statusEl.textContent = `Could not rename station: ${err.message}`;
  }
});

document.getElementById("bike-sheet-show-map").addEventListener("click", () => {
  const station = currentBikeSheetStation();
  if (!station?.coordinates) return;
  bikeDialog.close();
  showView("map");
  showSection("bikes");
  requestAnimationFrame(() => {
    bikeMap?.setView([station.coordinates[1], station.coordinates[0]], 18);
  });
});

/* ---- Bike map ----------------------------------------------------------- */

function ensureBikeMap() {
  if (bikeMap) return;
  bikeMap = L.map(bikeMapEl, { tap: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(bikeMap);
  bikeMarkers = L.layerGroup().addTo(bikeMap);
  if (myLocation) bikeUserMarker = addUserMarker(bikeMap, myLocation);
  bikeMap.setView(myLocation ?? [40.4168, -3.7038], 15);
  bikeMap.on("moveend", () => {
    const c = bikeMap.getCenter();
    loadBikesNear(c.lat, c.lng);
  });
  rebuildBikeMarkers();
}

function bikePopup(station) {
  const saved = bikeSaved.find((s) => s.station_id === station.id);
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = bikeTitle(station, saved);
  const num = document.createElement("p");
  num.className = "stop-num";
  num.textContent = station.address ? `Nº ${station.number} · ${station.address}` : `Nº ${station.number}`;
  wrap.append(title, num, bikeCounts(station));

  const fav = document.createElement("button");
  fav.type = "button";
  fav.textContent = saved ? "★ Saved" : "☆ Save";
  fav.addEventListener("click", () => {
    toggleBikeSaved(station, saved);
    bikeMap.closePopup();
  });
  const detailsButton = document.createElement("button");
  detailsButton.type = "button";
  detailsButton.textContent = "Details";
  detailsButton.addEventListener("click", () => {
    bikeMap.closePopup();
    openBikeStation(station);
  });
  wrap.append(fav, detailsButton);
  return wrap;
}

function showBikePopupAfterPan(station) {
  pendingBikePopupId = station.id;
  const target = L.latLng(station.coordinates[1], station.coordinates[0]);
  const open = () => {
    if (pendingBikePopupId !== station.id) return;
    pendingBikePopupId = null;
    L.popup({ autoPan: false })
      .setLatLng(target)
      .setContent(bikePopup(bikeById.get(station.id) ?? station))
      .openOn(bikeMap);
  };

  bikeMap.closePopup();
  // Leaflet does not consistently emit moveend when the marker is already at
  // the centre, so avoid waiting in that case.
  if (bikeMap.distance(bikeMap.getCenter(), target) < 1) {
    open();
    return;
  }
  bikeMap.once("moveend", open);
  bikeMap.panTo(target);
}

function rebuildBikeMarkers() {
  if (!bikeMarkers) return;
  bikeMarkers.clearLayers();
  const savedIdSet = new Set(bikeSaved.map((s) => s.station_id));
  for (const station of bikeNear.stations ?? []) {
    if (!station.coordinates) continue;
    const takeClass = availabilityClass(station.bikes,
      station.inService && station.renting !== false);
    const capacity = station.totalBases || "—";
    const icon = L.divIcon({
      className: "bike-pin",
      iconSize: [54, 30],
      iconAnchor: [27, 15],
      html:
        `<div class="bike-pin-inner${savedIdSet.has(station.id) ? " saved" : ""}" ` +
        `aria-label="${station.bikes ?? "Unknown"} rentable bikes out of ${capacity} spaces">` +
        `<span class="${takeClass}">🚲 ${station.bikes ?? "—"}/${capacity}</span></div>`,
    });
    L.marker([station.coordinates[1], station.coordinates[0]], { icon })
      .on("click", () => showBikePopupAfterPan(station))
      .addTo(bikeMarkers);
  }
}

/* ---- Section menu ------------------------------------------------------- */

function showSection(next) {
  if (next !== section) closeFullscreenMap();
  section = next;
  const bikes = next === "bikes";
  document.title = bikes ? "BiciMAD" : busListMode === "places" ? "Hubwise" : "Stops";
  busModePlaces.setAttribute("aria-selected", String(!bikes && busListMode === "places"));
  busModeStops.setAttribute("aria-selected", String(!bikes && busListMode === "stops"));
  menuBikes.setAttribute("aria-selected", String(bikes));
  fab.hidden = bikes || !authSession;
  bikeAgeEl.hidden = !bikes;
  bikeAccountEl.hidden = !bikes || !isOwner;

  const mapView = viewMapBtn.getAttribute("aria-selected") === "true";
  listEl.hidden = bikes || mapView;
  mapEl.hidden = bikes || !mapView;
  bikesEl.hidden = !bikes || mapView;
  bikeMapEl.hidden = !bikes || !mapView;
  renderRouteLegend();

  if (bikes) {
    if (mapView) {
      ensureBikeMap();
      bikeMap.invalidateSize();
    }
    const centre = bikeMap?.getCenter() ?? { lat: myLocation?.[0] ?? 40.4168, lng: myLocation?.[1] ?? -3.7038 };
    loadBikesNear(centre.lat, centre.lng);
    renderBikes();
  } else if (mapView) {
    ensureMap();
    leafletMap.invalidateSize();
  } else {
    render();
  }
  syncMapControls();
}

menuBikes.addEventListener("click", () => showSection("bikes"));

function userLocationIcon() {
  return L.divIcon({
    className: "user-pin",
    iconSize: [28, 28],
    iconAnchor: [14, 14],
    html: '<span aria-hidden="true">●</span>',
  });
}

function addUserMarker(map, location) {
  return L.marker(location, { icon: userLocationIcon(), zIndexOffset: 1000 })
    .bindTooltip("You are here", { direction: "top", offset: [0, -12] })
    .addTo(map);
}

function updateUserMarkers() {
  if (!myLocation) return;
  if (leafletMap) {
    if (busUserMarker) busUserMarker.setLatLng(myLocation);
    else busUserMarker = addUserMarker(leafletMap, myLocation);
  }
  if (bikeMap) {
    if (bikeUserMarker) bikeUserMarker.setLatLng(myLocation);
    else bikeUserMarker = addUserMarker(bikeMap, myLocation);
  }
}

function syncMapControls() {
  const mapView = viewMapBtn.getAttribute("aria-selected") === "true";
  if (!mapView) closeFullscreenMap();
  mapActions.hidden = !mapView;
}

function closeFullscreenMap() {
  const wasFullscreen = mapEl.classList.contains("map-fullscreen") ||
    bikeMapEl.classList.contains("map-fullscreen");
  mapEl.classList.remove("map-fullscreen");
  bikeMapEl.classList.remove("map-fullscreen");
  document.body.classList.remove("map-is-fullscreen");
  mapFullscreenBtn.textContent = "⛶";
  mapFullscreenBtn.title = "Expand map";
  mapFullscreenBtn.setAttribute("aria-label", "Expand map");
  if (wasFullscreen) requestAnimationFrame(() => {
    leafletMap?.invalidateSize();
    bikeMap?.invalidateSize();
  });
}

let locationRefreshTimer = null;
let locationRequestPending = false;

function applyLocation(position, { recenter = false, forceNearby = false } = {}) {
  myLocation = [position.coords.latitude, position.coords.longitude];
  statusEl.textContent = "";
  updateUserMarkers();
  if (recenter) {
    // Hidden maps can be recentered safely; their size is corrected when they
    // become visible. Background updates never disturb a map the user panned.
    leafletMap?.setView(myLocation, 16);
    bikeMap?.setView(myLocation, 16);
  }
  render();
  renderBikes();
  void loadNearbyAt(myLocation[0], myLocation[1], { force: forceNearby }).then(() => {
    if (nearbyStopsDialog.open || addDialog.open) void updateClosestStopsDialog();
  });
  void loadBikesNear(myLocation[0], myLocation[1], { force: forceNearby });
  scheduleJourneys({ force: forceNearby });
}

function refreshLocation({ userInitiated = false, recenter = false, forceNearby = false } = {}) {
  if (!navigator.geolocation) {
    if (userInitiated) statusEl.textContent = "This browser will not share a location.";
    return;
  }
  if (locationRequestPending) return;
  locationRequestPending = true;
  if (userInitiated) statusEl.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    (position) => {
      locationRequestPending = false;
      applyLocation(position, { recenter, forceNearby });
    },
    (err) => {
      locationRequestPending = false;
      if (userInitiated || !myLocation) statusEl.textContent = `Could not get your location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 8_000, maximumAge: 5_000 }
  );
}

function stopLocationRefresh() {
  if (locationRefreshTimer != null) clearInterval(locationRefreshTimer);
  locationRefreshTimer = null;
}

function startLocationRefresh() {
  stopLocationRefresh();
  if (document.visibilityState !== "visible") return;
  refreshLocation();
  locationRefreshTimer = setInterval(() => refreshLocation(), 10_000);
}

locateBtn.addEventListener("click", () => {
  refreshLocation({ userInitiated: true, recenter: true, forceNearby: true });
});

mapFullscreenBtn.addEventListener("click", () => {
  const activeEl = section === "bikes" ? bikeMapEl : mapEl;
  const activeMap = section === "bikes" ? bikeMap : leafletMap;
  const expanding = !activeEl.classList.contains("map-fullscreen");
  for (const element of [mapEl, bikeMapEl]) element.classList.remove("map-fullscreen");
  activeEl.classList.toggle("map-fullscreen", expanding);
  document.body.classList.toggle("map-is-fullscreen", expanding);
  mapFullscreenBtn.textContent = expanding ? "×" : "⛶";
  mapFullscreenBtn.title = expanding ? "Close fullscreen map" : "Expand map";
  mapFullscreenBtn.setAttribute("aria-label", mapFullscreenBtn.title);
  requestAnimationFrame(() => activeMap?.invalidateSize());
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && document.body.classList.contains("map-is-fullscreen")) {
    closeFullscreenMap();
  }
});

startLocationRefresh();
initAuth();
