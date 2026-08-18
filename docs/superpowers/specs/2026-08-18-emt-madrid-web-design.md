# EMT Madrid Arrivals — Web App Design

Date: 2026-08-18
Status: approved (pending spec review)

## What this is

A personal webpage showing live EMT Madrid bus arrival times for a handful of
saved stops. Opened from a phone home screen. Single user.

This replaces the original Android widget design. See "History" below.

## Scope

- **In:** EMT Madrid city buses. Saved stops shared across devices. Live
  arrivals, local countdown, staleness marker.
- **Out:** Metro, Cercanías, interurbanos (CRTM — different API, different stop
  ID namespace; do not mix without an explicit decision). GTFS stop-name search.
  Native app of any kind.

## Architecture

Three pieces, two deploy targets:

```
web/    static page          → GitHub Pages (public, holds no secrets)
api/    Cloudflare Worker    → holds EMT credentials + SUPABASE_SERVICE_KEY
        Supabase Postgres    → bus_stops table (RLS on, zero policies)
```

Data flow: page → worker → (EMT API | Supabase). The page never talks to EMT or
Supabase directly.

### Why a backend at all

The original design had none: an APK on one device could hold its own
credentials. A public webpage cannot — browser JS keeps no secrets, and EMT
almost certainly sends no CORS headers, so direct calls would be blocked
regardless. The worker exists to hold credentials and to be a CORS-allowed
origin. It is deliberately minimal: secrets plus request forwarding.

### Why Cloudflare Workers

Free plan rejects requests past the daily limit rather than billing for them.
No card attached, so cost cannot balloon. (Verify current limits against
Cloudflare's pricing page before relying on exact figures.)

### Why Supabase

Saved stops must be identical on every device — that was the requirement that
killed both localStorage-only and a committed JSON file. Shared mutable state
needs a shared store. Follows the pattern already used in `innocent_project`:
RLS enabled with zero policies, so only the service-role key can read or write.

localStorage is still used, but only as a per-device cache of last-known
arrivals. That is a cache, not shared state, so per-device is correct there.

## Data model

```sql
create table if not exists bus_stops (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null,          -- EMT stop ID, entered by hand
  label text,                     -- optional human name ("home", "work")
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

alter table bus_stops enable row level security;
-- No policies: service-role key only.
```

Stop IDs are typed in by hand. No GTFS index in v1 — that pipeline is only
worth building if hand-entry becomes annoying.

## Worker endpoints

```
GET    /stops              → list saved stops
POST   /stops              → add one (stop_id, optional label)
DELETE /stops/:id          → remove one
GET    /arrivals?stop=1234 → live arrivals for one stop
```

CORS restricted to the GitHub Pages origin.

### EMT auth

1. Log in against the EMT auth endpoint with credentials from worker env vars.
2. Response carries `accessToken` and `tokenSecExpiration` (~24h).
3. Cache the token in Worker KV with its expiry.
4. Check expiry before each call; re-login lazily on 401 rather than on a timer.

Arrivals response fields, per incoming bus — verify exact names against the
live docs before coding against them:
- `lineId` — line number
- `busTimeLeft` — seconds until arrival
- `busDistance` — metres from the stop

Quota is ~20,000 calls/day on the generic login, enormous for one user. If it
ever binds, register an app in MobilityLabs for a dedicated
`X-ClientId`/`passKey` pair.

Attribution: EMT asks that MobilityLabs be credited as the data source.

### Write protection

`POST` and `DELETE` are reachable by anyone who finds the worker URL. The page
sends a shared secret header; the worker rejects writes without it. The secret
ships in public JS, so this is not authentication — it only stops random
scanners from writing. Blast radius if bypassed is junk rows in a personal
table, removable by hand. Accepted deliberately; real auth is not worth it for
one user.

## Page behaviour

One page, no router. Stops listed as cards, each showing its next arrivals.

1. **Local countdown.** EMT returns seconds-to-arrival. Tick it down in the
   browser between fetches so numbers move every second rather than freezing.
2. **Staleness marker.** Every rendering of arrival data carries "updated N ago".
3. **Never render empty.** On load or failure, show last-known arrivals from
   localStorage with their staleness marker instead of a spinner or blank. A
   stale number beats a spinner — but only ever shown with its age attached.
4. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Refresh: on page load, on tap, and on returning to a backgrounded tab.

## Error handling

- EMT 401 → re-login once, retry, then surface the failure.
- EMT unreachable or slow → keep showing cached arrivals with staleness.
- Supabase unreachable → render cached stop list; disable add/remove.
- Unknown stop ID → EMT returns no arrivals; show that plainly rather than as an
  error, since a typo'd ID looks identical to a stop with nothing due.

## Testing

- Worker: EMT auth handshake, token cache hit/expiry/401-relogin, arrivals
  parsing against a recorded response, CORS, write-secret rejection.
- Page: countdown ticking, staleness formatting, cache fallback when the worker
  is down.
- Recorded EMT fixtures rather than live calls, so tests do not burn quota.

## Open questions

- Repo is still named `emt_madrid_widget` and there is no widget. Rename, or
  note it in the README?
- Does the page need a "refresh all stops" control, or is per-card enough?
- How many arrivals per stop to show — 2, 3, all?

## History

Originally specified as an Android home screen widget (Glance, WorkManager,
sideloaded APK). Dropped: install and update friction, and platform limits,
outweighed the benefit over a home-screen webpage. The widget design's good
parts — tap-to-refresh, local countdown, staleness marker, never-empty state —
carried over intact. The "no backend" decision did not survive the move to a
public page.
