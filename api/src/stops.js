import { EmtError } from "./errors.js";

const TABLE = "bus_stops";
const BIKE_TABLE = "bike_stations";

function headers(env, extra = {}) {
  // Supabase wants the key twice: apikey identifies the project, Authorization
  // carries the role. The service role bypasses RLS, which is the only way to
  // reach a table with zero policies.
  return {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    "content-type": "application/json",
    ...extra,
  };
}

async function call(env, path, init = {}) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: headers(env, init.headers),
    });
  } catch (cause) {
    throw new EmtError("upstream", `Supabase unreachable: ${cause.message}`);
  }
  if (!res.ok) {
    throw new EmtError("upstream", `Supabase HTTP ${res.status}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function listStops(env) {
  return call(env, `${TABLE}?select=*&order=created_at.asc`);
}

export async function addStop(env, { stopId, label = null }) {
  // The table has the same check constraint; failing here gives the page a
  // clearer error than a Postgres constraint violation would.
  if (!/^[0-9]+$/.test(String(stopId ?? ""))) {
    throw new EmtError("not_found", `not a valid stop id: ${stopId}`);
  }
  const rows = await call(env, TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ stop_id: String(stopId), label }),
  });
  return rows[0];
}

/** Change a saved stop's label. An empty label falls back to EMT's own name. */
export async function renameStop(env, id, label) {
  const rows = await call(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ label: label || null }),
  });
  if (!rows?.[0]) throw new EmtError("not_found", `no saved stop ${id}`);
  return rows[0];
}

export async function removeStop(env, id) {
  await call(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}

/* ---- Saved BiciMAD stations -------------------------------------------- */

/** Favourite bike stations, same contract as saved bus stops.
 *
 * A missing table is not an error worth breaking the page over: the bikes view
 * is useful without favourites, so this reports the gap and the page carries
 * on. Run supabase/bike_stations.sql once to make it work.
 */
export async function listBikeStations(env) {
  return call(env, `${BIKE_TABLE}?select=*&order=created_at.asc`);
}

export async function addBikeStation(env, { stationId, label = null }) {
  if (!/^[0-9]+$/.test(String(stationId ?? ""))) {
    throw new EmtError("not_found", `not a valid station id: ${stationId}`);
  }
  const rows = await call(env, BIKE_TABLE, {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ station_id: String(stationId), label }),
  });
  return rows[0];
}

export async function renameBikeStation(env, id, label) {
  const rows = await call(env, `${BIKE_TABLE}?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ label: label || null }),
  });
  if (!rows?.[0]) throw new EmtError("not_found", `no saved station ${id}`);
  return rows[0];
}

export async function removeBikeStation(env, id) {
  await call(env, `${BIKE_TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
