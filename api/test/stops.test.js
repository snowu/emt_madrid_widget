import { env } from "cloudflare:test";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listStops,
  addStop,
  removeStop,
  listBikeRatings,
  rateBike,
  listPlaces,
  addPlace,
  updatePlace,
} from "../src/stops.js";

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

describe("bike ratings", () => {
  it("lists only the columns needed by the UI", async () => {
    const spy = mockFetch([{ bike_number: "18302", rating: 4 }]);
    await expect(listBikeRatings(env, token)).resolves.toHaveLength(1);
    expect(spy.mock.calls[0][0]).toContain("bike_ratings?select=bike_number,rating,updated_at");
  });

  it("normalizes the displayed number and upserts the rating", async () => {
    const spy = mockFetch([{ bike_number: "18302", rating: 5 }]);
    await rateBike(env, token, { bikeNumber: "00018302", rating: 5 });
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("on_conflict=user_id,bike_number");
    expect(init.headers.Prefer).toContain("resolution=merge-duplicates");
    expect(JSON.parse(init.body)).toMatchObject({ bike_number: "18302", rating: 5 });
  });

  it("rejects ratings outside 1–5 before calling Supabase", async () => {
    const spy = mockFetch([]);
    await expect(rateBike(env, token, { bikeNumber: "18302", rating: 6 }))
      .rejects.toMatchObject({ kind: "not_found" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("places", () => {
  it("lists only the user's place fields", async () => {
    const spy = mockFetch([{ id: "p1", name: "Work", lat: 40.4, lon: -3.7 }]);
    await expect(listPlaces(env, token)).resolves.toHaveLength(1);
    expect(spy.mock.calls[0][0]).toContain("places?select=id,name,lat,lon");
  });

  it("creates an actual location with sensible default radii", async () => {
    const spy = mockFetch([{ id: "p1", name: "Work" }]);
    await addPlace(env, token, { name: " Work ", lat: 40.46, lon: -3.68 });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({
      name: "Work", lat: 40.46, lon: -3.68,
      geofence_radius_m: 200, destination_radius_m: 700,
    });
  });

  it("rejects invalid coordinates before touching Supabase", async () => {
    const spy = mockFetch([]);
    await expect(addPlace(env, token, { name: "Nowhere", lat: 140, lon: -3.7 }))
      .rejects.toMatchObject({ kind: "not_found" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("patches only supplied fields", async () => {
    const spy = mockFetch([{ id: "p1", name: "Office" }]);
    await updatePlace(env, token, "p1", { name: "Office" });
    const body = JSON.parse(spy.mock.calls[0][1].body);
    expect(body.name).toBe("Office");
    expect(body).not.toHaveProperty("lat");
    expect(body.updated_at).toBeTruthy();
  });
});
