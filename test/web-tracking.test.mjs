import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createTracking } from "../web/tracking.js";
const { JSDOM } = createRequire(new URL("../api/package.json", import.meta.url))("jsdom");
const watch = { kind: "bus", targetId: "5138", line: "70", destination: "PLAZA" };
const id = JSON.stringify(["bus", "5138", "70", "PLAZA"]);

function setup({ permission = "granted", watches = [] } = {}) {
  const { window } = new JSDOM('<main id="list"></main>', { url: "https://example.com/app/" });
  const calls = [];
  const errors = [];
  window.alert = (message) => errors.push(message);
  const subscription = { endpoint: "https://push.test/device", unsubscribe: async () => { calls.push("unsubscribe"); } };
  const reg = { pushManager: { getSubscription: async () => subscription } };
  window.Notification = { requestPermission: async () => { calls.push("permission"); return permission; } };
  window.PushManager = function () {};
  Object.defineProperty(window.navigator, "serviceWorker", { value: { register: async () => reg, ready: Promise.resolve(reg), getRegistration: async () => reg } });
  for (const key of ["window", "document", "navigator"]) Object.defineProperty(globalThis, key, { value: key === "window" ? window : window[key], configurable: true });
  const api = async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET", body: init?.body && JSON.parse(init.body) });
    if (path === "/tracking/config") return { available: true, publicKey: "test" };
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
