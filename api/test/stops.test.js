import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import { listStops, addStop, removeStop } from "../src/stops.js";

const token = "test-user-token";

function mockFetch(body, init = {}) {
  // A fresh Response per call: response bodies are single-use, and
  // null-body statuses (204 etc.) must be constructed without a body.
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const nullBody = [204, 205, 304].includes(init.status);
    return new Response(nullBody ? null : JSON.stringify(body), {
      headers: { "content-type": "application/json" },
      ...init,
    });
  });
}

afterEach(() => vi.restoreAllMocks());

describe("listStops", () => {
  it("returns the rows Supabase sends", async () => {
    mockFetch([{ id: "u1", stop_id: "1234", label: "home", enabled: true }]);
    const stops = await listStops(env, token);
    expect(stops).toEqual([
      { id: "u1", stop_id: "1234", label: "home", enabled: true },
    ]);
  });

  it("sends the service key in both required headers", async () => {
    const spy = mockFetch([]);
    await listStops(env, token);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("/rest/v1/bus_stops");
    expect(init.headers.apikey).toBe(env.SUPABASE_ANON_KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it("raises upstream when Supabase errors", async () => {
    mockFetch({ message: "boom" }, { status: 500 });
    await expect(listStops(env, token)).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("addStop", () => {
  it("returns the created row", async () => {
    mockFetch([{ id: "u2", stop_id: "5678", label: null, enabled: true }]);
    const row = await addStop(env, token, { stopId: "5678", label: null });
    expect(row.stop_id).toBe("5678");
  });

  it("asks Supabase to return the inserted representation", async () => {
    const spy = mockFetch([{ id: "u2", stop_id: "5678" }]);
    await addStop(env, token, { stopId: "5678", label: "work" });
    const [, init] = spy.mock.calls[0];
    expect(init.method).toBe("POST");
    expect(init.headers.Prefer).toContain("return=representation");
    expect(JSON.parse(init.body)).toEqual({ stop_id: "5678", label: "work" });
  });

  it("rejects a non-numeric stop id before calling Supabase", async () => {
    const spy = mockFetch([]);
    await expect(addStop(env, token, { stopId: "abc" })).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("removeStop", () => {
  it("deletes by row id", async () => {
    const spy = mockFetch([], { status: 204 });
    await removeStop(env, token, "u1");
    const [url, init] = spy.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("id=eq.u1");
  });
});
