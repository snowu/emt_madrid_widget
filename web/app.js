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

let stops = readStops();
let arrivals = readCache();
let details = readDetails();

function stopTitle(stop) {
  return stop.label || details[stop.stop_id]?.name || `Stop ${stop.stop_id}`;
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

      const title = document.createElement("h2");
      title.textContent = stopTitle(stop);

      const refresh = document.createElement("button");
      refresh.textContent = "↻";
      refresh.title = "Refresh this stop";
      refresh.addEventListener("click", () => refreshStop(stop.stop_id));

      const remove = document.createElement("button");
      remove.textContent = "×";
      remove.title = "Remove this stop";
      remove.addEventListener("click", () => deleteStop(stop.id));

      const list = document.createElement("ul");
      if (!cached) {
        list.innerHTML = `<li class="muted">No data yet</li>`;
      } else if (cached.arrivals.length === 0) {
        list.innerHTML = `<li class="muted">Nothing due</li>`;
      } else {
        // Count down from the age of the fetch, not from the raw value, so a
        // cached payload shows the time remaining now rather than when fetched.
        const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
        for (const bus of cached.arrivals) {
          const li = document.createElement("li");
          const line = document.createElement("span");
          line.className = "line";
          line.textContent = bus.line;
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
      head.append(title, controls);

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
    const payload = await api(`/arrivals?stop=${encodeURIComponent(stopId)}`);
    arrivals[stopId] = payload;
    writeCache(stopId, payload);
    statusEl.textContent = "";
    render();
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

/** Fetch and remember a stop's official name; returns null if EMT rejects it. */
async function resolveStop(stopId) {
  if (details[stopId]) return details[stopId];
  try {
    const detail = await api(`/stops/${encodeURIComponent(stopId)}/detail`);
    details[stopId] = detail;
    writeDetail(stopId, detail);
    return detail;
  } catch {
    return null;
  }
}

/** Stops saved before names were resolved get their titles filled in. */
async function hydrateNames() {
  const missing = stops.filter((s) => !details[s.stop_id]);
  if (missing.length === 0) return;
  await Promise.all(missing.map((s) => resolveStop(s.stop_id)));
  render();
  rebuildMarkers();
}

/* ---- List / Map views ------------------------------------------------- */

let leafletMap = null;
let markers = null; // L.LayerGroup

function popupHtml(stop) {
  // Built as DOM, never as a string: line names/labels come from EMT.
  const wrap = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = stopTitle(stop);
  const ul = document.createElement("ul");

  const cached = arrivals[stop.stop_id];
  if (!cached || cached.arrivals.length === 0) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = cached ? "Nothing due" : "No data yet";
    ul.append(li);
  } else {
    const elapsed = Math.floor((Date.now() - cached.fetchedAt) / 1000);
    for (const bus of cached.arrivals) {
      const li = document.createElement("li");
      const line = document.createElement("span");
      line.className = "line";
      line.textContent = String(bus.line);
      const eta = document.createElement("span");
      eta.className = "eta";
      eta.textContent = fmtCountdown(bus.seconds - elapsed);
      li.append(line, eta);
      ul.append(li);
    }
    const age = document.createElement("p");
    age.className = "muted";
    age.textContent = `updated ${fmtAge(cached.fetchedAt)}`;
    wrap.append(title, ul, age);
    return wrap;
  }
  wrap.append(title, ul);
  return wrap;
}

function ensureMap() {
  if (leafletMap) return;
  leafletMap = L.map(mapEl, { tap: false });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors",
  }).addTo(leafletMap);

  markers = L.layerGroup().addTo(leafletMap);
  rebuildMarkers();

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
  if (!markers || mapEl.hidden) return;
  markers.eachLayer((marker) => {
    if (marker.isPopupOpen()) {
      marker.setPopupContent(popupHtml(stops.find((s) => s.stop_id === marker.stopId)));
    }
  });
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
    leafletMap.invalidateSize();
  } else {
    render(); // the interval skips list renders while the map is up
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
  } catch (err) {
    statusEl.textContent = `Could not remove stop: ${err.message}`;
  }
}

const fab = document.getElementById("fab");
const addForm = document.getElementById("add-stop");

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
  if (!/^[0-9]+$/.test(stopId)) {
    statusEl.textContent = "Stop numbers are digits only.";
    return;
  }
  try {
    fab.disabled = true;
    document.getElementById("add-save").disabled = true;
    statusEl.textContent = `Looking up stop ${stopId}…`;
    // Resolving first validates the stop exists and gives us its real name.
    const detail = await resolveStop(stopId);
    if (!detail) {
      statusEl.textContent = `No EMT stop ${stopId} — check the number on the stop sign.`;
      return;
    }
    const row = await api("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId, label: userLabel || detail.name }),
    });
    stops.push(row);
    writeStops(stops);
    idInput.value = "";
    labelInput.value = "";
    statusEl.textContent = "";
    render();
    rebuildMarkers();
    refreshStop(row.stop_id);
    addDialog.close();
  } catch (err) {
    statusEl.textContent = `Could not add stop: ${err.message}`;
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
}, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAll();
});

render(); // paint cached data immediately; never show an empty screen
loadStops();
