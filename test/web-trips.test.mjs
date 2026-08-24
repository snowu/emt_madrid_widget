import test from "node:test";
import assert from "node:assert/strict";
import { mergeTripHistory, tripIdentity, tripsAreOldestFirst } from "../web/trips.js";

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
