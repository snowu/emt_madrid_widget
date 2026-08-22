import { EmtError } from "./errors.js";

const TABLE = "bus_stops";

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

export async function removeStop(env, id) {
  await call(env, `${TABLE}?id=eq.${encodeURIComponent(id)}`, { method: "DELETE" });
}
