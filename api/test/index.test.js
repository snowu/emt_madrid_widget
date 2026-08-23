import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "../src/index.js";
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
  await env.KV.put("emt:token", "cached-token");
  await env.KV.delete("arrivals:v4:1234");
});
afterEach(() => vi.restoreAllMocks());

describe("CORS", () => {
  it("answers preflight with the allowed origin", async () => {
    const res = await call("/stops", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(env.ALLOWED_ORIGIN);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-App-Key");
  });
});

describe("write protection", () => {
  it("rejects a POST without the app key", async () => {
    const res = await call("/stops", {
      method: "POST",
      body: JSON.stringify({ stopId: "1234" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a DELETE without the app key", async () => {
    const res = await call("/stops/u1", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("rejects a PATCH without the app key", async () => {
    const res = await call("/stops/u1", {
      method: "PATCH",
      body: JSON.stringify({ label: "home" }),
    });
    expect(res.status).toBe(401);
  });

  it("allows a GET without the app key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), { status: 200 })
    );
    const res = await call("/stops");
    expect(res.status).toBe(200);
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
  const key = { headers: { "X-App-Key": env.APP_KEY } };

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
