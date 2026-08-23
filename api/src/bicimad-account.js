import { EmtError } from "./errors.js";

const USERDATA_URL = "https://apiemtpay.emtmadrid.es/v2/bicimad/userdata/";
const LOGIN_URL = "https://api.mpass.mobi/v1/core/identity/login/integrator";
const TOKEN_KEY = "bicimad:owner-session";

function required(env, name) {
  const value = env[name];
  if (!value) throw new EmtError("auth", `missing Worker secret ${name}`);
  return value;
}

function mpassCredential(env, name, fallbackName) {
  return env[name] || required(env, fallbackName);
}

function deviceHeaders(env) {
  return {
    accept: "application/json",
    deviceId: required(env, "MPASS_DEVICE_ID"),
    // Match the official client metadata. Coordinates are deliberately coarse:
    // this account-status request does not need the user's live position.
    latitude: "40.4168",
    longitude: "-3.7038",
    deviceModel: "personal-read-only-client",
    appPlatform: "Android",
    appPlatformVersion: env.BICIMAD_PLATFORM_VERSION || "unknown",
    appVersion: env.BICIMAD_APP_VERSION || "5.8.8",
    appName: "BiciMAD",
    language: "ES",
  };
}

async function login(env, { force = false } = {}) {
  if (!force) {
    const cached = await env.KV.get(TOKEN_KEY, "json");
    if (cached?.accessToken && cached?.userId && cached?.email) return cached;
  }

  const clientId = required(env, "MPASS_CLIENT_ID");
  const response = await fetch(LOGIN_URL, {
    method: "POST",
    headers: {
      ...deviceHeaders(env),
      "content-type": "application/json",
      "X-ClientId": clientId,
      debug: "false",
    },
    body: JSON.stringify({
      "X-ClientId": clientId,
      passKey: required(env, "MPASS_PASSKEY"),
      email: mpassCredential(env, "MPASS_EMAIL", "EMT_EMAIL"),
      password: mpassCredential(env, "MPASS_PASSWORD", "EMT_PASSWORD"),
    }),
  });
  const body = await response.json().catch(() => null);
  const data = body?.data?.[0];
  if (!response.ok || !data?.accessToken || !data?.idUser) {
    throw new EmtError("auth", "MPass login failed");
  }
  const session = {
    accessToken: data.accessToken,
    userId: data.idUser,
    email: data.email || mpassCredential(env, "MPASS_EMAIL", "EMT_EMAIL"),
  };
  const ttl = Math.max(60, Number(data.tokenSecExpiration || 3600) - 60);
  await env.KV.put(TOKEN_KEY, JSON.stringify(session), { expirationTtl: ttl });
  return session;
}

async function requestAccount(env, session) {
  return fetch(USERDATA_URL, {
    method: "GET",
    headers: {
      ...deviceHeaders(env),
      accessToken: session.accessToken,
      userId: session.userId,
      email: session.email,
    },
  });
}

/** Query the account backend and expose no identity, card or contract ids. */
export async function getBikeAccountStatus(env) {
  let session = await login(env);
  let response = await requestAccount(env, session);

  let body;
  try {
    body = await response.json();
  } catch {
    throw new EmtError("upstream", `BiciMAD account HTTP ${response.status}, non-JSON response`);
  }
  if (response.status === 401 || response.status === 403 || body.code === "80") {
    session = await login(env, { force: true });
    response = await requestAccount(env, session);
    body = await response.json().catch(() => null);
  }
  if (response.status === 401 || response.status === 403 || body?.code === "80") {
    throw new EmtError("auth", "BiciMAD account authentication failed");
  }
  if (!response.ok || (body?.code !== "01" && body?.code !== "00")) {
    throw new EmtError(
      "upstream",
      `BiciMAD account HTTP ${response.status}, code ${body?.code ?? "unknown"}`,
    );
  }

  const data = Array.isArray(body.data) ? body.data[0] : body.data;
  if (!data || typeof data !== "object") {
    throw new EmtError("upstream", "BiciMAD account response has no user data");
  }
  const contracts = Array.isArray(data.dataContract) ? data.dataContract : [];
  const activeContract = contracts.some(
    (contract) => contract?.IT_ACTIVE === true && contract?.IT_STATUS === true,
  );
  const accountEnabled = data.IT_STATUS === true;
  const blocked = data.IT_BLOCKED === true;

  return {
    accountEnabled,
    blocked,
    changesBlocked: data.NM_BLOCK_CHANGES === true,
    activeContract,
    // Preserve the opaque backend state for diagnosis; observed meanings are
    // not guessed from the MPass access-medium enum.
    stateCode: Number.isFinite(Number(data.NM_STATE)) ? Number(data.NM_STATE) : null,
    accountReady: accountEnabled && !blocked && activeContract,
    checkedAt: Date.now(),
  };
}
