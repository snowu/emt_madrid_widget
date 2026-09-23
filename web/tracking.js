/** Browser push is opt-in, and only requested in direct response to a tap. */
export function createTracking({ api, signedIn, changed }) {
  let watches = [];
  let config;
  let deviceCount = 0;
  let generation = 0;
  let busy = false;
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const registration = () => navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), { scope: "./" });
  const key = (watch) => JSON.stringify([watch.kind, String(watch.targetId), watch.kind === "bus" ? String(watch.line).toUpperCase() : "", watch.destination || ""]);
  const find = (watch) => watches.find((item) => item.id === key(watch));
  const refresh = () => changed();

  async function enable() {
    if (!signedIn()) throw new Error("Sign in to track buses and bike stations.");
    if (!supported()) throw new Error("Push notifications are unavailable here. On iPhone or iPad, add Hubwise to your Home Screen and open it there.");
    // Keep the permission request before any network await (Safari gesture rule).
    const permission = await window.Notification.requestPermission();
    if (permission !== "granted") throw new Error("Allow notifications in your browser settings to receive alerts.");
    config ??= await api("/tracking/config");
    if (!config.available) throw new Error("Notifications are not configured yet.");
    await registration();
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({
      userVisibleOnly: true, applicationServerKey: config.publicKey,
    });
    await api("/tracking/subscription", { method: "POST", body: JSON.stringify(subscription) });
    deviceCount = Math.max(1, deviceCount);
  }

  async function load() {
    const current = ++generation;
    watches = [];
    refresh();
    if (!signedIn()) return;
    try {
      const data = await api("/tracking");
      if (current !== generation) return;
      watches = data.watches;
      deviceCount = data.devices ?? deviceCount;
      refresh();
    } catch { /* Tracking availability must not prevent the transport UI loading. */ }
  }

  async function toggle(watch) {
    if (busy) return;
    busy = true;
    try {
      const existing = find(watch);
      if (!existing) await enable();
      const data = await api("/tracking", {
        method: existing ? "DELETE" : "POST",
        body: JSON.stringify(existing ? { id: existing.id } : watch),
      });
      watches = data.watches;
      deviceCount = data.devices ?? deviceCount;
      refresh();
    } finally { busy = false; }
  }

  function isTracked(kind, targetId, line) {
    return watches.some((watch) => watch.kind === kind && watch.targetId === String(targetId) &&
      (line == null || watch.line === String(line).toUpperCase()));
  }

  function indicator(kind, targetId, line) {
    const icon = document.createElement("span");
    icon.className = "tracking-indicator";
    icon.hidden = !isTracked(kind, targetId, line);
    icon.title = "Tracking alerts enabled";
    icon.setAttribute("role", "img");
    icon.setAttribute("aria-label", icon.title);
    icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>';
    return icon;
  }

  function button(watch) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "track-button";
    const tracked = !!find(watch);
    button.textContent = tracked ? "Tracking · stop" : "Track";
    if (tracked) button.prepend(indicator(watch.kind, watch.targetId, watch.line || undefined));
    button.setAttribute("aria-pressed", String(tracked));
    button.setAttribute("aria-label", `${tracked ? "Stop tracking" : "Track"} ${watch.kind === "bus" ? `line ${watch.line} at stop` : "bike station"} ${watch.targetId}${watch.destination ? ` towards ${watch.destination}` : ""}`);
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try { await toggle(watch); }
      catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }

  function renderList(container) {
    container.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "muted";
    intro.textContent = "Buses: checked every 2 min; one alert per bus at 15 min or less. Bikes: checked every 30 sec; alerts after an empty rack gains bikes, until more than 4 are available. Alerts resume after it empties again.";
    container.append(intro);
    if (watches.length && !deviceCount) {
      const paused = document.createElement("p");
      paused.textContent = "Alerts are paused. Enable notifications on this device to resume checks.";
      container.append(paused);
    }
    if (!watches.length) {
      const empty = document.createElement("p");
      empty.textContent = "Open a stop or bike station and tap Track.";
      container.append(empty);
    }
    for (const watch of watches) {
      const row = document.createElement("div");
      row.className = "tracking-item";
      const text = document.createElement("span");
      text.textContent = `${watch.kind === "bus" ? `Line ${watch.line} · ` : ""}${watch.label || watch.targetId}${watch.destination ? ` → ${watch.destination}` : ""}`;
      const status = document.createElement("small");
      status.textContent = watch.error || (watch.lastCheck ? `Checked ${new Date(watch.lastCheck).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Waiting for first check");
      text.append(document.createElement("br"), status);
      row.append(text, button(watch));
      container.append(row);
    }
    const enableButton = document.createElement("button");
    enableButton.type = "button";
    enableButton.textContent = "Enable alerts on this device";
    enableButton.addEventListener("click", async () => {
      enableButton.disabled = true;
      try { await enable(); enableButton.textContent = "Alerts enabled on this device"; }
      catch (error) { window.alert(error.message); }
      finally { enableButton.disabled = false; }
    });
    container.append(enableButton);
  }

  async function disconnect() {
    if (!supported()) return;
    const reg = await navigator.serviceWorker.getRegistration(new URL("./", import.meta.url));
    const subscription = await reg?.pushManager.getSubscription();
    if (!subscription) return;
    await api("/tracking/subscription", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
    await subscription.unsubscribe();
  }
  return { load, button, indicator, isTracked, renderList, disconnect, clear() { generation++; watches = []; refresh(); } };
}
