import { env, runInDurableObject, runDurableObjectAlarm, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { bikeTransition, busTransition, notificationText, BIKE_INTERVAL, BUS_INTERVAL } from "../src/tracking-rules.js";
import { validateWatch } from "../src/tracking.js";
import { bikeFeed, stopPoller } from "../src/pollers.js";
import { validateSubscription } from "../src/push.js";
import worker from "../src/index.js";

const busWatch = { kind: "bus", targetId: "5138", line: "70", destination: "PLAZA", label: "Home" };
const bikeWatch = { kind: "bike", targetId: "1", label: "Rack" };
const station = (bikes) => ({ bikes, inService: true, renting: true });
const bus = (seconds, vehicleId = "123") => ({ seconds, vehicleId, line: "70", destination: "PLAZA" });
afterEach(() => vi.restoreAllMocks());

describe("watch validation", () => {
  it("keeps a Madrid location for directions but never lets it change the watch identity", () => {
    const plain = validateWatch(busWatch);
    const placed = validateWatch({ ...busWatch, coordinates: [-3.70381234567, 40.41681234567] });
    expect(placed.coordinates).toEqual([-3.703812, 40.416812]);
    expect(placed.id).toBe(plain.id);
    expect(validateWatch({ ...busWatch, coordinates: [2.17, 41.38] }).coordinates).toBeUndefined();
    expect(validateWatch({ ...busWatch, coordinates: "x" }).coordinates).toBeUndefined();
  });
});

describe("alert thresholds", () => {
  it.each([[990, 870], [901, 781], [901, 900], [1200, 120]])("alerts across %i → %i seconds exactly once", (first, next) => {
    const initial = busTransition({}, [bus(first)], busWatch, 1000);
    expect(initial.alerts).toHaveLength(0);
    const crossed = busTransition(initial.state, [bus(next)], busWatch, 121000);
    expect(crossed.alerts).toHaveLength(1);
    expect(busTransition(crossed.state, [bus(next - 120)], busWatch, 241000).alerts).toHaveLength(0);
  });
  it("alerts immediately below threshold, for each new vehicle, and on a later circuit", () => {
    const first = busTransition({}, [bus(800), bus(850, "456")], busWatch, 1000);
    expect(first.alerts).toHaveLength(2);
    const gap = busTransition(first.state, [], busWatch, 121000);
    expect(busTransition(gap.state, [bus(700)], busWatch, 241000).alerts).toHaveLength(0);
    expect(busTransition(first.state, [bus(800)], busWatch, 31 * 60_000).alerts).toHaveLength(1);
  });
  it("names the bus in the title and leads the body with the wait", () => {
    const alert = busTransition({}, [{ ...bus(170), destination: "PLAZA CASTILLA" }], { ...busWatch, destination: "" }, 1000).alerts[0];
    expect(notificationText(busWatch, alert)).toEqual({ title: "70 → Plaza Castilla", body: "In 3 min · Home · stop 5138" });
    expect(notificationText({ ...busWatch, label: "" }, { ...alert, minutes: 0 }).body).toBe("Due now · Stop 5138");
    const armed = bikeTransition({}, station(0)).state;
    const bikes = bikeTransition(armed, station(1)).alerts[0];
    expect(notificationText(bikeWatch, bikes)).toEqual({ title: "Rack", body: "1 bike available now · station 1" });
  });
  it("rejects invalid ETAs and other routes/directions", () => {
    const rows = [bus(-1), bus(NaN), bus(999999), { ...bus(10), line: "71" }, { ...bus(10), destination: "ELSEWHERE" }];
    expect(busTransition({}, rows, busWatch, 1000).alerts).toHaveLength(0);
  });
  it("arms below six, alerts on every bike docked, silences above six and rearms below six", () => {
    let state = {};
    const alerts = [2, 3, 0, 1, 1, 4, 6, 7, 8, 6, 7, 5, 6].map((count) => {
      const result = bikeTransition(state, station(count));
      state = result.state;
      return result.alerts.length;
    });
    expect(alerts).toEqual([0, 1, 0, 1, 0, 1, 1, 0, 0, 0, 0, 0, 1]);
  });
  it("does not alert on a jump past six or turn unavailable/missing counts into zero", () => {
    const empty = bikeTransition({}, station(0)).state;
    expect(bikeTransition(empty, station(7)).alerts).toHaveLength(0);
    for (const value of [null, { ...station(0), renting: false }, station(null), station(-1)]) {
      expect(bikeTransition({ armed: false, count: 6 }, value).state).toEqual({ armed: false, count: 6 });
    }
  });
});

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
async function credentials() {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const client = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  return {
    config: { VAPID_PUBLIC_KEY: base64url(await crypto.subtle.exportKey("raw", vapid.publicKey)), VAPID_PRIVATE_KEY: jwk.d, VAPID_SUBJECT: "https://example.org" },
    subscription: { endpoint: "https://fcm.googleapis.com/fcm/send/test", keys: {
      p256dh: base64url(await crypto.subtle.exportKey("raw", client.publicKey)), auth: base64url(crypto.getRandomValues(new Uint8Array(16))),
    } },
  };
}

/** A signed-in user's runner, reachable by name the way pollers call it. */
async function runner() {
  const user = crypto.randomUUID();
  const stub = env.TRACKING.get(env.TRACKING.idFromName(user));
  const { config, subscription } = await credentials();
  await runInDurableObject(stub, (instance) => { Object.assign(instance.env, config); });
  await stub.identify(user);
  await stub.subscribe(subscription);
  return { stub, subscription, user };
}
const feedStub = () => bikeFeed(env);
const pollBikes = () => runDurableObjectAlarm(feedStub());
const pollStop = (stop) => runDurableObjectAlarm(stopPoller(env, stop));
const feedUsers = () => runInDurableObject(feedStub(), (instance) => instance.subscribers().map((s) => s.user));
/** Counts watch-row writes in a runner while `run` executes. */
async function countWrites(stub, run) {
  await runInDurableObject(stub, (instance) => {
    instance.writes = 0;
    const save = instance.save.bind(instance);
    instance.save = (watch) => { instance.writes++; save(watch); };
  });
  await run();
  return runInDurableObject(stub, (instance) => instance.writes);
}
function feed(count) {
  return Response.json({ data: { stations: [{ station_id: "1", num_bikes_available: count, is_installed: 1, is_renting: 1, is_returning: 1, status: "IN_SERVICE" }] } });
}

describe("shared pollers and per-user runners", () => {
  it("polls bikes on a 30-second grid, sends encrypted push, and stops once untracked", async () => {
    const { stub, user } = await runner();
    let count = 0;
    const pushes = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("station_status")) return feed(count);
      pushes.push(init);
      return new Response(null, { status: 201 });
    });
    await stub.add(bikeWatch);
    expect(await feedUsers()).toEqual([user]);
    await pollBikes();
    const next = await runInDurableObject(feedStub(), (_, ctx) => ctx.storage.getAlarm());
    expect(next % BIKE_INTERVAL).toBe(0);
    expect(next - Date.now()).toBeLessThanOrEqual(BIKE_INTERVAL);
    const first = (await stub.list()).watches[0];
    expect(first.rack).toEqual({ bikes: 0, armed: true });
    expect(first.state).toBeUndefined();
    count = 1;
    await pollBikes();
    expect(pushes).toHaveLength(1);
    expect(new Headers(pushes[0].headers).get("content-encoding")).toBe("aes128gcm");
    expect(new Headers(pushes[0].headers).get("authorization")).toMatch(/^vapid /);
    expect(pushes[0].body.byteLength).toBeGreaterThan(100);
    // The stubbed fetch accepts anything; the real Workers fetch throws on
    // redirect: "error", which silently failed every push in production.
    expect(pushes[0].redirect).toBe("manual");
    await pollBikes();
    expect(pushes).toHaveLength(1);
    await stub.remove(first.id);
    expect(await feedUsers()).toEqual([]);
    await pollBikes(); // the pending poll finds nobody and books no other
    expect(await pollBikes()).toBe(false);
  });
  it("retries failed push without losing the transition and drops expired subscriptions", async () => {
    const { stub, subscription } = await runner();
    let count = 0;
    let status = 503;
    let sends = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("station_status")) return feed(count);
      sends++;
      return new Response(null, { status });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    count = 1;
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    status = 201;
    await pollBikes();
    expect(sends).toBe(2);
    expect((await stub.list()).watches[0].error).toBeNull();
    count = 2;
    status = 410;
    await pollBikes();
    expect((await stub.list()).devices).toBe(0);
    await pollBikes(); // nobody to notify: the runner says so and is dropped
    expect(await feedUsers()).toEqual([]);
    // The browser hands back the same dead subscription: it must not be
    // re-registered, or the next send drops it and checks stop again.
    expect(await stub.subscribe(subscription)).toMatchObject({ expired: true });
    expect((await stub.list()).devices).toBe(0);
    await stub.subscribe({ ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/fresh" });
    expect((await stub.list()).devices).toBe(1);
  });
  it("survives upstream failure and keeps polling; no data means no push", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await stub.add(bikeWatch);
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    expect(await runInDurableObject(feedStub(), (_, ctx) => ctx.storage.getAlarm())).toBeGreaterThan(Date.now());
  });
  it("does not re-send to a device that already accepted a push when another device fails", async () => {
    const { stub, subscription } = await runner();
    await stub.subscribe({ ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/second" });
    let count = 0;
    let failSecond = true;
    const sends = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("station_status")) return feed(count);
      sends.push(String(url));
      return new Response(null, { status: String(url).endsWith("second") && failSecond ? 503 : 201 });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    count = 1;
    await pollBikes();
    expect(sends.filter((url) => url.endsWith("/test"))).toHaveLength(1);
    failSecond = false;
    await pollBikes();
    expect(sends.filter((url) => url.endsWith("/test"))).toHaveLength(1);
    expect(sends.filter((url) => url.endsWith("/second"))).toHaveLength(2);
  });
  it("rejects stale bike feeds without arming a false empty-rack alert", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = await feed(0).json();
      return Response.json({ ...body, last_updated: Math.floor(Date.now() / 1000) - 300 });
    });
    await stub.add(bikeWatch);
    await pollBikes();
    expect((await stub.list()).watches[0].error).toBeTruthy();
    const state = await runInDurableObject(stub, (instance) => instance.rows("watches")[0].state);
    expect(state).toEqual({});
  });
  it("serves two users on one stop with one EMT call per poll, on a two-minute grid", async () => {
    const alice = await runner();
    const bob = await runner();
    const loner = await runner();
    await env.KV.put("emt:token", "test-token");
    const boards = [];
    await alice.stub.add(busWatch);
    await bob.stub.add(busWatch);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/arrives/")) {
        boards.push(String(url));
        return Response.json({ code: "00", data: [{ Arrive: [{ line: "70", destination: "PLAZA", bus: 123, estimateArrive: 300, DistanceBus: 800 }] }] });
      }
      return new Response(null, { status: 201 });
    });
    await pollStop(busWatch.targetId);
    expect(boards).toHaveLength(1);
    for (const { stub } of [alice, bob]) {
      const watch = (await stub.list()).watches[0];
      expect(watch.error).toBeNull();
      expect(watch.lastCheck).toBeGreaterThan(0);
    }
    expect((await loner.stub.list()).watches).toEqual([]);
    const next = await runInDurableObject(stopPoller(env, busWatch.targetId), (_, ctx) => ctx.storage.getAlarm());
    expect(next % BUS_INTERVAL).toBe(0);
  });
  it("writes nothing to a runner while a rack does not change", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("station_status") ? feed(7) : new Response(null, { status: 201 }));
    await stub.add(bikeWatch);
    await pollBikes(); // the first check records the state
    const writes = await countWrites(stub, async () => { await pollBikes(); await pollBikes(); await pollBikes(); });
    expect(writes).toBe(0);
    expect((await stub.list()).watches[0].lastCheck).toBeGreaterThan(0);
  });
  it("moves a runner from the self-polling era onto the shared feed", async () => {
    const { stub, user } = await runner();
    await runInDurableObject(stub, async (instance, ctx) => {
      // What an old runner looks like: a watch, no subscriptions, a 30 s alarm.
      instance.save({ ...bikeWatch, id: "old", targetId: "1", revision: "r", state: {}, lastCheck: 1, error: null });
      instance.setMeta("subscriptions", null);
      await ctx.storage.setAlarm(Date.now() + 100);
    });
    await runDurableObjectAlarm(stub);
    expect(await feedUsers()).toEqual([user]);
    const next = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
    expect(next - Date.now()).toBeGreaterThan(23 * 60 * 60_000); // the daily re-sync
  });
  it("migrates an old runner that was never told its user, once it is", async () => {
    const user = crypto.randomUUID();
    const stub = env.TRACKING.get(env.TRACKING.idFromName(user));
    const { config, subscription } = await credentials();
    await runInDurableObject(stub, async (instance, ctx) => {
      Object.assign(instance.env, config);
      instance.ctx.storage.sql.exec("INSERT INTO devices VALUES ('d', ?)", JSON.stringify(validateSubscription(subscription)));
      instance.save({ ...bikeWatch, id: "old", targetId: "1", revision: "r", state: {}, lastCheck: 1, error: null });
      await ctx.storage.setAlarm(Date.now() + 100);
    });
    await runDurableObjectAlarm(stub);
    const named = await runInDurableObject(stub, (_, ctx) => Boolean(ctx.id.name));
    // Where the runtime exposes the object's name, the alarm alone is enough;
    // otherwise the next /tracking request identifies it and it subscribes.
    if (!named) {
      expect(await feedUsers()).toEqual([]);
      await stub.identify(user);
    }
    expect(await feedUsers()).toEqual([user]);
  });
  it("does not resurrect a watch removed during upstream I/O", async () => {
    const { stub } = await runner();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { entered(); await pending; return feed(0); });
    const { watches } = await stub.add(bikeWatch);
    const checking = pollBikes();
    await started;
    await stub.remove(watches[0].id);
    release();
    await checking;
    expect((await stub.list()).watches).toEqual([]);
    expect(await feedUsers()).toEqual([]);
  });
});

describe("tracking API validation", () => {
  it("requires authentication", async () => {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await worker.fetch(new Request("https://worker/tracking", { method }), env, createExecutionContext());
      expect(response.status).toBe(401);
    }
  });
  it("rejects arbitrary callback URLs and malformed subscriptions", () => {
    expect(() => validateSubscription({ endpoint: "https://example.com" })).toThrow();
    expect(() => validateSubscription({ endpoint: "https://fcm.googleapis.com.evil.test" })).toThrow();
    expect(() => validateWatch({ kind: "bike", targetId: "../admin" })).toThrow();
    expect(() => validateWatch({ ...busWatch, line: "" })).toThrow();
  });
});
