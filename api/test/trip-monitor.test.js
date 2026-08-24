import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { clearBikeSessionMemoryForTest } from "../src/bicimad-account.js";
import worker from "../src/index.js";
import {
  getBikeTripDiagnostics,
  monitorBikeTrips,
  nextTripMonitorState,
  tripMonitorInternals,
} from "../src/trip-monitor.js";

beforeEach(async () => {
  clearBikeSessionMemoryForTest();
  await env.KV.delete("bicimad:owner-session");
  await env.KV.delete(tripMonitorInternals.MONITOR_KEY);
});
afterEach(() => vi.restoreAllMocks());

describe("trip monitor state", () => {
  it("creates a baseline without calling it a correction", () => {
    const state = nextTripMonitorState({}, [{ tripId: 1, bikeNumber: "8", cost: 20 }], 1_000);
    expect(state.diagnostics).toEqual({});
    expect(state.trips["id:1"].cost).toBe(20);
  });

  it("records bounded material changes and expires them after 48 quiet hours", () => {
    let state = nextTripMonitorState({}, [{ tripId: 1, cost: 20, minutes: 700 }], 1_000);
    state = nextTripMonitorState(state, [{ tripId: 1, cost: 0.5, minutes: 13 }], 2_000);
    expect(state.diagnostics["id:1"].revisions[0].changes).toEqual([
      { field: "minutes", from: 700, to: 13 },
      { field: "cost", from: 20, to: 0.5 },
    ]);
    state = nextTripMonitorState(
      state,
      [{ tripId: 1, cost: 0.5, minutes: 13 }],
      2_000 + tripMonitorInternals.RETENTION_MS + 1,
    );
    expect(state.diagnostics).toEqual({});
  });
});

describe("scheduled trip monitoring", () => {
  it("polls page zero and stores a correction for the authenticated UI", async () => {
    let cost = 20;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("/identity/login/integrator")) return new Response(JSON.stringify({
        code: "00", data: [{ accessToken: "trip-token", idUser: "mpass-user", email: "owner@example.com" }],
      }));
      if (String(url).includes("/bicimad/userdata/")) return new Response(JSON.stringify({
        code: "01", data: { DS_NIF: "private-nif" },
      }));
      return new Response(JSON.stringify({
        code: "00",
        data: [{ trip_id: 7, id_bike: "00018302", trip_minutes: cost === 20 ? 700 : 13, trip_cost: cost }],
      }));
    });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "*/30 * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    cost = 0.5;
    const observedAt = Date.now() + 1;
    expect(await monitorBikeTrips(env, { observedAt })).toMatchObject({ changed: true, monitoredTrips: 1 });
    const result = await getBikeTripDiagnostics(env, observedAt);
    expect(result).toMatchObject({ monitoring: true, initialized: true });
    expect(result.diagnostics["id:7"].revisions[0].changes).toEqual([
      { field: "minutes", from: 700, to: 13 },
      { field: "cost", from: 20, to: 0.5 },
    ]);
    expect(spy.mock.calls.filter(([url]) => String(url).includes("/bicimad/trips/"))).toHaveLength(2);
  });
});
