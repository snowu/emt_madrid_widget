import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createTracking } from "../web/tracking.js";
import { mapsDirections } from "../web/directions.js";
const { JSDOM } = createRequire(new URL("../api/package.json", import.meta.url))("jsdom");
const watch = { kind: "bus", targetId: "5138", line: "70", destination: "PLAZA" };
const id = JSON.stringify(["bus", "5138", "70", "PLAZA"]);

function setup({ permission = "granted", watches = [], expired = new Set() } = {}) {
  const { window } = new JSDOM('<main id="list"></main>', { url: "https://example.com/app/" });
  const calls = [];
  const errors = [];
  window.alert = (message) => errors.push(message);
  const subscription = { endpoint: "https://push.test/device", unsubscribe: async () => { calls.push("unsubscribe"); } };
  let current = subscription;
  const reg = { pushManager: {
    getSubscription: async () => current,
    subscribe: async () => {
      calls.push("subscribe");
      current = { endpoint: "https://push.test/fresh", unsubscribe: async () => { current = null; } };
      return current;
    },
  } };
  window.Notification = { requestPermission: async () => { calls.push("permission"); return permission; } };
  window.PushManager = function () {};
  Object.defineProperty(window.navigator, "serviceWorker", { value: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg } });
  for (const key of ["window", "document", "navigator"]) Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
  const api = async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body && JSON.parse(init.body) });
    if (path === "/tracking/config") return { available: true, publicKey: "test" };
    if (path === "/tracking/subscription" && init?.method === "POST") return { expired: expired.has(JSON.parse(init.body).endpoint) };
    if (path === "/tracking" && init?.method === "POST") watches = [{ ...JSON.parse(init.body), id }];
    if (path === "/tracking" && init?.method === "DELETE") watches = [];
    return { watches };
  };
  const tracking = createTracking({ api, signedIn: () => true, changed: () => {} });
  return { tracking, window, calls, errors };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("Track obtains permission before I/O, saves a subscription and watch, then removes without a new prompt", async () => {
  const { tracking, calls } = setup();
  tracking.button(watch).click();
  await tick();
  assert.equal(calls[0], "permission");
  assert.deepEqual(calls.filter((x) => x.path).map((x) => x.path), ["/tracking/config", "/tracking/subscription", "/tracking"]);
  const tracked = tracking.button(watch);
  assert.equal(tracked.getAttribute("aria-pressed"), "true");
  tracked.click();
  await tick();
  assert.equal(calls.filter((x) => x === "permission").length, 1);
  assert.equal(calls.at(-1).method, "DELETE");
  assert.equal(tracking.button(watch).getAttribute("aria-pressed"), "false");
});

test("permission denial never creates a background watch", async () => {
  const { tracking, calls, errors } = setup({ permission: "denied" });
  tracking.button(watch).click();
  await tick();
  assert.deepEqual(calls, ["permission"]);
  assert.match(errors[0], /Allow notifications/);
});

test("reload restores tracking and sign-out disconnects this browser", async () => {
  const { tracking, calls, window } = setup({ watches: [{ ...watch, id }] });
  await tracking.load();
  assert.equal(tracking.button(watch).getAttribute("aria-pressed"), "true");
  tracking.renderList(window.document.querySelector("main"));
  assert.match(window.document.body.textContent, /Line 70/);
  await tracking.disconnect();
  assert.equal(calls.at(-2).path, "/tracking/subscription");
  assert.equal(calls.at(-2).method, "DELETE");
  assert.equal(calls.at(-1), "unsubscribe");
});

