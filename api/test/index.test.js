import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";
import { clearTokenMemoryForTest } from "../src/emt.js";
import { clearBikeSessionMemoryForTest } from "../src/bicimad-account.js";
import arrivalsOk from "./fixtures/arrivals-ok.json";
import stopDetailOk from "./fixtures/stop-detail-ok.json";
import arroundxyOk from "./fixtures/arroundxy-ok.json";

async function call(path, init) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://w.dev${path}`, init), env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeEach(async () => {
  clearTokenMemoryForTest();
  clearBikeSessionMemoryForTest();
  await env.KV.put("emt:token", "cached-token");
  await env.KV.delete("bicimad:owner-session");
  await env.KV.delete("arrivals:v4:1234");
});
afterEach(() => vi.restoreAllMocks());

describe("CORS", () => {
  it("answers preflight with the allowed origin", async () => {
    const res = await call("/stops", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("lets browsers reuse the public auth configuration", async () => {
    const res = await call("/auth/config");
    expect(res.headers.get("cache-control")).toBe("public, max-age=86400");
  });
});

describe("personal data protection", () => {
  it("rejects a POST without a user session", async () => {
    const res = await call("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId: "1234" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a DELETE without a user session", async () => {
    const res = await call("/stops/u1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("rejects a PATCH without a user session", async () => {
    const res = await call("/stops/u1", {
      method: "PATCH",
      body: JSON.stringify({ label: "home" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a personalized GET without a user session", async () => {
    const res = await call("/stops");
    expect(res.status).toBe(401);
  });
});

describe("GET /arrivals", () => {
  it("returns parsed arrivals", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(arrivalsOk), { status: 200 })
    );
    const res = await call("/arrivals?stop=1234");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.arrivals).toHaveLength(2);
  });

  it("serves the second call from cache, making no upstream request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(arrivalsOk), { status: 200 })
    );
    await call("/arrivals?stop=1234");
    const res = await call("/arrivals?stop=1234");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await res.json()).arrivals).toHaveLength(2);
  });

  it("coalesces simultaneous cache misses into one upstream request", async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await gate;
      return new Response(JSON.stringify(arrivalsOk), { status: 200 });
    });
    const first = call("/arrivals?stop=987654");
    await Promise.resolve();
    const second = call("/arrivals?stop=987654&limit=20");
    release();
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("serves two arrivals by default and the whole board on request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(arrivalsOk), { status: 200 })
    );
    expect((await (await call("/arrivals?stop=1234")).json()).arrivals).toHaveLength(2);
    // Same cached payload, wider slice — no second upstream call.
    expect((await (await call("/arrivals?stop=1234&limit=20")).json()).arrivals)
      .toHaveLength(3);
  });

  it("requires a stop parameter", async () => {
    const res = await call("/arrivals");
    expect(res.status).toBe(400);
  });

  it("reports quota exhaustion as 503", async () => {
    await env.KV.delete("emt:token");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ code: "98", data: [] }), { status: 200 })
    );
    const res = await call("/arrivals?stop=1234");
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("quota");
  });
});

describe("GET /stops/:id/detail", () => {
  beforeEach(async () => {
    await env.KV.delete("detail:v4:31");
  });

  it("returns parsed stop detail", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(stopDetailOk), { status: 200 })
    );
    const res = await call("/stops/1547/detail");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "Plaza Castilla" });
  });

  it("serves the second call from cache, making no upstream request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(stopDetailOk), { status: 200 })
    );
    await call("/stops/1547/detail");
    const res = await call("/stops/1547/detail");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await res.json()).stopId).toBe("31");
  });

  it("reports an unknown stop as 404", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(
        JSON.stringify({ code: "81", description: "no such records", data: [] }),
        { status: 200 }
      )
    );
    const res = await call("/stops/99999999/detail");
    expect(res.status).toBe(404);
  });
});

