import { env, createExecutionContext, waitOnExecutionContext, runInDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import worker from "../src/index.js";
import { sealCredentials, openCredentials, withEmtAccount } from "../src/emt-account.js";
import { getToken, clearTokenMemoryForTest } from "../src/emt.js";

// Supabase (auth + the emt_accounts table) and EMT are stubbed; the bearer
// token doubles as the user id. EMT logins answer with a token naming the
// email, so every assertion can see whose quota a call spent.
const rows = new Map();
let upstream;
let rejectLogin;
async function call(path, user = "alice", method = "GET", body) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://account.test${path}`, {
    method, headers: { ...(user ? { Authorization: `Bearer ${user}` } : {}), "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }), env, ctx);
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

describe("tracking with a connected EMT account", () => {
  it("runs bus checks on the user's quota, and on the shared login after disconnecting", async () => {
    await connect("dave");
    const runner = env.TRACKING.get(env.TRACKING.idFromName("dave"));
    expect(await runInDurableObject(runner, (instance) => instance.emtAccount()?.userId)).toBe("dave");
    await runInDurableObject(runner, (instance) => {
      instance.ctx.storage.sql.exec("INSERT OR REPLACE INTO devices VALUES ('d', ?)", JSON.stringify({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys: {} }));
      instance.save({ id: "w", kind: "bus", targetId: "4242", line: "70", destination: "", label: "", revision: "r", state: {}, lastCheck: null, error: null });
      instance.dueOverride = true;
    });
    await runInDurableObject(runner, (_, ctx) => ctx.storage.setAlarm(Date.now() + 100));
    upstream.mockClear();
    await runDurableObjectAlarm(runner);
    expect(arrivalTokens()).toEqual(["bus:dave@example.test"]);

    expect((await call("/auth/emt", "dave", "DELETE")).status).toBe(200);
    expect(await runInDurableObject(runner, (instance) => instance.emtAccount())).toBeNull();
    upstream.mockClear();
    await runInDurableObject(runner, (_, ctx) => ctx.storage.setAlarm(Date.now() + 100));
    await runDurableObjectAlarm(runner);
    expect(arrivalTokens()).toEqual(["shared-token"]);
  });

  it("stores the connection in the runner once, not on every page load", async () => {
    await connect("erin");
    const runner = env.TRACKING.get(env.TRACKING.idFromName("erin"));
    const writes = await runInDurableObject(runner, (instance) => {
      let count = 0;
      const exec = instance.ctx.storage.sql.exec.bind(instance.ctx.storage.sql);
      instance.ctx.storage.sql.exec = (query, ...args) => { if (/INSERT|DELETE/.test(query)) count++; return exec(query, ...args); };
      instance.countMeta = () => count;
      return 0;
    });
    expect(writes).toBe(0);
    await call("/auth/emt", "erin");
    await call("/auth/emt", "erin");
    expect(await runInDurableObject(runner, (instance) => instance.countMeta())).toBe(0);
  });
});
