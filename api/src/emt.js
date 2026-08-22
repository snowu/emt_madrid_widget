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
