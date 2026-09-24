#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const envFile = resolve(import.meta.dirname, "../.env.metrics");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

const DATASET = "hubwise_emt_metrics";
const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID || "3dab85270c19e7a426145878daacaad7";
const token = process.env.CLOUDFLARE_ANALYTICS_TOKEN;
const daysIndex = process.argv.indexOf("--days");
const hoursIndex = process.argv.indexOf("--hours");
const hours = Math.min(720, Math.max(1,
  hoursIndex >= 0 ? Number(process.argv[hoursIndex + 1])
    : daysIndex >= 0 ? Number(process.argv[daysIndex + 1]) * 24 : 24));

if (!token) {
  console.error("CLOUDFLARE_ANALYTICS_TOKEN is required (Account Analytics Read only).");
  process.exit(1);
}

const query = `
  SELECT
    blob1 AS kind,
    blob2 AS endpoint,
    blob3 AS cache_status,
    blob5 AS outcome,
    blob6 AS error_kind,
    blob7 AS caller,
    blob8 AS who,
    SUM(_sample_interval) AS events,
    SUM(_sample_interval * double1) AS upstream_calls,
    AVG(double2) AS avg_duration_ms,
    MAX(double3) AS max_status,
    MIN(timestamp) AS first_seen
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
  GROUP BY kind, endpoint, cache_status, outcome, error_kind, caller, who
  ORDER BY events DESC`;

const response = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/analytics_engine/sql`,
  { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: query },
);
if (!response.ok) {
  console.error(`Analytics Engine HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

const { data: rows = [] } = await response.json();
const upstream = rows.filter((row) => row.kind === "upstream");
const edge = rows.filter((row) => row.kind === "edge");
const sum = (items, field) => items.reduce((total, row) => total + Number(row[field] || 0), 0);
const upstreamCalls = sum(upstream, "upstream_calls");
const served = sum(edge, "events");
const hits = sum(edge.filter((row) => row.cache_status === "hit"), "events");
const errors = sum(rows.filter((row) => row.outcome !== "ok"), "events");
const firstSeen = Math.min(...rows.map((row) => Date.parse(row.first_seen)).filter(Number.isFinite));
const observedHours = Number.isFinite(firstSeen)
  ? Math.min(hours, Math.max(1 / 60, (Date.now() - firstSeen) / 3_600_000)) : hours;
const dailyPace = upstreamCalls / observedHours * 24;
const observed = observedHours < 1
  ? `${Math.max(1, Math.round(observedHours * 60))}m`
  : `${observedHours.toFixed(1)}h`;

console.log(`EMT usage — last ${hours} hours\n`);
console.log(`Upstream calls  ${Math.round(upstreamCalls).toLocaleString()}`);
console.log(`Cache-served    ${Math.round(hits).toLocaleString()}`);
console.log(`Edge requests   ${Math.round(served).toLocaleString()}`);
console.log(`Cache hit rate  ${served ? `${(hits / served * 100).toFixed(1)}%` : "n/a"}`);
console.log(`Errors          ${Math.round(errors).toLocaleString()}`);
console.log(`Observed        ${observed}`);
console.log(`Daily pace      ~${Math.round(dailyPace).toLocaleString()} (${(dailyPace / 20_000 * 100).toFixed(1)}%)`);

// Endpoint names come from EMT's own URL, so two features hitting the same
// endpoint look identical. `caller` is what tells the live map's polling apart
// from journey planning — without it, "arrivals: 9,642" says nothing about
// which feature to go and fix.
const endpoints = new Map();
for (const row of upstream) {
  const name = row.caller ? `${row.endpoint} (${row.caller})` : row.endpoint;
  endpoints.set(name, (endpoints.get(name) || 0) + Number(row.upstream_calls || 0));
}
if (endpoints.size) {
  console.log("\nUpstream by endpoint");
  for (const [name, count] of [...endpoints].sort((a, b) => b[1] - a[1])) {
    console.log(`${name.padEnd(24)} ${Math.round(count).toLocaleString()}`);
  }
}

const cache = new Map();
for (const row of edge) {
  cache.set(row.cache_status || "unknown",
    (cache.get(row.cache_status || "unknown") || 0) + Number(row.events || 0));
}
if (cache.size) {
  console.log("\nEdge cache");
  for (const [name, count] of [...cache].sort((a, b) => b[1] - a[1])) {
    console.log(`${name.padEnd(16)} ${Math.round(count).toLocaleString()}`);
  }
}

const who = new Map();
for (const row of edge) {
  const name = row.who || "unrecorded";
  const entry = who.get(name) ?? { hit: 0, other: 0 };
  entry[row.cache_status === "hit" ? "hit" : "other"] += Number(row.events || 0);
  who.set(name, entry);
}
if (who.size) {
  console.log("\nWho asked         cache hits   fetched");
  for (const [name, { hit, other }] of [...who].sort((a, b) => (b[1].hit + b[1].other) - (a[1].hit + a[1].other))) {
    console.log(`${name.padEnd(16)} ${String(Math.round(hit).toLocaleString()).padStart(11)}   ${Math.round(other).toLocaleString()}`);
  }
}

const failures = rows.filter((row) => row.outcome !== "ok");
if (failures.length) {
  console.log("\nErrors");
  for (const row of failures) {
    console.log(`${row.endpoint.padEnd(16)} ${(row.error_kind || row.outcome).padEnd(16)} ${Math.round(row.events)}`);
  }
}
