import { EmtError } from "./errors.js";

const USERDATA_URL = "https://apiemtpay.emtmadrid.es/v2/bicimad/userdata/";
const TRIPS_URL = "https://apiemtpay.emtmadrid.es/v2/bicimad/trips/";
const LOGIN_URL = "https://api.mpass.mobi/v1/core/identity/login/integrator";
const TOKEN_KEY = "bicimad:owner-session";
let hotSession = null;
let sessionLoad = null;

export function clearBikeSessionMemoryForTest() {
  hotSession = null;
  sessionLoad = null;
}

function required(env, name) {
  const value = env[name];
  if (!value) throw new EmtError("auth", `missing Worker secret ${name}`);
  return value;
}

function mpassCredential(env, name, fallbackName) {
  return env[name] || required(env, fallbackName);
}

async function cacheSession(env, session) {
  const ttl = Math.max(60, Math.floor(((session.expiresAt ?? Date.now() + 3600_000) - Date.now()) / 1000));
  await env.KV.put(TOKEN_KEY, JSON.stringify(session), { expirationTtl: ttl });
  hotSession = session;
}

function deviceHeaders(env) {
  return {
    accept: "application/json",
    deviceId: required(env, "MPASS_DEVICE_ID"),
    // Match the official client metadata. Coordinates are deliberately coarse:
    // this account-status request does not need the user's live position.
    latitude: "40.4168",
    longitude: "-3.7038",
    deviceModel: env.BICIMAD_DEVICE_MODEL ||
      JSON.stringify({ name: "Google Pixel 8", model: "Android", version: "17" }),
    appPlatform: "Android",
    appPlatformVersion: env.BICIMAD_PLATFORM_VERSION || "Android CINNAMON BUN",
    appVersion: env.BICIMAD_APP_VERSION || "5.8.8",
    appName: "bicimad",
    language: "EN",
  };
}

