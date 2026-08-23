#!/usr/bin/env node

// Read-only probe for a legitimately authenticated BiciMAD/MPass session.
// Secrets are accepted only through the environment and are never printed.

const API = "https://apiemtpay.emtmadrid.es";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function accountHeaders() {
  return {
    accessToken: required("BICIMAD_ACCESS_TOKEN"),
    userId: required("BICIMAD_USER_ID"),
    deviceId: required("BICIMAD_DEVICE_ID"),
    email: required("BICIMAD_EMAIL"),
    latitude: process.env.BICIMAD_LATITUDE || "40.4168",
    longitude: process.env.BICIMAD_LONGITUDE || "-3.7038",
    deviceModel: process.env.BICIMAD_DEVICE_MODEL || "personal-read-only-client",
    appPlatform: "Android",
    appPlatformVersion: process.env.BICIMAD_PLATFORM_VERSION || "unknown",
    appVersion: process.env.BICIMAD_APP_VERSION || "5.8.8",
    appName: "BiciMAD",
    language: process.env.BICIMAD_LANGUAGE || "ES",
  };
}

async function getJson(path, headers) {
  const response = await fetch(`${API}${path}`, {
    method: "GET",
    headers: { Accept: "application/json", ...headers },
    redirect: "error",
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${path}: HTTP ${response.status}, non-JSON response`);
  }
  if (!response.ok) {
    throw new Error(
      `${path}: HTTP ${response.status}, EMT ${body.code ?? "?"}: ${body.description ?? "unknown error"}`,
    );
  }
  return body;
}

function accountSummary(response) {
  const data = Array.isArray(response.data) ? response.data[0] : response.data;
  if (!data || typeof data !== "object") {
    return { code: response.code, description: response.description, account: null };
  }
  return {
    code: response.code,
    description: response.description,
    account: {
      state: data.NM_STATE ?? null,
      active: data.IT_STATUS ?? null,
      balance: data.DS_BALANCE ?? null,
      contracts: (data.dataContract || []).map((contract) => ({
        code: contract.DS_CODE ?? null,
        name: contract.DS_NAME ?? null,
        active: contract.IT_ACTIVE ?? null,
        status: contract.IT_STATUS ?? null,
        autoRenew: contract.IT_AUTORENEW ?? null,
        startsAt: contract.DT_INITPERIOD ?? null,
        endsAt: contract.DT_ENDPERIOD ?? null,
        expiredAt: contract.DT_EXPIRED ?? null,
        mediaAccess: (contract.mediaaccess || []).map((medium) => ({
          // Preserve the server's field names: the exact model differs by medium.
          ...medium,
        })),
      })),
    },
  };
}

function tripFlags(trip) {
  const penalty = trip.penalty || {};
  const oldAmount = Number(trip.old_amount);
  const newAmount = Number(trip.new_amount);
  const cost = Number(trip.trip_cost);
  const delta = Number.isFinite(oldAmount) && Number.isFinite(newAmount)
    ? newAmount - oldAmount
    : null;
  const flags = [];

  if (Number(penalty.penalty) || Number(penalty.penalty_amount)) flags.push("penalty");
  if (delta !== null && Math.abs(delta) >= 5) flags.push("large_balance_delta");
  if (Number.isFinite(Number(trip.trip_minutes)) && Number(trip.trip_minutes) >= 180) {
    flags.push("long_trip");
  }
  if (delta !== null && Number.isFinite(cost) && Math.abs(Math.abs(delta) - Math.abs(cost)) > 0.02) {
    flags.push("delta_cost_mismatch");
  }
  if (Number(trip.extrainfo?.amount)) flags.push("extra_charge_or_credit");

  return {
    tripId: trip.trip_id ?? null,
    bikeId: trip.id_bike ?? null,
    interval: trip.trip_interval ?? null,
    minutes: trip.trip_minutes ?? null,
    cost: trip.trip_cost ?? null,
    balanceDelta: delta,
    penaltyCount: penalty.penalty ?? 0,
    penaltyAmount: penalty.penalty_amount ?? 0,
    penaltyTimestamps: penalty.penalty_ts ?? {},
    extraAmount: trip.extrainfo?.amount ?? null,
    extraDate: trip.extrainfo?.date ?? null,
    flags,
  };
}

async function main() {
  const headers = accountHeaders();
  const user = await getJson("/v2/bicimad/userdata/", headers);
  const output = { user: accountSummary(user), flaggedTrips: [] };

  const nif = process.env.BICIMAD_NIF;
  const session = process.env.BICIMAD_SESSION;
  if (nif && session) {
    const trips = await getJson("/v2/bicimad/trips/", {
      ...headers,
      nif,
      session,
      mode: "mPass",
      ...(process.env.BICIMAD_TRIPS_PAGE ? { page: process.env.BICIMAD_TRIPS_PAGE } : {}),
    });
    output.flaggedTrips = (trips.data || []).map(tripFlags).filter((trip) => trip.flags.length);
    output.tripCountOnPage = (trips.data || []).length;
  } else {
    output.trips = "skipped: set both BICIMAD_NIF and BICIMAD_SESSION";
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
