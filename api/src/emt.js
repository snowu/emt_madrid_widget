import { EmtError } from "./errors.js";

const BASE = "https://openapi.emtmadrid.es/";
const TOKEN_KEY = "emt:token";

// EMT reports failure as a `code` inside a 200 response, not as an HTTP status.
const CODE_KIND = {
  "89": ["auth", "invalid EMT password"],
  "92": ["auth", "EMT user does not exist"],
  "98": ["quota", "EMT daily API quota exceeded"],
  "80": ["not_found", "stop not found or token invalid"],
};

function raiseForCode(code) {
  const known = CODE_KIND[String(code)];
  if (known) throw new EmtError(known[0], known[1]);
  throw new EmtError("upstream", `unexpected EMT code ${code}`);
}

async function login(env) {
  let res;
  try {
    res = await fetch(`${BASE}v1/mobilitylabs/user/login/`, {
      method: "GET",
      headers: { email: env.EMT_EMAIL, password: env.EMT_PASSWORD },
    });
  } catch (cause) {
    throw new EmtError("upstream", `EMT unreachable: ${cause.message}`);
  }

  if (!res.ok) {
    throw new EmtError("upstream", `EMT login HTTP ${res.status}`);
  }

  const body = await res.json();
  if (body.code !== "01") raiseForCode(body.code);

  const entry = body.data?.[0];
  if (!entry?.accessToken) {
    throw new EmtError("upstream", "EMT login returned no accessToken");
  }
  return {
    token: entry.accessToken,
    // Expire ours a minute early so we never present a token mid-expiry.
    ttl: Math.max(60, Number(entry.tokenSecExpiration ?? 86400) - 60),
  };
}

/** Return a usable EMT access token, logging in only when needed. */
export async function getToken(env, { force = false } = {}) {
  if (!force) {
    const cached = await env.KV.get(TOKEN_KEY);
    if (cached) return cached;
  }
  const { token, ttl } = await login(env);
  await env.KV.put(TOKEN_KEY, token, { expirationTtl: ttl });
  return token;
}

const MAX_ARRIVALS = 2;

async function requestArrivals(env, stopId, token) {
  let res;
  try {
    res = await fetch(`${BASE}v2/transport/busemtmad/stops/${stopId}/arrives/`, {
      method: "POST",
      headers: { accessToken: token, "content-type": "application/json" },
      body: JSON.stringify({
        stopId: String(stopId),
        Text_EstimationsRequired_YN: "Y",
      }),
    });
  } catch (cause) {
    throw new EmtError("upstream", `EMT unreachable: ${cause.message}`);
  }
  if (!res.ok) throw new EmtError("upstream", `EMT arrivals HTTP ${res.status}`);
  return res.json();
}

function parseArrivals(body) {
  // Arrivals live at data[0].Arrive[]. Capital D in DistanceBus is EMT's, not a typo.
  const raw = body.data?.[0]?.Arrive ?? [];
  return raw
    .filter((a) => a.line != null && a.estimateArrive != null)
    .map((a) => ({
      line: String(a.line),
      seconds: Number(a.estimateArrive),
      metres: a.DistanceBus == null ? null : Number(a.DistanceBus),
    }))
    .sort((a, b) => a.seconds - b.seconds)
    .slice(0, MAX_ARRIVALS);
}

/** Fetch the next arrivals for one stop, re-logging in once if the token is stale. */
export async function getArrivals(env, stopId) {
  let token = await getToken(env);
  let body = await requestArrivals(env, stopId, token);

  // Code 80 is both "stop not found" and "invalid token" — indistinguishable
  // here, so retry once with a fresh token before believing the stop is bad.
  if (body.code === "80") {
    token = await getToken(env, { force: true });
    body = await requestArrivals(env, stopId, token);
  }

  if (body.code !== "00") raiseForCode(body.code);

  return { stopId: String(stopId), arrivals: parseArrivals(body), fetchedAt: Date.now() };
}
