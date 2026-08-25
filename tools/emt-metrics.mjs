#!/usr/bin/env node

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
    SUM(_sample_interval) AS events,
    SUM(_sample_interval * double1) AS upstream_calls,
    AVG(double2) AS avg_duration_ms,
    MAX(double3) AS max_status
  FROM ${DATASET}
  WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
  GROUP BY kind, endpoint, cache_status, outcome, error_kind, caller
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

console.log(`EMT usage — last ${hours} hours\n`);
console.log(`Upstream calls  ${Math.round(upstreamCalls).toLocaleString()}`);
console.log(`Cache-served    ${Math.round(hits).toLocaleString()}`);
console.log(`Edge requests   ${Math.round(served).toLocaleString()}`);
console.log(`Cache hit rate  ${served ? `${(hits / served * 100).toFixed(1)}%` : "n/a"}`);
console.log(`Errors          ${Math.round(errors).toLocaleString()}`);
if (hours === 24) console.log(`20k quota use   ${(upstreamCalls / 20_000 * 100).toFixed(1)}%`);

const endpoints = new Map();
for (const row of upstream) {
  endpoints.set(row.endpoint, (endpoints.get(row.endpoint) || 0) + Number(row.upstream_calls || 0));
}
if (endpoints.size) {
  console.log("\nUpstream by endpoint");
  for (const [name, count] of [...endpoints].sort((a, b) => b[1] - a[1])) {
    console.log(`${name.padEnd(16)} ${Math.round(count).toLocaleString()}`);
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

const failures = rows.filter((row) => row.outcome !== "ok");
if (failures.length) {
  console.log("\nErrors");
  for (const row of failures) {
    console.log(`${row.endpoint.padEnd(16)} ${(row.error_kind || row.outcome).padEnd(16)} ${Math.round(row.events)}`);
  }
}
