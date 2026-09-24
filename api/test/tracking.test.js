import { env, runInDurableObject, runDurableObjectAlarm, createExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { bikeTransition, busTransition, notificationText, BIKE_INTERVAL, BUS_INTERVAL } from "../src/tracking-rules.js";
import { validateWatch } from "../src/tracking.js";
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

async function runner() {
  const stub = env.TRACKING.get(env.TRACKING.newUniqueId());
  const { config, subscription } = await credentials();
  await runInDurableObject(stub, (instance) => { Object.assign(instance.env, config); });
  await stub.subscribe(subscription);
  return { stub, subscription };
}
async function dueNow(stub) {
  await runInDurableObject(stub, (instance) => { instance.dueOverride = true; });
  await runDurableObjectAlarm(stub);
}
/** Counts storage writes to watch rows and alarms while `run` executes. */
async function countWrites(stub, run) {
  await runInDurableObject(stub, (instance, ctx) => {
    instance.writes = 0;
    const save = instance.save.bind(instance);
    instance.save = (watch) => { instance.writes++; save(watch); };
    const setAlarm = ctx.storage.setAlarm.bind(ctx.storage);
    ctx.storage.setAlarm = (at) => { instance.writes++; return setAlarm(at); };
  });
  await run();
  return runInDurableObject(stub, (instance) => instance.writes);
}
function feed(count) {
  return Response.json({ data: { stations: [{ station_id: "1", num_bikes_available: count, is_installed: 1, is_renting: 1, is_returning: 1, status: "IN_SERVICE" }] } });
}

describe("persistent background runner", () => {
  it("checks bikes every 30 seconds, sends encrypted push and cancels the last alarm on untrack", async () => {
    const { stub } = await runner();
    let count = 0;
    const pushes = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url).includes("station_status")) return feed(count);
      pushes.push(init);
      return new Response(null, { status: 201 });
    });
    await stub.add(bikeWatch);
    await dueNow(stub);
    const first = (await stub.list()).watches[0];
    const next = await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm());
    // One aligned 30-second grid for every watch.
    expect(next % BIKE_INTERVAL).toBe(0);
    expect(next - Date.now()).toBeLessThanOrEqual(BIKE_INTERVAL);
    expect(first.rack).toEqual({ bikes: 0, armed: true });
    expect(first.state).toBeUndefined();
    count = 1;
    await dueNow(stub);
    expect(pushes).toHaveLength(1);
    expect(new Headers(pushes[0].headers).get("content-encoding")).toBe("aes128gcm");
    expect(new Headers(pushes[0].headers).get("authorization")).toMatch(/^vapid /);
    expect(pushes[0].body.byteLength).toBeGreaterThan(100);
    // The stubbed fetch accepts anything; the real Workers fetch throws on
    // redirect: "error", which silently failed every push in production.
    expect(pushes[0].redirect).toBe("manual");
    await dueNow(stub);
    expect(pushes).toHaveLength(1);
    await stub.remove(first.id);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
  });
  it("retries failed push without losing the zero-to-one transition and prunes expired subscriptions", async () => {
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
    await dueNow(stub);
    count = 1;
    await dueNow(stub);
    expect((await stub.list()).watches[0].error).toBeTruthy();
    status = 201;
    await dueNow(stub);
    expect(sends).toBe(2);
    expect((await stub.list()).watches[0].error).toBeNull();
    count = 2;
    status = 410;
    await dueNow(stub);
    expect((await stub.list()).devices).toBe(0);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
    // The browser hands back the same dead subscription: it must not be
    // re-registered, or the next send drops it and checks stop again.
    expect(await stub.subscribe(subscription)).toMatchObject({ expired: true });
    expect((await stub.list()).devices).toBe(0);
    await stub.subscribe({ ...subscription, endpoint: "https://fcm.googleapis.com/fcm/send/fresh" });
    expect((await stub.list()).devices).toBe(1);
    expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm())).not.toBeNull();
  });
  it("survives upstream failure and retains an alarm; no data means no push", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    await stub.add(bikeWatch);
    await dueNow(stub);
    expect((await stub.list()).watches[0].error).toBeTruthy();
    expect(await runInDurableObject(stub, (_, ctx) => ctx.storage.getAlarm())).toBeGreaterThan(Date.now());
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
    await dueNow(stub);
    count = 1;
    await dueNow(stub);
    expect(sends.filter((url) => url.endsWith("/test"))).toHaveLength(1);
    failSecond = false;
    await dueNow(stub);
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
    await dueNow(stub);
    expect((await stub.list()).watches[0].error).toBeTruthy();
    const state = await runInDurableObject(stub, (instance) => instance.rows("watches")[0].state);
    expect(state).toEqual({});
  });
  it("checks buses every two minutes and isolates different users", async () => {
    const { stub } = await runner();
    const { stub: other } = await runner();
    await env.KV.put("emt:token", "test-token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ code: "01", data: [] }));
    await stub.add(busWatch);
    await dueNow(stub);
    const watch = (await stub.list()).watches[0];
    expect(watch.error).toBeNull();
    expect(watch.lastCheck).toBeGreaterThan(0);
    // Buses go on the first tick of each two-minute slot, even after an
    // eviction has wiped the in-memory check times.
    const due = await runInDurableObject(stub, (instance) => {
      instance.checked.clear();
      instance.dueOverride = false;
      const stored = instance.rows("watches")[0];
      const slot = Math.ceil(Date.now() / BUS_INTERVAL) * BUS_INTERVAL + BUS_INTERVAL;
      return [0, 1, 2, 3].map((tick) => instance.isDue(stored, slot + tick * BIKE_INTERVAL));
    });
    expect(due).toEqual([true, false, false, false]);
    expect((await other.list()).watches).toEqual([]);
  });
  it("writes one alarm per tick and nothing else while a rack does not change", async () => {
    const { stub } = await runner();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) =>
      String(url).includes("station_status") ? feed(7) : new Response(null, { status: 201 }));
    await stub.add(bikeWatch);
    await dueNow(stub); // first check records the state
    const writes = await countWrites(stub, async () => { await dueNow(stub); await dueNow(stub); await dueNow(stub); });
    expect(writes).toBe(3);
    expect((await stub.list()).watches[0].lastCheck).toBeGreaterThan(0);
  });
  it("does not resurrect a watch removed during upstream I/O", async () => {
    const { stub } = await runner();
    let release;
    const pending = new Promise((resolve) => { release = resolve; });
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => { entered(); await pending; return feed(0); });
    const { watches } = await stub.add(bikeWatch);
    const checking = dueNow(stub);
    await started;
    await stub.remove(watches[0].id);
    release();
    await checking;
    expect((await stub.list()).watches).toEqual([]);
    expect(await runDurableObjectAlarm(stub)).toBe(false);
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
