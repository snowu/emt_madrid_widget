import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker from "../src/index.js";
import { sealCredentials, openCredentials, withEmtAccount, callerClass } from "../src/emt-account.js";
import { getToken, clearTokenMemoryForTest } from "../src/emt.js";
import { recordUpstreamMetric } from "../src/metrics.js";

// Supabase (auth + the emt_accounts table) and EMT are stubbed; the bearer
// token doubles as the user id. EMT logins answer with a token naming the
// email, so every assertion can see whose quota a call spent.
const rows = new Map();
let upstream;
let rejectLogin;
async function call(path, user = "alice", method = "GET", body, overrides = {}) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://account.test${path}`, {
    method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), { ...env, ...overrides }, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
async function connect(user) {
  const response = await call("/auth/emt", user, "PUT", { email: `${user}@example.test`, password: `${user}-password` });
  expect(response.status).toBe(200);
  return response.json();
}
const arrivalTokens = () => upstream.mock.calls
  .filter(([url]) => String(url).includes("/arrives/")).map(([, init]) => init.headers.accessToken);
// Unique stops keep each request a Cache API miss.
let stop = 1000;
const nextStop = () => String(stop++);

beforeEach(async () => {
  rows.clear();
  rejectLogin = null;
  clearTokenMemoryForTest();
  await env.KV.put("emt:token", "shared-token");
  upstream = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
    const path = String(url);
    if (path.includes("/auth/v1/user")) return Response.json({ id: init.headers.Authorization.slice(7) });
    if (path.includes("/rest/v1/emt_accounts")) {
      const user = init.headers.Authorization.slice(7);
      if (init.method === "POST") rows.set(user, JSON.parse(init.body));
      if (init.method === "DELETE") rows.delete(user);
      return init.method ? new Response(null, { status: 204 }) : Response.json(rows.has(user) ? [rows.get(user)] : []);
    }
    if (path.includes("/mobilitylabs/user/login")) return Response.json(rejectLogin ? { code: rejectLogin } : {
      code: "01", data: [{ accessToken: `bus:${init.headers.email}`, tokenSecExpiration: 3600 }],
    });
    if (path.includes("/arrives/")) return Response.json({ code: "00", data: [{ Arrive: [] }] });
    throw new Error(`Unexpected mock request: ${new URL(path).pathname}`);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("per-user EMT connection", () => {
  it("encrypts credentials with fresh nonces and binds them to the app user", async () => {
    const input = { email: "alice@example.test", password: "secret" };
    const sealed = await sealCredentials(env, "alice", input);
    expect(JSON.stringify(sealed)).not.toContain("secret");
    expect(await openCredentials(env, "alice", sealed)).toEqual(input);
    expect((await sealCredentials(env, "alice", input)).iv).not.toBe(sealed.iv);
    await expect(openCredentials(env, "bob", sealed)).rejects.toMatchObject({ kind: "emt_account" });
    await expect(openCredentials(env, "alice", { ...sealed, ciphertext: "AAAA" })).rejects.toMatchObject({ kind: "emt_account" });
  });

  it("classifies metrics callers without recording identity", () => {
    const request = (headers) => new Request("https://account.test", { headers });
    expect(callerClass(request({}))).toBe("guest");
    expect(callerClass(request({ Authorization: "Bearer alice" }))).toBe("signed-in");
    expect(callerClass(request({ Authorization: "Bearer alice", "x-hubwise-emt": "connected" }))).toBe("connected");
    expect(callerClass(request({ Authorization: "Bearer alice", "x-hubwise-emt": "unconnected" }))).toBe("unconnected");
    expect(callerClass(request({ Authorization: "Bearer alice", "x-hubwise-emt": "unknown" }))).toBe("signed-in");
    expect(withEmtAccount(env, request({ Authorization: "Bearer alice", "x-hubwise-emt": "connected" })).EMT_CALLER).toBe("connected");
  });

  it("tags EMT calls made without a request as background", () => {
    const points = [];
    const METRICS = { writeDataPoint: (point) => points.push(point) };
    recordUpstreamMetric({ METRICS }, { endpoint: "arrivals" });
    recordUpstreamMetric({ METRICS, EMT_CALLER: "guest" }, { endpoint: "arrivals" });
    expect(points.map((point) => point.blobs[7])).toEqual(["background", "guest"]);
  });

  it("uses the shared login for guests and for users who never connected", async () => {
    expect((await call(`/arrivals?stop=${nextStop()}`, null)).status).toBe(200);
    expect((await call(`/arrivals?stop=${nextStop()}`, "carol")).status).toBe(200);
    expect(arrivalTokens()).toEqual(["shared-token", "shared-token"]);
    expect((await call("/auth/emt", null)).status).toBe(401);
  });

  it("validates before saving and returns no password", async () => {
    const result = await connect("alice");
    expect(result).toMatchObject({ connected: true, email: "alice@example.test" });
    expect(JSON.stringify(result)).not.toContain("password");
    expect(JSON.stringify(rows.get("alice"))).not.toContain("alice-password");
    const status = await call("/auth/emt");
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(await status.json()).toEqual(result);
    const original = rows.get("alice");
    rejectLogin = "89";
    const failed = await call("/auth/emt", "alice", "PUT", { email: "alice@example.test", password: "wrong" });
    expect(failed.status).toBe(403);
    expect((await failed.json()).error).toBe("emt_account");
    expect(rows.get("alice")).toEqual(original);
  });

  it("spends each connected user's own quota, never another's", async () => {
    await Promise.all([connect("alice"), connect("bob")]);
    const context = (user) => withEmtAccount(env, new Request("https://account.test", { headers: { Authorization: `Bearer ${user}` } }));
    expect(await Promise.all([getToken(context("alice")), getToken(context("bob"))]))
      .toEqual(["bus:alice@example.test", "bus:bob@example.test"]);
    upstream.mockClear();
    expect((await call(`/arrivals?stop=${nextStop()}`, "alice")).status).toBe(200);
    expect((await call(`/arrivals?stop=${nextStop()}`, "bob")).status).toBe(200);
    expect(arrivalTokens()).toEqual(["bus:alice@example.test", "bus:bob@example.test"]);
  });

  it("shares completed public payloads without spending anyone's quota again", async () => {
    await connect("alice");
    const shared = nextStop();
    expect((await call(`/arrivals?stop=${shared}`, "alice")).status).toBe(200);
    upstream.mockClear();
    expect((await call(`/arrivals?stop=${shared}`, null)).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("falls back to the shared login after disconnecting, without touching another user", async () => {
    await Promise.all([connect("alice"), connect("bob")]);
    expect((await call("/auth/emt", "alice", "DELETE")).status).toBe(200);
    upstream.mockClear();
    await call(`/arrivals?stop=${nextStop()}`, "alice");
    await call(`/arrivals?stop=${nextStop()}`, "bob");
    expect(arrivalTokens()).toEqual(["shared-token", "bus:bob@example.test"]);
  });

  it("tells a connected user to reconnect instead of quietly using the shared login", async () => {
    const connection = await connect("alice");
    await env.KV.delete(`emt:user:alice:${connection.connectionId}`);
    clearTokenMemoryForTest();
    rejectLogin = "89";
    const response = await call(`/arrivals?stop=${nextStop()}`, "alice");
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe("emt_account");
    expect(arrivalTokens()).toEqual([]);
  });

  it("reports quota exhaustion at connect time without saving", async () => {
    rejectLogin = "98";
    expect((await call("/auth/emt", "alice", "PUT", { email: "alice@example.test", password: "secret" })).status).toBe(503);
    expect(rows.size).toBe(0);
  });

  it("renews an expired cached token with that user's saved credentials", async () => {
    const connection = await connect("alice");
    await env.KV.put(`emt:user:alice:${connection.connectionId}`, JSON.stringify({ token: "expired", expiresAt: 1 }));
    clearTokenMemoryForTest();
    upstream.mockClear();
    expect((await call(`/arrivals?stop=${nextStop()}`)).status).toBe(200);
    const login = upstream.mock.calls.find(([url]) => String(url).includes("/mobilitylabs/user/login"));
    expect(login[1].headers).toEqual({ email: "alice@example.test", password: "alice-password" });
    expect(arrivalTokens()).toEqual(["bus:alice@example.test"]);
  });

  it("rejects malformed or oversized credentials before contacting EMT", async () => {
    for (const input of [{ email: "invalid", password: "x" }, { email: "a@b.test", password: "x\r\ny" }, { email: "a@b.test", password: "x".repeat(5000) }]) {
      expect((await call("/auth/emt", "alice", "PUT", input)).status).toBe(400);
    }
    expect(upstream.mock.calls.every(([url]) => String(url).includes("/auth/v1/user"))).toBe(true);
  });
});

describe("shared stop pollers and connected EMT accounts", () => {
  /** A runner for `user` with one device and a bus watch on `stop`, subscribed
   *  to that stop's poller the way the /tracking routes would. */
  async function tracker(user, stop) {
    const stub = env.TRACKING.get(env.TRACKING.idFromName(user));
    await stub.identify(user);
    await runInDurableObject(stub, (instance) => {
      instance.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES ('d', ?)", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: {} }));
      instance.save({ id: `w-${stop}`, kind: "bus", targetId: stop, line: "70", destination: "", label: "", revision: "r", state: {}, lastCheck: null, error: null });
    });
    await runInDurableObject(stub, (instance) => instance.sync());
    return stub;
  }
  const pollStop = (stop) => runDurableObjectAlarm(env.STOP_POLLER.get(env.STOP_POLLER.idFromName(stop)));

  it("polls a stop on its watcher's quota, and on the shared login after they disconnect", async () => {
    await connect("dave");
    await tracker("dave", "4242");
    upstream.mockClear();
    await pollStop("4242");
    expect(arrivalTokens()).toEqual(["bus:dave@example.test"]);

    expect((await call("/auth/emt", "dave", "DELETE")).status).toBe(200);
    upstream.mockClear();
    await pollStop("4242");
    expect(arrivalTokens()).toEqual(["shared-token"]);
  });

  it("takes turns between the connected watchers of a stop, one poll each", async () => {
    await Promise.all([connect("frank"), connect("gina")]);
    await tracker("frank", "5555");
    await tracker("gina", "5555");
    await tracker("hugo", "5555"); // never connected: watches for free, pays nothing
    const poller = env.STOP_POLLER.get(env.STOP_POLLER.idFromName("5555"));
    const tokens = await runInDurableObject(poller, async (instance) => {
      const seen = [];
      for (const slot of [0, 1, 2, 3]) {
        const [first] = await instance.environments(slot * 120_000);
        seen.push(first.EMT_EMAIL ?? "shared");
      }
      return seen;
    });
    expect(tokens).toEqual(["frank@example.test", "gina@example.test", "frank@example.test", "gina@example.test"]);
  });

  it("falls back to the shared login when the watcher's account is rejected, so alerts keep coming", async () => {
    const connection = await connect("ivy");
    await tracker("ivy", "6666");
    await env.KV.delete(`emt:user:ivy:${connection.connectionId}`);
    clearTokenMemoryForTest();
    rejectLogin = "89";
    upstream.mockClear();
    await pollStop("6666");
    rejectLogin = null;
    expect(arrivalTokens()).toEqual(["shared-token"]);
  });

  it("stores the connection in the runner once, not on every page load", async () => {
    await connect("erin");
    const runner = env.TRACKING.get(env.TRACKING.idFromName("erin"));
    await runInDurableObject(runner, (instance) => {
      let count = 0;
      const exec = instance.ctx.storage.sql.exec.bind(instance.ctx.storage.sql);
      instance.ctx.storage.sql.exec = (query, ...args) => { if (/INSERT|DELETE/.test(query)) count++; return exec(query, ...args); };
      instance.countMeta = () => count;
    });
    await call("/auth/emt", "erin");
    await call("/auth/emt", "erin");
    expect(await runInDurableObject(runner, (instance) => instance.countMeta())).toBe(0);
  });
});

describe("connecting is required for everyone", () => {
  // Production runs with EMT_ACCOUNT = "required". OWNER_USER_ID is
  // "owner-user-id" in vitest.config.js: the owner gets no exception.
  const owner = { EMT_ACCOUNT: "required" };
  const get = (path, user) => call(path, user, "GET", undefined, owner);

  it("refuses fresh EMT calls for guests and unconnected users, without spending any quota", async () => {
    for (const user of [null, "carol", "owner-user-id"]) {
      const response = await get(`/arrivals?stop=${nextStop()}`, user);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe("emt_account");
      expect(body.message).toMatch(/connect your EMT account/i);
    }
    expect(arrivalTokens()).toEqual([]);
  });

  it("tells the page connecting is required, owner included", async () => {
    const status = await get("/auth/emt", "owner-user-id");
    expect(await status.json()).toMatchObject({ connected: false, required: true });
  });

  it("uses a connected user's own login, and still serves cached payloads to anyone", async () => {
    await connect("alice");
    const stop = nextStop();
    expect((await get(`/arrivals?stop=${stop}`, "alice")).status).toBe(200);
    expect(arrivalTokens()).toEqual(["bus:alice@example.test"]);
    upstream.mockClear();
    expect((await get(`/arrivals?stop=${stop}`, null)).status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a bus alert from an unconnected user but not a bike alert", async () => {
    const tracking = { ...owner, VAPID_PUBLIC_KEY: "p", VAPID_PRIVATE_KEY: "k", VAPID_SUBJECT: "s" };
    const bus = await call("/tracking", "carol", "POST", { kind: "bus", targetId: "5138", line: "70" }, tracking);
    expect(bus.status).toBe(403);
    expect((await bus.json()).message).toMatch(/connect your EMT account/i);
    // With a device to notify, the same user's bike alert goes through: bike
    // counts come from the operator's feed and spend no EMT quota.
    const runner = env.TRACKING.get(env.TRACKING.idFromName("carol"));
    await runInDurableObject(runner, (instance) => {
      instance.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES ('d', ?)", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: {} }));
    });
    const bike = await call("/tracking", "carol", "POST", { kind: "bike", targetId: "1" }, tracking);
    expect(bike.status).toBe(200);
    expect((await bike.json()).watches).toHaveLength(1);
  });

  it("polls a stop only on its connected watchers' accounts, never the shared login", async () => {
    const poll = async (users, stop) => {
      for (const user of users) {
        const runner = env.TRACKING.get(env.TRACKING.idFromName(user));
        await runInDurableObject(runner, (instance) => {
          Object.assign(instance.env, owner);
          instance.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES ('d', ?)", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: {} }));
          instance.save({ id: `w-${stop}`, kind: "bus", targetId: stop, line: "70", destination: "", label: "", revision: "r", state: {}, lastCheck: null, error: null });
        });
        await runner.identify(user);
      }
      const poller = env.STOP_POLLER.get(env.STOP_POLLER.idFromName(stop));
      await runInDurableObject(poller, (instance) => { Object.assign(instance.env, owner); });
      upstream.mockClear();
      await runDurableObjectAlarm(poller);
      return arrivalTokens();
    };
    expect(await poll(["carol", "owner-user-id"], "7777")).toEqual([]);
    const carol = env.TRACKING.get(env.TRACKING.idFromName("carol"));
    expect((await carol.list()).watches[0].error).toMatch(/connect your EMT account/i);
    await connect("gina");
    expect(await poll(["gina", "owner-user-id"], "8888")).toEqual(["bus:gina@example.test"]);
  });
});
