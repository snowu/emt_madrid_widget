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

const stopsEl = document.getElementById("stops");
const statusEl = document.getElementById("status");

let stops = readStops();
let arrivals = readCache();
let details = readDetails();

function stopTitle(stop) {
  return stop.label || details[stop.stop_id]?.name || `Stop ${stop.stop_id}`;
}

function fmtCountdown(seconds) {
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
  stopsEl.replaceChildren(
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
  const missing = stops.filter((s) => !s.label && !details[s.stop_id]);
  await Promise.all(missing.map((s) => resolveStop(s.stop_id)));
  render();
}

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
  } catch (err) {
    statusEl.textContent = `Could not remove stop: ${err.message}`;
  }
}

document.getElementById("add-stop").addEventListener("submit", async (event) => {
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
    refreshStop(row.stop_id);
  } catch (err) {
    statusEl.textContent = `Could not add stop: ${err.message}`;
  }
});

document.getElementById("refresh-all").addEventListener("click", refreshAll);

// Re-render every second so countdowns and ages tick without refetching.
setInterval(render, 1000);

// Coming back to a backgrounded tab is exactly when the data is most stale.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refreshAll();
});

render(); // paint cached data immediately; never show an empty screen
loadStops();
