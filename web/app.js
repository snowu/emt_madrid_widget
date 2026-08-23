import {
  readCache,
  writeCache,
  readStops,
  writeStops,
  readDetails,
  writeDetail,
  readBikeSaved,
  writeBikeSaved,
  readBikeNear,
  writeBikeNear,
  setUserCacheScope,
} from "./cache.js";

const API = "https://emt-arrivals.zancato-t.workers.dev";
let authClient = null;
let authSession = null;
let authUser = null;
let isOwner = false;

const listEl = document.getElementById("stops");
const statusEl = document.getElementById("status");
const mapEl = document.getElementById("map");
const viewListBtn = document.getElementById("view-list");
const viewMapBtn = document.getElementById("view-map");
const addDialog = document.getElementById("add-dialog");
const authButton = document.getElementById("auth-button");
const authDialog = document.getElementById("auth-dialog");
const authForm = document.getElementById("auth-form");
const authEmail = document.getElementById("auth-email");
const authMessage = document.getElementById("auth-message");
const accountMenu = document.getElementById("account-menu");
const accountMenuEmail = document.getElementById("account-menu-email");
const accountSignout = document.getElementById("account-signout");

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

function openWalkingDirections(coordinates) {
  if (!coordinates) return;
  const [lon, lat] = coordinates;
  const url = new URL("https://www.google.com/maps/dir/");
  url.searchParams.set("api", "1");
  url.searchParams.set("destination", `${lat},${lon}`);
  url.searchParams.set("travelmode", "walking");
  window.open(url.toString(), "_blank", "noopener,noreferrer");
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
  const isWrite = init.method && init.method !== "GET";
  const authorization = authSession?.access_token
    ? { Authorization: `Bearer ${authSession.access_token}` }
    : {};
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
}

function showSignedOut(message = "") {
  authSession = null;
  authUser = null;
  isOwner = false;
  setUserCacheScope(null);
  stops = [];
  bikeSaved = [];
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
  await Promise.all([loadStops(), loadBikeSaved()]);
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
let busUserMarker = null;
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
const sheetNote = document.getElementById("sheet-service-note");
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
sheetDirections.addEventListener("click", () => {
  openWalkingDirections(details[sheetStop?.stop_id]?.coordinates);
});
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

document.getElementById("refresh-all").addEventListener("click", () => {
  if (section !== "bikes") return refreshAll();
  const c = bikeMap?.getCenter();
  loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038, {
    force: true,
  });
});

// Re-render every second so countdowns and ages tick without refetching.
setInterval(() => {
  if (section === "bikes") {
    bikeAgeEl.textContent = bikeAgeText();
    return;
  }
  if (mapEl.hidden) render();
  tickPopups();
  renderSheetArrivals();
}, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (section === "bikes") {
    const c = bikeMap?.getCenter();
    loadBikesNear(c?.lat ?? myLocation?.[0] ?? 40.4168, c?.lng ?? myLocation?.[1] ?? -3.7038, {
      force: true,
    });
  } else {
    refreshAll();
  }
});

render();

/* ---- BiciMAD ------------------------------------------------------------ */

const bikesEl = document.getElementById("bikes");
const bikeMapEl = document.getElementById("bike-map");
const bikeAgeEl = document.getElementById("bike-age");
const locateBtn = document.getElementById("locate");
const titleEl = document.getElementById("title");
const menuBuses = document.getElementById("menu-buses");
const menuBikes = document.getElementById("menu-bikes");
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
let bikeCell = null;
let bikeSeq = 0;
let myLocation = null;
let bikeUserMarker = null;
// Live counts by station id, from whichever call last saw them: the nearby
// sweep, or the by-ids lookup that keeps saved stations current even when
// they are nowhere near the map.
const bikeById = new Map();
function showBikeAccount(text, tone = "") {
  bikeAccountText.textContent = text;
  bikeAccountDot.className = `bike-account-dot${tone ? ` ${tone}` : ""}`;
}

