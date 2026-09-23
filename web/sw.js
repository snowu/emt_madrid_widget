// No fetch handler: transport data and application updates retain their normal
// network caching behavior. This worker exists only to display background push.

// A fixed worker must not wait for every open window to close before it runs:
// take over at once, including pages loaded before it existed.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
/** Walking directions in the Google Maps app.
 *
 * openWindow() opens its URL as a browser tab, and Android only hands a
 * google.com/maps link to the app when it is followed from inside a page, so
 * the plain link opened Maps in Chrome. On Android an intent: URL names the
 * Maps app outright and falls back to the web page if it is not installed.
 * iOS has no intents; there the universal link is what opens the app. */
function webDirections(target) {
  const [lon, lat] = Array.isArray(target?.coordinates) ? target.coordinates.map(Number) : [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const web = new URL("https://www.google.com/maps/dir/");
  web.searchParams.set("api", "1");
  web.searchParams.set("destination", `${lat},${lon}`); // GeoJSON is [lon, lat]
  web.searchParams.set("travelmode", "walking");
  return web.href;
}

function directionsUrl(target) {
  const web = webDirections(target);
  if (!web || !/Android/i.test(self.navigator?.userAgent ?? "")) return web;
  const [lon, lat] = target.coordinates.map(Number);
  return `intent://maps.google.com/maps?daddr=${lat},${lon}&dirflg=w#Intent;scheme=https;` +
    `package=com.google.android.apps.maps;S.browser_fallback_url=${encodeURIComponent(web)};end`;
}

self.addEventListener("push", (event) => {
  let message;
  try { message = event.data?.json(); } catch { /* Show a useful fallback. */ }
  event.waitUntil((async () => {
    // Chrome only lets a push go without a system notification when the page
    // is focused; there the page shows its own banner instead of a duplicate.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focused = windows.find((client) => client.focused && client.visibilityState === "visible");
    if (focused) return focused.postMessage({ type: "push", message });
    // Android draws neither an SVG icon nor a coloured badge: without these
    // PNGs it falls back to Chrome's own logo. The badge is read as alpha only.
    return self.registration.showNotification(message?.title || "Hubwise", {
      body: message?.body || "A tracked stop has an update.",
      icon: new URL("icon-192.png", self.registration.scope).href,
      badge: new URL("badge-96.png", self.registration.scope).href,
      tag: message?.tag || "hubwise-update",
      // A bike station reuses its tag, so a second alert would otherwise
      // replace the first without a sound.
      renotify: true,
      timestamp: Number.isFinite(message?.timestamp) ? message.timestamp : Date.now(),
      data: { target: message?.target },
      // A tap walks you there; the button is for when you want the app.
      actions: directionsUrl(message?.target) ? [{ action: "open", title: "Open in Hubwise" }] : [],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(self.registration.scope);
  const target = event.notification.data?.target;
  const directions = event.action === "open" ? null : directionsUrl(target);
  if (directions) {
    // If this browser refuses an intent: URL outright, the web page still helps.
    const fallback = directions.startsWith("intent:") ? webDirections(target) : null;
    event.waitUntil(self.clients.openWindow(directions).catch(() => fallback && self.clients.openWindow(fallback)));
    return;
  }
  if (["bus", "bike"].includes(target?.kind) && /^\d+$/.test(target?.id)) {
    url.searchParams.set("trackKind", target.kind);
    url.searchParams.set("trackId", target.id);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    // Bring an open app forward and let it open the target itself. navigate()
    // rejects for a page this worker does not control, which left the tap
    // doing nothing at all; reloading the app was never wanted anyway.
    if (existing) {
      try {
        const focused = await existing.focus();
        focused.postMessage({ type: "open", target });
        return;
      } catch { /* fall through to a fresh window */ }
    }
    return self.clients.openWindow(url.href);
  })());
});
