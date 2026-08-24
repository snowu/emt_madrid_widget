import { describe, it, expect } from "vitest";
import {
  boardHasLine,
  nearbyAccess,
  planJourney,
  stopsWithLiveLines,
} from "../src/journey-planner.js";

const stop = (stopId, lon, lat, lines = []) => ({
  stopId, coordinates: [lon, lat], lines: lines.map((line) => ({ line, label: line })),
});
const route = (line, toA, toB = []) => ({ line, stops: { toA, toB } });

describe("journey planner", () => {
  it("keeps only lines with live predictions at each boarding stop", () => {
    const stops = [
      { stopId: "1836", lines: [{ label: "29" }, { label: "N2" }] },
      { stopId: "213", lines: [{ label: "70" }] },
    ];
    const boards = new Map([
      ["1836", { arrivals: [{ line: "N2", seconds: 300 }] }],
      ["213", { arrivals: [] }],
    ]);
    expect(stopsWithLiveLines(stops, boards)).toEqual([
      { stopId: "1836", lines: [{ label: "N2" }] },
    ]);
  });

  it("matches onward lines against live transfer predictions", () => {
    const board = { arrivals: [{ line: "N1" }, { line: "N2" }] };
    expect(boardHasLine(board, { line: "N2" })).toBe(true);
    expect(boardHasLine(board, { label: "29" })).toBe(false);
  });

  it("sorts nearby access stops by walking distance", () => {
    const result = nearbyAccess([
      stop("far", -3.70, 40.42), stop("near", -3.7001, 40.4001),
    ], { lat: 40.4, lon: -3.7 });
    expect(result.map((item) => item.stopId)).toEqual(["near", "far"]);
  });

  it("accepts a direct line only in the direction that reaches the destination", () => {
    const a = { ...stop("a", -3.70, 40.40, ["107"]), distanceM: 80 };
    const z = { ...stop("z", -3.68, 40.46, ["107"]), distanceM: 120 };
    const routes = new Map([["107", route("107", [a, stop("m", -3.69, 40.43), z], [z, a])]]);
    const result = planJourney({ originStops: [a], destinationStops: [z], routes });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "direct", firstLeg: { line: "107", direction: "toA", stops: 2 } });
  });

  it("finds a one-transfer route at nearby stops", () => {
    const home = { ...stop("home", -3.70, 40.40, ["70"]), distanceM: 60 };
    const work = { ...stop("work", -3.66, 40.48, ["27"]), distanceM: 90 };
    const x1 = stop("x1", -3.6800, 40.4500);
    const x2 = stop("x2", -3.6805, 40.4503);
    const routes = new Map([
      ["70", route("70", [home, x1])],
      ["27", route("27", [x2, work])],
    ]);
    const result = planJourney({ originStops: [home], destinationStops: [work], routes });
    expect(result[0]).toMatchObject({
      type: "one_transfer", firstLeg: { line: "70" }, secondLeg: { line: "27" },
      transfer: { fromStop: { stopId: "x1" }, toStop: { stopId: "x2" } },
    });
  });

  it("does not invent a transfer when interchange stops are too far apart", () => {
    const home = { ...stop("home", -3.70, 40.40, ["70"]), distanceM: 60 };
    const work = { ...stop("work", -3.66, 40.48, ["27"]), distanceM: 90 };
    const routes = new Map([
      ["70", route("70", [home, stop("x1", -3.68, 40.45)])],
      ["27", route("27", [stop("x2", -3.67, 40.46), work])],
    ]);
    expect(planJourney({ originStops: [home], destinationStops: [work], routes })).toEqual([]);
  });
});