describe("GET /bikes/account", () => {
  const userAuth = { headers: { Authorization: "Bearer user-jwt" } };

  it("does not expose account status without a user session", async () => {
    expect((await call("/bikes/account")).status).toBe(401);
  });

  it("does not expose account status to another signed-in user", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "friend-user-id", email: "friend@example.com",
    }), { status: 200 }));
    expect((await call("/bikes/account", userAuth)).status).toBe(403);
  });

  it("returns only a normalized eligibility summary", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({
        id: env.OWNER_USER_ID, email: "owner@example.com",
      }), { status: 200 });
      if (String(url).includes("/identity/login/integrator")) return new Response(JSON.stringify({
        code: "00", data: [{ accessToken: "fresh-mpass-token", idUser: "mpass-user", email: "owner@example.com", tokenSecExpiration: 3600 }],
      }), { status: 200 });
      return new Response(JSON.stringify({
        code: "01",
        description: "El usuario tiene contratos",
        data: {
          CD_USER: "private-user-id",
          DS_EMAIL: "private@example.com",
          DS_NIF: "private-nif",
          IT_STATUS: true,
          IT_BLOCKED: false,
          NM_BLOCK_CHANGES: false,
          NM_STATE: 4,
          dataContract: [{ CD_CONTRACT: "private-contract-id", IT_ACTIVE: true, IT_STATUS: true }],
        },
      }), { status: 200 });
    });

    const res = await call("/bikes/account", userAuth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      accountEnabled: true,
      blocked: false,
      changesBlocked: false,
      activeContract: true,
      stateCode: 4,
      accountReady: true,
    });
    const [, init] = spy.mock.calls.find(([url]) => String(url).includes("/bicimad/userdata/"));
    expect(init.headers).toMatchObject({
      accessToken: "fresh-mpass-token",
      userId: "mpass-user",
      deviceId: env.MPASS_DEVICE_ID,
      email: "owner@example.com",
    });
    expect(JSON.stringify(body)).not.toContain("private-user-id");
    expect(JSON.stringify(body)).not.toContain("private@example.com");

    // Ordinary checks reuse the normalized private session value. Explicit
    // refresh bypasses it without throwing away the still-valid MPass login.
    expect((await call("/bikes/account", userAuth)).status).toBe(200);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/bicimad/userdata/")))
      .toHaveLength(1);
    expect((await call("/bikes/account?refresh=1", userAuth)).status).toBe(200);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/bicimad/userdata/")))
      .toHaveLength(2);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/identity/login/integrator")))
      .toHaveLength(1);
  });

  it("shares one MPass login across simultaneous owner requests", async () => {
    let releaseLogin;
    let markLoginStarted;
    const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
    const loginStarted = new Promise((resolve) => { markLoginStarted = resolve; });
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({
        id: env.OWNER_USER_ID, email: "owner@example.com",
      }), { status: 200 });
      if (String(url).includes("/identity/login/integrator")) {
        markLoginStarted();
        await loginGate;
        return new Response(JSON.stringify({
          code: "00", data: [{ accessToken: "shared-token", idUser: "mpass-user", email: "owner@example.com", tokenSecExpiration: 3600 }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        code: "01", data: { IT_STATUS: true, IT_BLOCKED: false, NM_BLOCK_CHANGES: false, NM_STATE: 4,
          dataContract: [{ IT_ACTIVE: true, IT_STATUS: true }] },
      }), { status: 200 });
    });

    const first = call("/bikes/account", userAuth);
    await loginStarted;
    const second = call("/bikes/account", userAuth);
    await Promise.resolve();
    releaseLogin();
    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/identity/login/integrator")))
      .toHaveLength(1);
  });

  it("reports an expired BiciMAD session as auth, not blocked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({
        id: env.OWNER_USER_ID,
      }), { status: 200 });
      if (String(url).includes("/identity/login/integrator")) return new Response(JSON.stringify({
        code: "00", data: [{ accessToken: "still-bad", idUser: "mpass-user", email: "owner@example.com", tokenSecExpiration: 3600 }],
      }), { status: 200 });
      return new Response(JSON.stringify({ code: "80", description: "invalid token" }), { status: 401 });
    });
    const res = await call("/bikes/account", userAuth);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "auth" });
  });
});

describe("GET /bikes/trips", () => {
  const userAuth = { headers: { Authorization: "Bearer user-jwt" } };

  it("is owner-only", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      id: "friend-user-id", email: "friend@example.com",
    }), { status: 200 }));
    expect((await call("/bikes/trips", userAuth)).status).toBe(403);
  });

  it("normalizes and filters rides without returning account identifiers", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/auth/v1/user")) return new Response(JSON.stringify({
        id: env.OWNER_USER_ID, email: "owner@example.com",
      }), { status: 200 });
      if (String(url).includes("/identity/login/integrator")) return new Response(JSON.stringify({
        code: "00", data: [{ accessToken: "trip-token", idUser: "mpass-user", email: "owner@example.com" }],
      }), { status: 200 });
      if (String(url).includes("/bicimad/userdata/")) return new Response(JSON.stringify({
        code: "01", data: { DS_NIF: "private-nif", DS_EMAIL: "private@example.com" },
      }), { status: 200 });
      return new Response(JSON.stringify({
        code: "00",
        data: [
          { trip_id: 1, id_bike: "00018302", undock: "2026-08-24T08:10:00+02:00", dock: { timestamp: "2026-08-24T08:28:00+02:00" }, trip_minutes: 18, trip_cost: 0.5, old_amount: 8, new_amount: 7.5, internal_secret: "nope" },
          { trip_id: 2, id_bike: 9999, undock: true, dock: true, trip_interval: "24/08/2026 09:30", message_timestamp: "24/08/2026 07:37", trip_minutes: 7, trip_cost: 0 },
        ],
      }), { status: 200 });
    });

    const res = await call("/bikes/trips?page=2&bike=18302", userAuth);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      page: 2,
      bikeNumber: "18302",
      internalBikeId: "00018302",
      countOnPage: 2,
      matchedOnPage: [{
        tripId: 1,
        bikeNumber: "18302",
        startedAt: "2026-08-24T08:10:00+02:00",
        endedAt: "2026-08-24T08:28:00+02:00",
        minutes: 18,
        cost: 0.5,
      }],
    });
    expect(body.fields).toContain("internal_secret");
    expect(JSON.stringify(body)).not.toContain("private-nif");
    expect(JSON.stringify(body)).not.toContain("private@example.com");
    expect(JSON.stringify(body)).not.toContain("nope");
    const [, init] = spy.mock.calls.find(([url]) => String(url).includes("/bicimad/trips/"));
    expect(init.headers).toMatchObject({ nif: "private-nif", session: "mpass-user", page: "2" });

    // The NIF is retained only inside the secret owner session. Later pages
    // skip the otherwise-identical userdata request.
    const later = await call("/bikes/trips?page=3", userAuth);
    expect(later.status).toBe(200);
    expect((await later.json()).matchedOnPage[1]).toMatchObject({
      startedAt: "24/08/2026 09:30",
      endedAt: "24/08/2026 09:37:00",
    });
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/bicimad/userdata/")))
      .toHaveLength(1);
  });
});