async function loadBikeAccount() {
  bikeAccountCheck.disabled = true;
  showBikeAccount("Checking account…");
  try {
    const payload = await api("/bikes/account");
    if (payload.blocked) {
      showBikeAccount("Account blocked by BiciMAD", "blocked");
    } else if (!payload.accountEnabled || !payload.activeContract) {
      showBikeAccount("Account not ready to rent", "warn");
    } else {
      showBikeAccount("Account active · not blocked", "ready");
    }
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

bikeAccountCheck.addEventListener("click", loadBikeAccount);

const bikeTripsDialog = document.getElementById("bike-trips-dialog");
const bikeTripsForm = document.getElementById("bike-trips-form");
const bikeTripsNumber = document.getElementById("bike-trips-number");
const bikeTripsStatus = document.getElementById("bike-trips-status");
const bikeTripsResults = document.getElementById("bike-trips-results");
const bikeTripsFields = document.getElementById("bike-trips-fields");
const bikeTripsChronological = document.getElementById("bike-trips-chronological");
const bikeTripsGrouped = document.getElementById("bike-trips-grouped");
let loadedBikeTrips = [];
let groupBikeTrips = false;
const bikeRatings = new Map();

function euro(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? new Intl.NumberFormat(undefined, { style: "currency", currency: "EUR" }).format(numeric)
    : null;
}

function renderTripRow(trip) {
  const shownBikeNumber = trip.bikeNumber == null
    ? null
    : String(trip.bikeNumber).replace(/^0+(?=\d)/, "");
  const row = document.createElement("div");
  row.className = "trip-row";
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
    incident.textContent = trip.lockFailed ? "Lock failed" : "Docking issue recorded";
    row.append(incident);
  }
  return row;
}

function hasTripIssue(trip) {
  return Boolean(Number(trip.penaltyCount) || Number(trip.penaltyAmount) ||
    trip.lockFailed || trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed);
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
  group.className = `trip-group${trips.length > 1 || trips.some(hasTripIssue) ? " noteworthy" : ""}`;
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
  rows.replaceChildren(ratingControl(bikeNumber), ...trips.map(renderTripRow));
  group.append(summary, rows);
  return group;
}

function renderChronologicalTrip(trip, counts) {
  const bikeNumber = String(trip.bikeNumber ?? "unknown").replace(/^0+(?=\d)/, "");
  const card = document.createElement("article");
  card.className = `trip-card${counts.get(bikeNumber) > 1 || hasTripIssue(trip) ? " noteworthy" : ""}`;
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
  else if (trip.dockIncident || trip.incorrectDockBlock || trip.forcedClosed) badge("Dock issue");
  head.append(title, badges, copyBikeButton(bikeNumber));
  card.append(head, renderTripRow(trip), ratingControl(bikeNumber));
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
  const rows = await api("/bikes/ratings");
  bikeRatings.clear();
  for (const row of rows) bikeRatings.set(String(row.bike_number).replace(/^0+(?=\d)/, ""), row.rating);
  if (loadedBikeTrips.length) renderBikeTrips();
}

async function loadBikeTrips() {
  const bike = bikeTripsNumber.value.trim();
  if (bike && !/^\d+$/.test(bike)) {
    bikeTripsStatus.textContent = "Enter the number painted on the bike.";
    return;
  }
  bikeTripsStatus.textContent = "Loading…";
  bikeTripsResults.replaceChildren();
  try {
    const allTrips = [];
    const fields = new Set();
    const pageSignatures = new Set();
    let pages = 0;
    const maxPages = 50;
    for (; pages < maxPages; pages += 1) {
      bikeTripsStatus.textContent = `Loading page ${pages + 1}…`;
      const query = new URLSearchParams({ page: String(pages) });
      if (bike) query.set("bike", bike.padStart(8, "0"));
      const payload = await api(`/bikes/trips?${query}`);
      const signature = payload.matchedOnPage
        .map((trip) => `${trip.tripId}:${trip.bikeNumber}:${trip.interval}`)
        .join("|");
      if (signature && pageSignatures.has(signature)) break;
      pageSignatures.add(signature);
      allTrips.push(...payload.matchedOnPage);
      for (const field of payload.fields) fields.add(field);
      if (payload.countOnPage < 30) {
        pages += 1;
        break;
      }
    }

    loadedBikeTrips = allTrips;
    renderBikeTrips();
    const uniqueBikes = new Set(allTrips.map((trip) => trip.bikeNumber)).size;
    bikeTripsStatus.textContent = allTrips.length
      ? `${allTrips.length} trips · ${uniqueBikes} bikes · ${pages} pages`
      : `No matching rides across ${pages} pages`;
    bikeTripsFields.hidden = fields.size === 0;
    bikeTripsFields.querySelector("code").textContent = [...fields].sort().join(", ");
  } catch (err) {
    bikeTripsStatus.textContent = err.message;
  }
}

bikeTripsOpen.addEventListener("click", () => {
  bikeTripsStatus.textContent = "";
  bikeTripsResults.replaceChildren();
  bikeTripsDialog.showModal();
  void loadBikeRatings().catch((err) => {
    bikeTripsStatus.textContent = `Ratings unavailable: ${err.message}`;
  });
  void loadBikeTrips();
});
bikeTripsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadBikeTrips();
});
document.getElementById("bike-trips-close").addEventListener("click", () => bikeTripsDialog.close());
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
  if (!myLocation || !Array.isArray(station.coordinates)) return null;
  const [lon, lat] = station.coordinates;
  const [myLat, myLon] = myLocation;
  const x = (lon - myLon) * Math.cos((myLat * Math.PI) / 180);
  const y = lat - myLat;
  return Math.round(Math.sqrt(x * x + y * y) * 111_320);
}

