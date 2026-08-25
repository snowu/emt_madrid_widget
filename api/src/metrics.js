const DATASET = "hubwise_emt_metrics";

function safe(value) {
  return String(value ?? "").slice(0, 256);
}

function write(env, { kind, endpoint, cache = "", target = "", outcome = "ok",
  error = "", caller = "", upstream = 0, duration = 0, status = 0 }) {
  env?.METRICS?.writeDataPoint({
    indexes: ["emt"],
    blobs: [kind, endpoint, cache, safe(target), outcome, error, caller],
    doubles: [upstream, duration, status],
  });
}

export function recordEdgeMetric(env, fields) {
  write(env, { kind: "edge", ...fields });
}

export function recordUpstreamMetric(env, fields) {
  write(env, { kind: "upstream", upstream: 1, ...fields });
}

export function emtEndpoint(url) {
  const pathname = new URL(url).pathname;
  if (pathname.includes("/user/login")) return "login";
  if (pathname.includes("/arrives/")) return "arrivals";
  if (pathname.includes("/detail/")) return "detail";
  if (pathname.includes("/timetable/")) return "timetable";
  if (pathname.includes("/route/")) return "route";
  if (pathname.includes("/arroundxy/")) return "nearby";
  if (pathname.includes("/incidents/")) return "incidents";
  return "other";
}

export async function queryMetrics(env, hours) {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_ANALYTICS_TOKEN) {
    throw new Error("metrics query credentials are not configured");
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
      MAX(double3) AS max_status,
      MIN(timestamp) AS first_seen
    FROM ${DATASET}
    WHERE timestamp > NOW() - INTERVAL '${hours}' HOUR
    GROUP BY kind, endpoint, cache_status, outcome, error_kind, caller
    ORDER BY events DESC`;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/analytics_engine/sql`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CLOUDFLARE_ANALYTICS_TOKEN}`,
        "content-type": "text/plain",
      },
      body: query,
    },
  );
  if (!response.ok) throw new Error(`Analytics Engine HTTP ${response.status}`);
  const body = await response.json();
  return { hours, generatedAt: Date.now(), rows: body.data ?? [] };
}
