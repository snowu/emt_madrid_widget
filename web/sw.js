// No fetch handler: transport data and application updates retain their normal
// network caching behavior. This worker exists only to display background push.
self.addEventListener("push", (event) => {
  let message;
  try { message = event.data?.json(); } catch { /* Show a useful fallback. */ }
  event.waitUntil(self.registration.showNotification(message?.title || "Hubwise", {
    body: message?.body || "A tracked stop has an update.",
    icon: new URL("icon.svg", self.registration.scope).href,
    tag: message?.tag || "hubwise-update",
    data: { target: message?.target },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(self.registration.scope);
  const target = event.notification.data?.target;
  if (["bus", "bike"].includes(target?.kind) && /^\d+$/.test(target?.id)) {
    url.searchParams.set("trackKind", target.kind);
    url.searchParams.set("trackId", target.id);
  }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find((client) => client.url.startsWith(self.registration.scope));
    if (existing) {
      await existing.navigate(url.href);
      return existing.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
