import { env } from "cloudflare:test";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { getToken, getArrivals, getStopDetail } from "../src/emt.js";
import { EmtError } from "../src/errors.js";
import loginOk from "./fixtures/login-ok.json";
import loginBadPassword from "./fixtures/login-bad-password.json";
import arrivalsOk from "./fixtures/arrivals-ok.json";
import arrivalsEmpty from "./fixtures/arrivals-empty.json";
import stopDetailOk from "./fixtures/stop-detail-ok.json";

function mockFetch(body, init = {}) {
  // A fresh Response per call: response bodies are single-use.
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(JSON.stringify(body), { status: 200, ...init })
  );
}

describe("getToken", () => {
  beforeEach(async () => {
    await env.KV.delete("emt:token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs in and returns the access token", async () => {
    mockFetch(loginOk);
    const token = await getToken(env);
    expect(token).toBe("fake-token-abc123");
  });

  it("sends credentials as headers, not as a body", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v1/mobilitylabs/user/login/");
    expect(init.method).toBe("GET");
    expect(init.headers.email).toBe(env.EMT_EMAIL);
    expect(init.headers.password).toBe(env.EMT_PASSWORD);
    expect(init.body).toBeUndefined();
  });

  it("caches the token in KV so a second call makes no request", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    await getToken(env);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("re-logs in when force is set, even with a cached token", async () => {
    const spy = mockFetch(loginOk);
    await getToken(env);
    await getToken(env, { force: true });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws an auth error on code 89, a 200 response", async () => {
    mockFetch(loginBadPassword);
    await expect(getToken(env)).rejects.toMatchObject({
      name: "EmtError",
      kind: "auth",
    });
  });

  it("throws a quota error on code 98", async () => {
    mockFetch({ code: "98", description: "limit", data: [] });
    await expect(getToken(env)).rejects.toMatchObject({ kind: "quota" });
  });

  it("throws an upstream error on a non-200", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("gateway timeout", { status: 504 })
    );
    await expect(getToken(env)).rejects.toMatchObject({ kind: "upstream" });
  });
});

describe("getArrivals", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses line, seconds, and metres from data[0].Arrive[]", async () => {
    mockFetch(arrivalsOk);
    const result = await getArrivals(env, "1234");
    expect(result.arrivals[0]).toEqual({ line: "27", seconds: 145, metres: 610 });
  });

  it("sorts soonest-first and returns at most two", async () => {
    mockFetch(arrivalsOk);
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals.map((a) => a.seconds)).toEqual([145, 640]);
  });

  it("stamps fetchedAt so the page can show staleness", async () => {
    mockFetch(arrivalsOk);
    const before = Date.now();
    const { fetchedAt } = await getArrivals(env, "1234");
    expect(fetchedAt).toBeGreaterThanOrEqual(before);
  });

  it("posts stopId and the estimations flag in the body", async () => {
    const spy = mockFetch(arrivalsOk);
    await getArrivals(env, "1234");
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v2/transport/busemtmad/stops/1234/arrives/");
    expect(init.method).toBe("POST");
    expect(init.headers.accessToken).toBe("cached-token");
    expect(JSON.parse(init.body)).toEqual({
      stopId: "1234",
      Text_EstimationsRequired_YN: "Y",
    });
  });

  it("returns an empty list, not an error, when nothing is due", async () => {
    mockFetch(arrivalsEmpty);
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals).toEqual([]);
  });

  it("re-logs in once and retries when the token is rejected with code 80", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify(arrivalsOk)));

    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up with not_found after one failed retry", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })));

    await expect(getArrivals(env, "9999")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("tolerates a missing DistanceBus", async () => {
    mockFetch({
      code: "00",
      data: [{ Arrive: [{ line: "27", estimateArrive: 100 }] }],
    });
    const { arrivals } = await getArrivals(env, "1234");
    expect(arrivals[0]).toEqual({ line: "27", seconds: 100, metres: null });
  });
});

describe("getArrivals success codes", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("treats code 01 'No estimations found' as an empty success", async () => {
    // Verbatim shape observed live from EMT at night hours, 2026-08-23.
    mockFetch({
      code: "01",
      description: "No estimations found (lapsed: 90 millsecs)",
      datetime: "2026-08-23T00:28:43.293626",
      data: [{ Arrive: [], StopInfo: [], ExtraInfo: [], Incident: {} }],
    });
    const { arrivals } = await getArrivals(env, "213");
    expect(arrivals).toEqual([]);
  });

  it("still rejects genuinely unknown codes", async () => {
    mockFetch({ code: "42", description: "???", data: [] });
    await expect(getArrivals(env, "1234")).rejects.toMatchObject({
      kind: "upstream",
      message: expect.stringContaining("42"),
    });
  });
});

describe("getStopDetail", () => {
  beforeEach(async () => {
    await env.KV.put("emt:token", "cached-token");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses name, address, coordinates, and lines from data[0].stops[0]", async () => {
    mockFetch(stopDetailOk);
    const detail = await getStopDetail(env, "1547");
    expect(detail).toEqual({
      stopId: "1547",
      name: "PLAZA DE CASTILLA",
      address: "PASEO DE LA CASTELLANA 42",
      coordinates: [-3.6897, 40.4669],
      lines: ["27", "150", "N23"],
    });
  });

  it("GETs the v1 detail URL with the cached token", async () => {
    const spy = mockFetch(stopDetailOk);
    await getStopDetail(env, "1547");
    const [url, init] = spy.mock.calls[0];
    expect(url).toContain("v1/transport/busemtmad/stops/1547/detail/");
    expect(init.method).toBe("GET");
    expect(init.headers.accessToken).toBe("cached-token");
  });

  it("re-logs in once and retries when the token is rejected with code 80", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify(stopDetailOk)));
    const detail = await getStopDetail(env, "1547");
    expect(detail.name).toBe("PLAZA DE CASTILLA");
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("gives up with not_found when code 80 persists after a re-login", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify(loginOk)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: "80", data: [] })));
    await expect(getStopDetail(env, "9999")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("maps code 81 (no such record) straight to not_found without a retry", async () => {
    const spy = mockFetch({
      code: "81",
      description: "There are no such records",
      data: [],
    });
    await expect(getStopDetail(env, "99999999")).rejects.toMatchObject({
      kind: "not_found",
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("rejects a success code carrying no stops data", async () => {
    mockFetch({ code: "00", description: "Data recovered OK", data: [{}] });
    await expect(getStopDetail(env, "1547")).rejects.toMatchObject({
      kind: "not_found",
    });
  });
});
