import { EmtError } from "./errors.js";

const TABLE = "bus_stops";
const BIKE_TABLE = "bike_stations";

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