test("service worker displays a push with the page closed and opens its tracked destination", async () => {
  const handlers = {};
  const notifications = [];
  const opened = [];
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { scope: "https://example.com/app/", showNotification: async (...args) => notifications.push(args) },
    clients: { matchAll: async () => [], openWindow: async (url) => opened.push(url) },
  };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), { self, URL });
  let done;
  handlers.push({ data: { json: () => ({ title: "Home", body: "Bus in 13 min", target: { kind: "bus", id: "5138" } }) }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(notifications[0][0], "Home");
  // Android ignores SVG here and would show Chrome's logo instead.
  assert.match(notifications[0][1].icon, /\.png$/);
  assert.match(notifications[0][1].badge, /\.png$/);
  handlers.notificationclick({ notification: { close() {}, data: notifications[0][1].data }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(opened[0], "https://example.com/app/?trackKind=bus&trackId=5138");
});

test("service worker hands a push to a focused page instead of the system shade", async () => {
  const handlers = {};
  const notifications = [];
  const posted = [];
  const page = { focused: true, visibilityState: "visible", postMessage: (m) => posted.push(m) };
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { scope: "https://example.com/app/", showNotification: async (...args) => notifications.push(args) },
    clients: { matchAll: async () => [page] },
  };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), { self, URL });
  let done;
  handlers.push({ data: { json: () => ({ title: "70 → PLAZA in 3 min", body: "Home" }) }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(notifications.length, 0);
  assert.equal(posted[0].message.title, "70 → PLAZA in 3 min");
});
test("stop tracking everything deletes each watch", async () => {
  const other = { kind: "bike", targetId: "1", id: "bike-1" };
  const { tracking, calls } = setup({ watches: [{ ...watch, id }, other] });
  await tracking.load();
  assert.equal(tracking.count(), 2);
  await tracking.removeAll();
  assert.deepEqual(calls.filter((x) => x.method === "DELETE").map((x) => x.body.id), [id, "bike-1"]);
  assert.equal(tracking.count(), 0);
});
test("a hub bell tracks every distinct boarding option", async () => {
  const { tracking, calls } = setup();
  const set = [
    { kind: "bus", targetId: "1", line: "27", label: "To Work" },
    { kind: "bus", targetId: "2", line: "N1", label: "To Work" },
    { kind: "bus", targetId: "1", line: "27", label: "To Work" },
  ];
  const hub = () => tracking.setButton(set, "Work");
  assert.match(hub().getAttribute("aria-label"), /all 2 boarding options/);
  hub().click();
  await tick(); await tick();
  assert.deepEqual(calls.filter((x) => x.method === "POST" && x.path === "/tracking").map((x) => x.body.targetId), ["1", "2"]);
});

test("a subscription the push service expired is replaced, not re-registered", async () => {
  const { tracking, calls } = setup({ expired: new Set(["https://push.test/device"]) });
  tracking.button(watch).click();
  await tick(); await tick();
  const posted = calls.filter((x) => x.path === "/tracking/subscription").map((x) => x.body.endpoint);
  assert.deepEqual(posted, ["https://push.test/device", "https://push.test/fresh"]);
  assert.ok(calls.includes("unsubscribe") && calls.includes("subscribe"));
  assert.equal(calls.at(-1).path, "/tracking");
});

test("the tracked list says where each rack stands against the alert rule", async () => {
  const bike = (rack) => ({ kind: "bike", targetId: "1", label: "Rack", id: `b${rack?.bikes}${rack?.armed}`, rack });
  const { tracking, window } = setup({ watches: [bike({ bikes: 7, armed: false }), bike({ bikes: 0, armed: true }), bike({ bikes: 2, armed: true }), bike(undefined)] });
  await tracking.load();
  tracking.renderList(window.document.querySelector("main"));
  const lines = [...window.document.querySelectorAll(".tracking-item small")].map((el) => el.textContent);
  assert.match(lines[0], /^7 bikes · alerts once it drops below 6 · waiting for first check$/);
  assert.match(lines[1], /^Empty · alerts when a bike arrives/);
  assert.match(lines[2], /^2 bikes · alerts as more arrive/);
  assert.equal(lines[3], "Waiting for first check");
});

test("tapping a notification focuses the open app and hands it the target", async () => {
  const handlers = {};
  const posted = [];
  const opened = [];
  const page = {
    url: "https://example.com/app/", focused: false, visibilityState: "hidden",
    focus: async () => page, postMessage: (m) => posted.push(m),
    navigate: async () => { throw new TypeError("not controlled"); },
  };
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { scope: "https://example.com/app/" },
    clients: { matchAll: async () => [page], openWindow: async (url) => opened.push(url) },
  };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), { self, URL });
  let done;
  handlers.notificationclick({ notification: { close() {}, data: { target: { kind: "bike", id: "12" } } }, waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: "open", target: { kind: "bike", id: "12" } }]));
  assert.equal(opened.length, 0);
});

