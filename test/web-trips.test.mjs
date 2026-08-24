import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeTripHistory,
  materialTripChanges,
  tripIdentity,
  tripsAreOldestFirst,
  updateTripDiagnostics,
  TRIP_DIAGNOSTIC_RETENTION_MS,
} from "../web/trips.js";

test("uses trip id as the preferred stable identity", () => {
  assert.equal(tripIdentity({ tripId: 42, bikeNumber: "1" }), "id:42");
  assert.equal(tripIdentity({ bikeNumber: "1", interval: "today", minutes: 3, cost: 0 }),
    "row:1:today:3:0");
});

test("newest-first sync prepends new rows and refreshes overlaps", () => {
  const cached = [{ tripId: 3, cost: 1 }, { tripId: 2 }, { tripId: 1 }];
  const fresh = [{ tripId: 4 }, { tripId: 3, cost: 2 }];
  assert.equal(tripsAreOldestFirst(cached), false);
  assert.deepEqual(mergeTripHistory(cached, fresh, false), [
    { tripId: 4 }, { tripId: 3, cost: 2 }, { tripId: 2 }, { tripId: 1 },
  ]);
});

test("oldest-first sync keeps cached order and appends the new tail", () => {
  const cached = [{ tripId: 1 }, { tripId: 2 }, { tripId: 3, cost: 1 }];
  const fresh = [{ tripId: 3, cost: 2 }, { tripId: 4 }];
  assert.equal(tripsAreOldestFirst(cached), true);
  assert.deepEqual(mergeTripHistory(cached, fresh, true), [
    { tripId: 1 }, { tripId: 2 }, { tripId: 3, cost: 2 }, { tripId: 4 },
  ]);
});

test("captures only material changes for an existing trip", () => {
  const before = [{ tripId: 4, minutes: 720, cost: 20, resultingBalance: 4, bikeNumber: "8" }];
  const after = [{ tripId: 4, minutes: 13, cost: 0.5, resultingBalance: 23.5, bikeNumber: "8" }];
  const diagnostics = updateTripDiagnostics(before, after, {}, 1_000);
  assert.deepEqual(diagnostics["id:4"], {
    lastChangedAt: 1_000,
    revisions: [{
      observedAt: 1_000,
      changes: [
        { field: "minutes", from: 720, to: 13 },
        { field: "cost", from: 20, to: 0.5 },
        { field: "resultingBalance", from: 4, to: 23.5 },
      ],
    }],
  });
  assert.equal(materialTripChanges(before[0], { ...before[0], bikeNumber: "0008" }).length, 0);
});

test("does not create revisions for new or unchanged trips", () => {
  assert.deepEqual(updateTripDiagnostics([], [{ tripId: 1, cost: 2 }], {}, 2_000), {});
  assert.deepEqual(updateTripDiagnostics([{ tripId: 1, cost: 2 }], [{ tripId: 1, cost: 2 }], {}, 2_000), {});
});

test("keeps revision history bounded and expires it after 48 quiet hours", () => {
  let diagnostics = {};
  for (let cost = 1; cost <= 6; cost += 1) {
    diagnostics = updateTripDiagnostics(
      [{ tripId: 1, cost: cost - 1 }],
      [{ tripId: 1, cost }],
      diagnostics,
      cost * 1_000,
    );
  }
  assert.equal(diagnostics["id:1"].revisions.length, 4);
  assert.deepEqual(
    updateTripDiagnostics([], [], diagnostics, 6_000 + TRIP_DIAGNOSTIC_RETENTION_MS + 1),
    {},
  );
});