describe("bike request consolidation", () => {
  it("returns nearby and saved stations from one pair of GBFS reads", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).endsWith("station_information")) return new Response(JSON.stringify({
        data: { stations: [
          { station_id: "a", short_name: "1", name: "Near", lat: 40.41, lon: -3.70, capacity: 20 },
          { station_id: "b", short_name: "2", name: "Saved far", lat: 40.43, lon: -3.72, capacity: 25 },
        ] },
      }));
      return new Response(JSON.stringify({ data: { stations: [
        { station_id: "a", num_bikes_available: 3, num_bikes_disabled: 1, num_docks_available: 16, is_renting: 1, is_returning: 1, is_installed: 1, status: "IN_SERVICE" },
        { station_id: "b", num_bikes_available: 5, num_bikes_disabled: 0, num_docks_available: 20, is_renting: 1, is_returning: 1, is_installed: 1, status: "IN_SERVICE" },
      ] } }));
    });

    const res = await call("/bikes/nearby?lat=40.41&lon=-3.70&radius=100&ids=b");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.stations.map((station) => station.id)).toEqual(["a"]);
    expect(body.savedStations.map((station) => station.id)).toEqual(["b"]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("lets PostgREST validate rating JWTs without a redundant auth lookup", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([
      { bike_number: "18302", rating: 5, updated_at: "2026-08-23T00:00:00Z" },
    ]), { status: 200 }));
    const res = await call("/bikes/ratings", {
      headers: { Authorization: "Bearer user-jwt" },
    });
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain("/rest/v1/bike_ratings");
  });
});

describe("GET /stops/nearby", () => {
  beforeEach(async () => {
    await env.KV.delete("nearby:v4:-3.6897:40.4674:500");
  });

  it("requires lat and lon", async () => {
    expect((await call("/stops/nearby")).status).toBe(400);
    expect((await call("/stops/nearby?lat=40.4")).status).toBe(400);
  });

  it("returns stops within the radius", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(arroundxyOk), { status: 200 })
    );
    const res = await call("/stops/nearby?lat=40.4674&lon=-3.6897");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.map((s) => s.stopId)).toEqual(["30", "31"]);
  });

  it("serves a repeat of the same cell from cache, making no upstream request", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify(arroundxyOk), { status: 200 })
    );
    await call("/stops/nearby?lat=40.4674&lon=-3.6897");
    const res = await call("/stops/nearby?lat=40.4674&lon=-3.6897");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await res.json()).toHaveLength(2);
  });
});

describe("PATCH /stops/:id", () => {
  const key = { headers: { Authorization: "Bearer user-jwt" } };

  it("renames a saved stop", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([{ id: "u1", stop_id: "30", label: "Home" }]), {
        status: 200,
      })
    );
    const res = await call("/stops/u1", {
      method: "PATCH",
      body: JSON.stringify({ label: "Home" }),
      ...key,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ label: "Home" });
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("id=eq.u1");
    expect(init.method).toBe("PATCH");
  });

  it("404s when no such row comes back", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("/stops/nope", {
      method: "PATCH",
      body: JSON.stringify({ label: "x" }),
      ...key,
    });
    expect(res.status).toBe(404);
  });
});

describe("unknown routes", () => {
  it("404s", async () => {
    expect((await call("/nope")).status).toBe(404);
  });
});