function distanceText(station) {
  const metres = distanceToStation(station);
  if (metres == null) return null;
  return metres < 1000 ? `${metres} m` : `${(metres / 1000).toFixed(1)} km`;
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
    broken.title = `${station.broken} separate disabled bike${station.broken === 1 ? "" : "s"}; not included in the available count`;
    broken.setAttribute("aria-label", broken.title);
    wrap.append(broken);
  }
  return wrap;
}

function bikeCard(station, saved) {
  const card = document.createElement("article");
  card.className = "stop bike";
  const known = station.bikes != null;
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

  const controls = document.createElement("div");
  controls.className = "controls";
  controls.append(fav);

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
  const savedIdSet = new Set(bikeSaved.map((s) => s.station_id));

  const blocks = [];
  if (bikeSaved.length) {
    blocks.push(sectionHeading("Saved"));
    for (const row of bikeSaved) {
      const station = bikeById.get(row.station_id) ?? {
        id: row.station_id,
        number: row.station_id,
        bikes: null,
        inService: true,
      };
      blocks.push(bikeCard(station, row));
    }
  }

  const nearby = (bikeNear.stations ?? []).filter((s) => !savedIdSet.has(s.id));
  blocks.push(sectionHeading(myLocation ? "Nearest to you" : "Around the map"));
  if (nearby.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "No stations here yet — open the map or tap ◎ to find the ones near you.";
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
    const payload = await api(`/bikes/nearby?lat=${lat}&lon=${lon}&radius=${BIKE_RADIUS}`);
    if (seq !== bikeSeq) return;
    bikeNear = payload;
    for (const st of payload.stations ?? []) bikeById.set(st.id, st);
    bikeFetchedAt = payload.fetchedAt;
    bikeCell = cell;
    writeBikeNear(payload);
    renderBikes();
    rebuildBikeMarkers();
    refreshSavedBikeCounts();
  } catch (err) {
    statusEl.textContent = `Could not load bike stations: ${err.message}`;
  }
}

/** Saved stations are the ones you check without looking at a map, so their
 *  counts cannot depend on being near the view. */
async function refreshSavedBikeCounts() {
  if (bikeSaved.length === 0) return;
  const ids = bikeSaved.map((s) => s.station_id).join(",");
  try {
    const payload = await api(`/bikes/stations?ids=${encodeURIComponent(ids)}`);
    // The by-id response has fresh counts but no distance. Preserve fields
    // learned from the nearby response instead of replacing the whole object.
    for (const s of payload.stations ?? []) {
      bikeById.set(s.id, { ...bikeById.get(s.id), ...s });
    }
    bikeFetchedAt = payload.fetchedAt ?? bikeFetchedAt;
    renderBikes();
    rebuildBikeMarkers();
  } catch {
    // The cards say "not loaded yet" rather than inventing a zero.
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
      "Saved bike stations need supabase/bike_stations.sql run once — everything else works.";
  }
  renderBikes();
  refreshSavedBikeCounts();
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
const bikeSheetDetails = document.getElementById("bike-sheet-details");
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

  const facts = [
    ["Taking bikes", station.renting === false ? "Unavailable" : "Available"],
    ["Returning bikes", station.returning === false ? "Unavailable" : "Available"],
    ["Station", station.inService ? "In service" : "Out of service"],
    ["Capacity", station.totalBases ?? "—"],
  ];
  if (station.broken > 0) facts.push(["Disabled bikes", station.broken]);
  if (station.brokenDocks > 0) facts.push(["Disabled docks", station.brokenDocks]);
  bikeSheetDetails.replaceChildren(...facts.map(([label, value]) => {
    const row = document.createElement("div");
    const term = document.createElement("span");
    term.textContent = label;
    const result = document.createElement("strong");
    result.textContent = value;
    row.append(term, result);
    return row;
  }));

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
      .bindPopup(() => bikePopup(station))
      .addTo(bikeMarkers);
  }
}

/* ---- Section menu ------------------------------------------------------- */

function showSection(next) {
  if (next !== section) closeFullscreenMap();
  section = next;
  const bikes = next === "bikes";
  titleEl.textContent = bikes ? "BiciMAD" : "Buses";
  menuBuses.setAttribute("aria-selected", String(!bikes));
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

menuBuses.addEventListener("click", () => showSection("buses"));
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

locateBtn.addEventListener("click", () => {
  if (!navigator.geolocation) {
    statusEl.textContent = "This browser will not share a location.";
    return;
  }
  statusEl.textContent = "Finding you…";
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myLocation = [pos.coords.latitude, pos.coords.longitude];
      statusEl.textContent = "";
      updateUserMarkers();
      const activeMap = section === "bikes" ? bikeMap : leafletMap;
      activeMap?.setView(myLocation, 16);
      if (section === "bikes") {
        loadBikesNear(myLocation[0], myLocation[1], { force: true });
      }
    },
    (err) => {
      statusEl.textContent = `Could not get your location: ${err.message}`;
    },
    { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 }
  );
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

initAuth();