async function login(env, { force = false } = {}) {
  if (!force && hotSession?.accessToken && hotSession?.userId && hotSession?.email &&
      (!hotSession.expiresAt || hotSession.expiresAt > Date.now())) return hotSession;
  if (!force && sessionLoad) return sessionLoad;
  if (force) hotSession = null;
  const operation = (async () => {
    if (!force) {
      const cached = await env.KV.get(TOKEN_KEY, "json");
      if (cached?.accessToken && cached?.userId && cached?.email &&
          (!cached.expiresAt || cached.expiresAt > Date.now())) {
        hotSession = cached;
        return cached;
      }
    }

    const clientId = required(env, "MPASS_CLIENT_ID");
    const response = await fetch(LOGIN_URL, {
      method: "POST",
      headers: {
        ...deviceHeaders(env),
        "content-type": "application/json",
        "X-ClientId": clientId,
        debug: "1",
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
      throw new EmtError(
        "auth",
        `MPass login failed: HTTP ${response.status}, code ${body?.code ?? "unknown"}`,
      );
    }
    const session = {
      accessToken: data.accessToken,
      userId: data.idUser,
      email: data.email || mpassCredential(env, "MPASS_EMAIL", "EMT_EMAIL"),
      expiresAt: Date.now() + Math.max(60, Number(data.tokenSecExpiration || 3600) - 60) * 1000,
    };
    await cacheSession(env, session);
    return session;
  })();
  if (!force) sessionLoad = operation;
  try {
    return await operation;
  } finally {
    if (sessionLoad === operation) sessionLoad = null;
  }
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

async function requestTrips(env, session, nif, page) {
  return fetch(TRIPS_URL, {
    method: "GET",
    headers: {
      ...deviceHeaders(env),
      accessToken: session.accessToken,
      userId: session.userId,
      email: session.email,
      nif,
      session: session.userId,
      mode: "mPass",
      page: String(page),
    },
  });
}

async function jsonResponse(response, label) {
  try {
    return await response.json();
  } catch {
    throw new EmtError("upstream", `${label} HTTP ${response.status}, non-JSON response`);
  }
}

function rejectedSession(response, body) {
  return response.status === 401 || response.status === 403 || body?.code === "80";
}

function displayedBikeNumber(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  return /^\d+$/.test(raw) ? raw.replace(/^0+(?=\d)/, "") : raw;
}

function internalBikeId(value) {
  const shown = displayedBikeNumber(value);
  return shown && /^\d+$/.test(shown) ? shown.padStart(8, "0") : shown;
}

function setFlag(value) {
  return value === true || value === 1 || value === "1" || value === "true";
}

function accountSummary(data) {
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

function tripSummary(trip) {
  const penalty = trip?.penalty && typeof trip.penalty === "object" ? trip.penalty : {};
  const extra = trip?.extrainfo && typeof trip.extrainfo === "object" ? trip.extrainfo : {};
  return {
    tripId: trip?.trip_id ?? null,
    bikeNumber: displayedBikeNumber(trip?.id_bike),
    interval: trip?.trip_interval ?? null,
    minutes: trip?.trip_minutes ?? null,
    cost: trip?.trip_cost ?? null,
    previousBalance: trip?.old_amount ?? null,
    resultingBalance: trip?.new_amount ?? null,
    dockBonus: trip?.dock_bono ?? null,
    undockBonus: trip?.undock_bono ?? null,
    reservationBonus: trip?.reserve_bono ?? null,
    penaltyCount: penalty.penalty ?? 0,
    penaltyAmount: penalty.penalty_amount ?? 0,
    penaltyTimestamps: penalty.penalty_ts ?? {},
    extraAmount: extra.amount ?? null,
    extraDate: extra.date ?? null,
    lockFailed: setFlag(trip?.LockFailed),
    dockIncident: setFlag(trip?.incident_in_dock),
    incorrectDockBlock: setFlag(trip?.incorrect_dock_block),
    forcedClosed: setFlag(trip?.forced_closed_PBSC_Limit),
  };
}

/** Owner-only callers can inspect their own rides without exposing account
 * identifiers, tokens, NIF, or the raw upstream response. `fields` records the
 * model keys EMT actually returned so unmapped useful data can be identified
 * without leaking its values during research. */
export async function getBikeTrips(env, { page = 0, bikeNumber = null } = {}) {
  let session = await login(env);
  let nif = session.nif;
  if (!nif) {
    let accountResponse = await requestAccount(env, session);
    let accountBody = await jsonResponse(accountResponse, "BiciMAD account");
    if (rejectedSession(accountResponse, accountBody)) {
      session = await login(env, { force: true });
      accountResponse = await requestAccount(env, session);
      accountBody = await jsonResponse(accountResponse, "BiciMAD account");
    }
    if (rejectedSession(accountResponse, accountBody)) {
      throw new EmtError("auth", "BiciMAD account authentication failed");
    }
    const account = Array.isArray(accountBody?.data) ? accountBody.data[0] : accountBody?.data;
    nif = account?.DS_NIF || account?.DS_DN;
    if (nif) {
      session = { ...session, nif, accountStatus: accountSummary(account) };
      await cacheSession(env, session);
    }
  }
  if (!nif) throw new EmtError("upstream", "BiciMAD account returned no document id for trips");

  let tripsResponse = await requestTrips(env, session, nif, page);
  let tripsBody = await jsonResponse(tripsResponse, "BiciMAD trips");
  if (rejectedSession(tripsResponse, tripsBody)) {
    session = await login(env, { force: true });
    tripsResponse = await requestTrips(env, session, nif, page);
    tripsBody = await jsonResponse(tripsResponse, "BiciMAD trips");
  }
  if (rejectedSession(tripsResponse, tripsBody)) {
    throw new EmtError("auth", "BiciMAD trips authentication failed");
  }
  if (!tripsResponse.ok || (tripsBody?.code !== "00" && tripsBody?.code !== "01")) {
    throw new EmtError(
      "upstream",
      `BiciMAD trips HTTP ${tripsResponse.status}, code ${tripsBody?.code ?? "unknown"}`,
    );
  }

  const rawTrips = Array.isArray(tripsBody.data) ? tripsBody.data : [];
  const fields = [...new Set(rawTrips.flatMap((trip) => Object.keys(trip || {})))].sort();
  const normalized = rawTrips.map(tripSummary);
  const wanted = bikeNumber == null ? null : displayedBikeNumber(bikeNumber);
  const wantedInternal = wanted == null ? null : internalBikeId(wanted);
  return {
    page,
    bikeNumber: wanted,
    internalBikeId: wantedInternal,
    countOnPage: rawTrips.length,
    matchedOnPage: wanted
      ? rawTrips
        .filter((trip) => internalBikeId(trip?.id_bike) === wantedInternal)
        .map(tripSummary)
      : normalized,
    fields,
  };
}

/** Query the account backend and expose no identity, card or contract ids.
 * The normalized status lives inside the private MPass session cache. `force`
 * bypasses only that status value; it does not discard a valid login. */
export async function getBikeAccountStatus(env, { force = false } = {}) {
  let session = await login(env);
  if (!force && session.accountStatus) return session.accountStatus;
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
  const status = accountSummary(data);
  await cacheSession(env, { ...session, accountStatus: status });
  return status;
}
