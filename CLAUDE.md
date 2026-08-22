# EMT Madrid Arrivals

A personal webpage showing live EMT bus arrival times for a handful of saved
stops. Opened from a phone home screen. Single user, not going to any store.

Design doc: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`.

**The repo is named `emt_madrid_widget` and there is no widget.** This started
as an Android home screen widget and became a webpage; the name was kept to
avoid churn. Ignore it.

## Scope

- **In:** EMT Madrid city buses only.
- **Out (for now):** Metro, Cercanías, interurbanos. Those are CRTM, a separate
  API with a different stop ID namespace. Don't mix the two without an explicit
  decision — stop IDs are not interchangeable.

## Layout

```
web/    static page, deployed to GitHub Pages. Holds no secrets.
api/    Cloudflare Worker. Holds EMT credentials + SUPABASE_SERVICE_KEY.
supabase/   bus_stops.sql
```

Page → worker → (EMT | Supabase). The page never calls EMT or Supabase directly:
browser JS keeps no secrets, and EMT sends no CORS headers.

## Data source

**EMT MobilityLabs** — https://mobilitylabs.emtmadrid.es
API reference: https://apidocs.emtmadrid.es

Auth flow, all inside the worker:
1. Log in against the auth endpoint to receive an `accessToken`.
2. Token is valid roughly 24h (`tokenSecExpiration` in the login response).
3. Cache it in Worker KV with its expiry; check before each call.
4. Re-login lazily on an auth-failure code rather than on a timer.

EMT reports failure as a `code` field inside a 200 response, not as an HTTP
status: `01` login ok **and** arrivals-with-no-estimations (empty `Arrive[]`,
e.g. night hours — it is a success there), `89` bad password, `92` no such
user, `98` quota spent; `00` ok (arrivals with data, stop detail), `80` stop
not found / invalid token, `81` no such record (nonexistent stop id). Handle
both an HTTP error and a 200 carrying an error code.

Versioning is per endpoint family and the docs overstate v1 coverage: auth is
v1, bus data is v2. Some transport endpoints exist under both but only answer
on v2 (`stops/arroundxy/` silently returns "no records" on v1) — verified live
2026-08-23. When a call comes back empty on principle, try the other version.

Cloudflare↔EMT quirk: outbound TLS from Workers to `openapi.emtmadrid.es`
fails intermittently with HTTP 525 (same class as workerd#776 vs DeepL).
Retries get through; the token cache means most calls skip login entirely.

Endpoints, verified 2026-08-18 against `fermartv/EMTMadrid`, re-verified live
2026-08-23:

```
Login      GET  v1/mobilitylabs/user/login/     headers: email, password
Arrivals   POST v2/transport/busemtmad/stops/{stop_id}/arrives/
                headers: accessToken
                body:    {stopId, Text_EstimationsRequired_YN: "Y"}
Stop detail GET  v1/transport/busemtmad/stops/{stop_id}/detail/
                headers: accessToken  → data[0].stops[0]:
                {stop, name, postalAddress, geometry.coordinates, lines}
Area search GET  v2/transport/busemtmad/stops/arroundxy/{lon}/{lat}/{radius}/
                headers: accessToken  → data[]: {stopId, stopName, lines[]}
```

`estimateArrive = 888888` is EMT's "running on schedule, no GPS estimate yet"
sentinel, not a real countdown.

Arrivals live at `data[0].Arrive[]`. Per bus:
- `line` — line number (string)
- `estimateArrive` — seconds until arrival
- `DistanceBus` — metres from the stop (capital D)

Also present: `bus`, `destination`, `geometry.coordinates`, `isHead`.

Quota: ~20,000 calls/day on the generic login. If it ever binds, register an app
in MobilityLabs for a dedicated `X-ClientId` / `passKey` pair.

Attribution: EMT asks that MobilityLabs be credited as the data source.

## Architecture decisions

**Minimal backend, holding only secrets.** The worker exists because a public
page cannot hold credentials and cannot call EMT directly (CORS). It forwards
requests and caches the token. Nothing else belongs in it.

**Cloudflare Workers, free plan, no card attached.** Past the daily limit the
free plan rejects requests rather than billing. Cost cannot balloon.

**Supabase for saved stops.** They must be identical on every device — that
requirement killed both localStorage-only and a committed JSON file. Follows the
`innocent_project` pattern: RLS enabled with **zero policies**, so only the
service-role key can read or write. Env vars `SUPABASE_URL`,
`SUPABASE_SERVICE_KEY`, gitignored.

**localStorage is a cache, not shared state.** It holds last-known arrivals per
device so the page never renders empty. Saved stops never live there.

**Stop IDs are typed in by hand.** No GTFS index; build that pipeline only if
hand-entry becomes annoying.

**Writes are filtered, not authenticated.** The page sends `X-App-Key` and the
worker rejects writes without it. The key ships in public JS — it stops
scanners, not people. Deliberate: blast radius is junk rows in a personal table.
Arrivals are cached 20s in KV, which also blunts quota abuse. See the design doc
for what was rejected and when to revisit.

## Page behaviour

Two arrivals per stop: the next bus and the fallback if you miss it.

1. **Local countdown.** Tick `estimateArrive` down in the browser between fetches
   so numbers move every second instead of freezing.
2. **Staleness marker.** Every rendering of arrival data carries "updated N ago".
3. **Never render empty.** Show last-known arrivals from localStorage rather
   than a spinner or blank. A stale number beats a spinner — but only ever with
   its age attached.
4. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Refresh: automatically on load and on tab focus; manually per-card or all at
once.

## Testing

Recorded EMT fixtures, not live calls — tests shouldn't burn quota.

## Reference

`innocent_project` (same machine) is the closest pattern: Supabase with RLS and
zero policies, service key from a gitignored `.env`, plain REST against
`/rest/v1/<table>` with no SDK.

`fermartv/emt_madrid` (Home Assistant integration) and `fermartv/EMTMadrid`
(Python wrapper) are useful references for the auth handshake and response
shapes.
