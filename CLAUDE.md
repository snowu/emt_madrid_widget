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
4. Re-login lazily on 401 rather than on a timer.

Arrivals response, per incoming bus (verify exact field names against the live
docs before coding against them):
- `lineId` — line number
- `busTimeLeft` — seconds until arrival
- `busDistance` — metres from the stop

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

1. **Local countdown.** Tick `busTimeLeft` down in the browser between fetches
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
