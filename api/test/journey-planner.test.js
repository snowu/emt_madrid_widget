import { describe, it, expect } from "vitest";
import {
  boardHasLine,
  deduplicateJourneyOptions,
  estimateJourneySeconds,
  linesMatch,
  nearbyAccess,
  planJourney,
  prioritizeAccessStops,
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
      ["213", null],
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

  it("matches EMT's padded static codes to live arrival labels", () => {
    const stops = [{ stopId: "213", lines: [{ line: "070", label: "070" }] }];
    const boards = new Map([["213", { arrivals: [{ line: "70", seconds: 300 }] }]]);
    expect(stopsWithLiveLines(stops, boards)[0].lines).toEqual([{ line: "070", label: "070" }]);
    expect(boardHasLine(boards.get("213"), { line: "070" })).toBe(true);
    expect(linesMatch({ line: "005" }, { label: "5" })).toBe(true);
  });

  it("sorts nearby access stops by walking distance", () => {
    const result = nearbyAccess([
      stop("far", -3.70, 40.42), stop("near", -3.7001, 40.4001),
    ], { lat: 40.4, lon: -3.7 });
    expect(result.map((item) => item.stopId)).toEqual(["near", "far"]);
  });

  it("keeps a direct ride that scores worse than the transfers filling the limit", () => {
    // Reproduces the 29 at Arturo Soria: direct to the destination from 431m
    // away, but a longer ride than several transfers, so a single pool sorted
    // by `score` cut it at rank 9 of 8 — before the live-time ranking that
    // would have chosen it ever saw it.
    const board = { ...stop("board-29", -3.6664, 40.4677, ["29"]), distanceM: 431 };
    const arrive = { ...stop("arrive-29", -3.6790, 40.4470, ["29"]), distanceM: 294 };
    const swap = stop("swap", -3.6700, 40.4600);
    const interchange = { ...stop("interchange", -3.6791, 40.4471, ["T"]), distanceM: 300 };
    // Eight short hops, each one transfer away from the destination, all of
    // them scoring better than the long direct ride.
    const hops = Array.from({ length: 8 }, (_, i) =>
      ({ ...stop(`hop-${i}`, -3.6650, 40.4670, [`H${i}`]), distanceM: 100 + i }));
    const routes = new Map([
      ["29", route("29", [board, ...Array.from({ length: 11 }, (_, i) =>
        stop(`mid-${i}`, -3.667 - i / 1000, 40.466 - i / 1000)), arrive])],
      ["T", route("T", [swap, interchange])],
      ...hops.map((hop, i) => [`H${i}`, route(`H${i}`, [hop, swap])]),
    ]);
    const options = planJourney({
      originStops: [board, ...hops],
      destinationStops: [arrive, interchange],
      routes,
      limit: 8,
    });
    const direct = options.find((option) => option.type === "direct");
    expect(direct?.originStop.stopId).toBe("board-29");
    // ...and it survived despite scoring worse than the transfers that filled
    // the rest of the limit.
    const transfers = options.filter((option) => option.type === "one_transfer");
    expect(transfers.length).toBeGreaterThan(0);
    expect(Math.min(...transfers.map((option) => option.score))).toBeLessThan(direct.score);
  });

  it("preserves a farther direct-line stop before filling by distance", () => {
    const candidates = [
      { stopId: "near-1", distanceM: 50, lines: [{ line: "29" }] },
      { stopId: "near-2", distanceM: 80, lines: [{ line: "70" }] },
      { stopId: "airport", distanceM: 450, lines: [{ line: "125" }] },
    ];
    const destinations = [[{ stopId: "terminal", lines: [{ line: "125" }] }]];
    expect(prioritizeAccessStops(candidates, destinations, 2).map((item) => item.stopId))
      .toEqual(["airport", "near-1"]);
  });

  it("preserves two matching platforms for a destination", () => {
    const candidates = [
      { stopId: "unrelated", distanceM: 20, lines: [{ line: "29" }] },
      { stopId: "outbound", distanceM: 300, lines: [{ line: "107" }] },
      { stopId: "homebound", distanceM: 350, lines: [{ line: "107" }] },
    ];
    const destinations = [[{ stopId: "home", lines: [{ line: "107" }] }]];
    expect(prioritizeAccessStops(candidates, destinations, 2).map((item) => item.stopId))
      .toEqual(["outbound", "homebound"]);
  });

  it("ranks using catchable arrivals rather than a bus the user cannot reach", () => {
    const option = {
      type: "direct",
      originStop: { walkSeconds: 240, distanceM: 200 },
      destinationStop: { distanceM: 130 },
      firstLeg: { stops: 4, arrivals: [120, 420] },
    };
    expect(estimateJourneySeconds(option)).toBe(880);
    expect(option.firstLeg.selectedArrival).toBe(420);
  });

  it("includes live transfer timing in the door-to-door estimate", () => {
    const option = {
      type: "one_transfer",
      originStop: { walkSeconds: 120 },
      destinationStop: { distanceM: 130 },
      firstLeg: { stops: 2, arrivals: [180] },
      transfer: { walkM: 130 },
      secondLeg: { stops: 3, arrivals: [300, 600] },
    };
    expect(estimateJourneySeconds(option)).toBe(970);
    expect(option.secondLeg.selectedArrival).toBe(600);
  });

  it("collapses identical legs produced by different destination stops", () => {
    const common = {
      type: "direct", originStop: { stopId: "213" },
      firstLeg: { line: "070", direction: "toA" },
    };
    const options = [
      { ...common, destinationStop: { stopId: "a" }, estimatedSeconds: 600 },
      { ...common, destinationStop: { stopId: "b" }, estimatedSeconds: 650 },
    ];
    expect(deduplicateJourneyOptions(options)).toEqual([options[0]]);
  });

  it("collapses the same bus sequence boarded at different stops", () => {
    const leg = {
      type: "one_transfer",
      firstLeg: { line: "043", direction: "toA" },
      secondLeg: { line: "009", direction: "toB" },
    };
    const options = [
      { ...leg, originStop: { stopId: "near" }, transfer: {
        fromStop: { stopId: "x1" }, toStop: { stopId: "x1" },
      } },
      { ...leg, originStop: { stopId: "next" }, transfer: {
        fromStop: { stopId: "x2" }, toStop: { stopId: "x2" },
      } },
    ];
    expect(deduplicateJourneyOptions(options)).toEqual([options[0]]);
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