test("a tap on an alert with a location opens Hubward for directions; its button opens the stop", async () => {
  const handlers = {};
  const notifications = [];
  const opened = [];
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { scope: "https://example.com/app/", showNotification: async (...args) => notifications.push(args) },
    clients: { matchAll: async () => [], openWindow: async (url) => opened.push(url) },
  };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), { self, URL });
  let done;
  const target = { kind: "bike", id: "12", coordinates: [-3.7038, 40.4168] };
  handlers.push({ data: { json: () => ({ title: "Rack", body: "2 bikes", target }) }, waitUntil: (p) => { done = p; } });
  await done;
  const { data, actions } = notifications[0][1];
  assert.equal(actions[0].action, "open");
  handlers.notificationclick({ notification: { close() {}, data }, action: "", waitUntil: (p) => { done = p; } });
  await done;
  // Never a Maps URL from the worker: that would open a browser tab.
  assert.equal(opened[0], "https://example.com/app/?trackKind=bike&trackId=12&directions=-3.7038%2C40.4168");
  handlers.notificationclick({ notification: { close() {}, data }, action: "open", waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(opened[1], "https://example.com/app/?trackKind=bike&trackId=12");
});

test("an open app is handed the directions instead of a new window", async () => {
  const handlers = {};
  const posted = [];
  const page = { url: "https://example.com/app/", focus: async () => page, postMessage: (m) => posted.push(m) };
  const self = {
    addEventListener: (name, callback) => { handlers[name] = callback; },
    registration: { scope: "https://example.com/app/" },
    clients: { matchAll: async () => [page], openWindow: async () => assert.fail("opened a window") },
  };
  vm.runInNewContext(readFileSync(new URL("../web/sw.js", import.meta.url), "utf8"), { self, URL });
  let done;
  const target = { kind: "bus", id: "5138", coordinates: [-3.7038, 40.4168] };
  handlers.notificationclick({ notification: { close() {}, data: { target } }, action: "", waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: "directions", target }]));
});

test("Maps links name the Google Maps app on Android and iPhone, with a web fallback", () => {
  const at = [-3.7038, 40.4168];
  const web = "https://www.google.com/maps/dir/?api=1&destination=40.4168%2C-3.7038&travelmode=walking";
  const android = mapsDirections(at, "Mozilla/5.0 (Linux; Android 15; Pixel 8) Chrome/140 Mobile");
  assert.match(android.app, /^intent:\/\/maps\.google\.com\/maps\?daddr=40\.4168,-3\.7038&dirflg=w#Intent;.*package=com\.google\.android\.apps\.maps;/);
  assert.ok(android.app.includes(`S.browser_fallback_url=${encodeURIComponent(web)}`));
  assert.equal(mapsDirections(at, "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X)").app,
    "comgooglemaps://?daddr=40.4168,-3.7038&directionsmode=walking");
  assert.match(mapsDirections(at, "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", 5).app, /^comgooglemaps:/); // iPadOS
  assert.deepEqual(mapsDirections(at, "Mozilla/5.0 (X11; Linux x86_64)"), { app: null, web });
  assert.equal(mapsDirections(null, ""), null);
});
