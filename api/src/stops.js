import { EmtError } from "./errors.js";

const TABLE = "bus_stops";
const BIKE_TABLE = "bike_stations";
const BIKE_RATING_TABLE = "bike_ratings";
const PLACE_TABLE = "places";

function headers(env, accessToken, extra = {}) {
  // The publishable/anon key identifies the project. The caller's JWT carries
  // their identity, so Postgres RLS—not this Worker—owns row isolation.
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function call(env, accessToken, path, init = {}) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: headers(env, accessToken, init.headers),
    });
  } catch (cause) {
    throw new EmtError("upstream", `Supabase unreachable: ${cause.message}`);
  }
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      throw new EmtError("user_auth", "session expired or access denied");
    }
    throw new EmtError("upstream", `Supabase HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listStops(env, accessToken) {
  return call(env, accessToken, `${TABLE}?select=id,stop_id,label,enabled,created_at&order=created_at.asc`);
}

export async function addStop(env, accessToken, { stopId, label = null }) {
  // The table has the same check constraint; failing here gives the page a
  // clearer error than a Postgres constraint violation would.
  if (!/^[0-9]+$/.test(String(stopId ?? ""))) {
    throw new EmtError("not_found", `not a valid stop id: ${stopId}`);
  }
  const rows = await call(env, accessToken, TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ stop_id: String(stopId), label }),
  });
  return rows[0];
}

/** Change a saved stop's label. An empty label falls back to EMT's own name. */
export async function renameStop(env, accessToken, id, label) {
  const rows = await call(env, accessToken, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ label: label || null }),
  });
  if (!rows?.[0]) throw new EmtError("not_found", `no saved stop ${id}`);
  return rows[0];
}

export async function removeStop(env, accessToken, id) {
  await call(env, accessToken, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---- Saved BiciMAD stations -------------------------------------------- */

/** Favourite bike stations, same contract as saved bus stops.
 *
 * A missing table is not an error worth breaking the page over: the bikes view
 * is useful without favourites, so this reports the gap and the page carries
 * on. Run supabase/bike_stations.sql once to make it work.
 */
export async function listBikeStations(env, accessToken) {
  return call(env, accessToken, `${BIKE_TABLE}?select=id,station_id,label,enabled,created_at&order=created_at.asc`);
}

export async function addBikeStation(env, accessToken, { stationId, label = null }) {
  if (!/^[0-9]+$/.test(String(stationId ?? ""))) {
    throw new EmtError("not_found", `not a valid station id: ${stationId}`);
  }
  const rows = await call(env, accessToken, BIKE_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ station_id: String(stationId), label }),
  });
  return rows[0];
}

export async function renameBikeStation(env, accessToken, id, label) {
  const rows = await call(env, accessToken, `${BIKE_TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ label: label || null }),
  });
  if (!rows?.[0]) throw new EmtError("not_found", `no saved station ${id}`);
  return rows[0];
}

export async function removeBikeStation(env, accessToken, id) {
  await call(env, accessToken, `${BIKE_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---- Personal bike ratings -------------------------------------------- */

export async function listBikeRatings(env, accessToken) {
  return call(env, accessToken,
    `${BIKE_RATING_TABLE}?select=bike_number,rating,updated_at&order=updated_at.desc`);
}

export async function rateBike(env, accessToken, { bikeNumber, rating }) {
  const normalized = String(bikeNumber ?? "").replace(/^0+(?=\d)/, "");
  if (!/^\d+$/.test(normalized)) {
    throw new EmtError("not_found", `not a valid bike number: ${bikeNumber}`);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw new EmtError("not_found", "rating must be an integer from 1 to 5");
  }
  const rows = await call(env, accessToken,
    `${BIKE_RATING_TABLE}?on_conflict=user_id,bike_number`, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({
        bike_number: normalized,
        rating,
        updated_at: new Date().toISOString(),
      }),
    });
  return rows[0];
}

/* ---- Places ----------------------------------------------------------- */

export async function listPlaces(env, accessToken) {
  return call(env, accessToken,
    `${PLACE_TABLE}?select=id,name,lat,lon,geofence_radius_m,destination_radius_m,enabled,created_at,updated_at&order=created_at.asc`);
}

function placeValues(input, { partial = false } = {}) {
  const values = {};
  if (!partial || Object.hasOwn(input, "name")) {
    const name = String(input.name ?? "").trim();
    if (!name || name.length > 80) throw new EmtError("not_found", "place name must be 1–80 characters");
    values.name = name;
  }
  for (const key of ["lat", "lon"]) {
    if (!partial || Object.hasOwn(input, key)) {
      const value = Number(input[key]);
      const valid = Number.isFinite(value) && (key === "lat" ? Math.abs(value) <= 90 : Math.abs(value) <= 180);
      if (!valid) throw new EmtError("not_found", `invalid ${key}`);
      values[key] = value;
    }
  }
  for (const [key, fallback, minimum] of [
    ["geofenceRadiusM", 200, 50],
    ["destinationRadiusM", 700, 700],
  ]) {
    if (!partial || Object.hasOwn(input, key)) {
      const value = Number(input[key] ?? fallback);
      if (!Number.isInteger(value) || value < minimum || value > 1500) {
        throw new EmtError("not_found", `${key} must be an integer from ${minimum} to 1500`);
      }
      values[key === "geofenceRadiusM" ? "geofence_radius_m" : "destination_radius_m"] = value;
    }
  }
  if (Object.hasOwn(input, "enabled")) values.enabled = Boolean(input.enabled);
  return values;
}

export async function addPlace(env, accessToken, input) {
  const rows = await call(env, accessToken, PLACE_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(placeValues(input)),
  });
  return rows[0];
}

export async function updatePlace(env, accessToken, id, input) {
  const values = placeValues(input, { partial: true });
  if (Object.keys(values).length === 0) throw new EmtError("not_found", "no place fields to update");
  values.updated_at = new Date().toISOString();
  const rows = await call(env, accessToken, `${PLACE_TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify(values),
  });
  if (!rows?.[0]) throw new EmtError("not_found", `no place ${id}`);
  return rows[0];
}

export async function removePlace(env, accessToken, id) {
  await call(env, accessToken, `${PLACE_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
