/** Browser push is opt-in, and only requested in direct response to a tap. */
export function createTracking({ api, signedIn, changed }) {
  let watches = [];
  let config;
  let deviceCount = 0;
  let thisDevice = false; // this browser holds a subscription the worker accepted
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
    await register(await navigator.serviceWorker.ready);
    deviceCount = Math.max(1, deviceCount);
  }

  /** Send this browser's subscription to the worker, replacing it first when
   *  it was made with another server key or the push service has expired it:
   *  the browser keeps handing back a dead subscription as if it were fine. */
  async function register(reg) {
    let subscription = await reg.pushManager.getSubscription();
    if (subscription && !sameKey(subscription, config.publicKey)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      subscription ??= await reg.pushManager.subscribe({
        userVisibleOnly: true, applicationServerKey: config.publicKey,
      });
      const result = await api("/tracking/subscription", { method: "POST", body: JSON.stringify(subscription) });
      if (!result?.expired) {
        thisDevice = true;
        return;
      }
      await subscription.unsubscribe();
      subscription = null;
    }
    throw new Error("The push service keeps rejecting this device. Try again later.");
  }

  function sameKey(subscription, publicKey) {
    const raw = subscription.options?.applicationServerKey;
    if (!raw) return true; // not exposed: nothing to compare, keep it
    const encoded = btoa(String.fromCharCode(...new Uint8Array(raw)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return encoded === publicKey;
  }

  /** Re-register this browser's subscription without prompting. The worker
   *  drops a device the push service rejected, and reinstalling the app can
   *  leave the browser subscribed while the worker has forgotten it; either
   *  way alerts would stop silently until someone tapped Enable again. */
  async function resync() {
    thisDevice = false;
    if (!supported() || window.Notification.permission !== "granted") return;
    const reg = await navigator.serviceWorker.getRegistration(new URL("./", import.meta.url));
    // Never subscribe on its own: only keep alive what Enable created.
    if (!reg || !(await reg.pushManager.getSubscription())) return;
    config ??= await api("/tracking/config");
    if (config.available) await register(reg);
  }

  async function load() {
    const current = ++generation;
    watches = [];
    refresh();
    if (!signedIn()) return;
    try { await resync(); } catch { thisDevice = false; }
    try {
      const data = await api("/tracking");
      if (current !== generation) return;
      watches = data.watches;
      deviceCount = data.devices ?? deviceCount;
      refresh();
    } catch { /* Tracking availability must not prevent the transport UI loading. */ }
  }

  async function send(method, body) {
    const data = await api("/tracking", { method, body: JSON.stringify(body) });
    watches = data.watches;
    deviceCount = data.devices ?? deviceCount;
  }

  async function toggle(watch) {
    if (busy) return;
    busy = true;
    try {
      const existing = find(watch);
      if (!existing) await enable();
      await send(existing ? "DELETE" : "POST", existing ? { id: existing.id } : watch);
    } finally {
      busy = false;
      refresh();
    }
  }

  /** A set is tracked when every member is; tapping a partly tracked set
   *  completes it, tapping a fully tracked one clears it. */
  async function toggleSet(set) {
    if (busy || !set.length) return;
    busy = true;
    try {
      const all = set.every((watch) => find(watch));
      if (!all) await enable();
      for (const watch of set) {
        const existing = find(watch);
        if (all) await send("DELETE", { id: existing.id });
        else if (!existing) await send("POST", watch);
      }
    } finally {
      busy = false;
      refresh();
    }
  }

  async function removeAll() {
    if (busy) return;
    busy = true;
    try {
      // One DELETE per watch: there are at most 20, and it needs no new route.
      for (const watch of [...watches]) {
        await send("DELETE", { id: watch.id });
      }
    } finally {
      busy = false;
      refresh();
    }
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

  const BELL_ON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bell-fill" d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>';
  const BELL_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/><path d="M12 2v1"/></svg>';

  // An icon, not a label: "Tracking · stop" pushed the ETA off a phone row.
  function bell(tracked, label, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-btn track-button";
    button.innerHTML = tracked ? BELL_ON : BELL_OFF;
    button.setAttribute("aria-pressed", String(tracked));
    button.setAttribute("aria-label", label);
    button.title = label;
    button.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try { await onClick(); }
      catch (error) { window.alert(error.message); }
      finally { button.disabled = false; }
    });
    return button;
  }

  function button(watch) {
    const tracked = !!find(watch);
    return bell(tracked,
      `${tracked ? "Stop tracking" : "Track"} ${watch.kind === "bus" ? `line ${watch.line} at stop` : "bike station"} ${watch.targetId}${watch.destination ? ` towards ${watch.destination}` : ""}`,
      () => toggle(watch));
  }

  /** One bell for several watches, e.g. every boarding option of a hub. */
  function setButton(set, name) {
    const unique = [...new Map(set.map((watch) => [key(watch), watch])).values()];
    const tracked = unique.length > 0 && unique.every((watch) => find(watch));
    const button = bell(tracked,
      `${tracked ? "Stop tracking" : "Track"} all ${unique.length} boarding option${unique.length === 1 ? "" : "s"} to ${name}`,
      () => toggleSet(unique));
    button.disabled = unique.length === 0;
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
      empty.textContent = "Open a stop or bike station and tap the bell.";
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
    enableButton.textContent = thisDevice ? "Alerts enabled on this device" : "Enable alerts on this device";
    enableButton.addEventListener("click", async () => {
      enableButton.disabled = true;
      try { await enable(); refresh(); }
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
  return { load, button, setButton, removeAll, count: () => watches.length, indicator, isTracked, renderList, disconnect, clear() { generation++; watches = []; refresh(); } };
}
