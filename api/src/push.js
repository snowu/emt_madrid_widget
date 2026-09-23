import { buildPushPayload } from "@block65/webcrypto-web-push";
import { EmtError } from "./errors.js";

export function validateSubscription(value) {
  let url;
  try { url = new URL(value?.endpoint); } catch { throw new EmtError("bad_request", "Invalid push subscription"); }
  // A subscription is untrusted input: never turn the sender into an arbitrary
  // URL fetcher. These are the browser vendors' Web Push services.
  const allowed = url.hostname === "fcm.googleapis.com" ||
    url.hostname === "updates.push.services.mozilla.com" ||
    url.hostname.endsWith(".push.services.mozilla.com") ||
    url.hostname === "web.push.apple.com" || url.hostname.endsWith(".notify.windows.com");
  if (url.protocol !== "https:" || url.port || url.username || url.password || !allowed ||
      value.endpoint.length > 2048 || !/^[\w-]{87}$/.test(value.keys?.p256dh ?? "") ||
      !/^[\w-]{22}$/.test(value.keys?.auth ?? "")) {
    throw new EmtError("bad_request", "Invalid push subscription");
  }
  return { endpoint: url.href, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

export async function subscriptionId(endpoint) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, "0")).join("");
}

export async function sendPush(env, subscription, payload) {
  const details = await buildPushPayload({ data: JSON.stringify(payload), options: { ttl: 120, urgency: "high" } }, subscription, {
    subject: env.VAPID_SUBJECT,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
  });
  const response = await fetch(subscription.endpoint, {
    ...details, redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  await response.body?.cancel();
  return response.status;
}
