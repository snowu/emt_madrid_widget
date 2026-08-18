# EMT Madrid Arrivals â Web App Design

Date: 2026-08-18
Status: approved (pending spec review)

## What this is

A personal webpage showing live EMT Madrid bus arrival times for a handful of
saved stops. Opened from a phone home screen. Single user.

This replaces the original Android widget design. See "History" below.

## Scope

- **In:** EMT Madrid city buses. Saved stops shared across devices. Live
  arrivals, local countdown, staleness marker.
- **Out:** Metro, CercanÃ­as, interurbanos (CRTM â different API, different stop
  ID namespace; do not mix without an explicit decision). GTFS stop-name search.
  Native app of any kind.

## Architecture

Three pieces, two deploy targets:

```
web/    static page          â GitHub Pages (public, holds no secrets)
api/    Cloudflare Worker    â holds EMT credentials + SUPABASE_SERVICE_KEY
        Supabase Postgres    â bus_stops table (RLS on, zero policies)
```

Data flow: page â worker â (EMT API | Supabase). The page never talks to EMT or
Supabase directly.

### Why a backend at all

The original design had none: an APK on one device could hold its own
credentials. A public webpage cannot â browser JS keeps no secrets, and EMT
almost certainly sends no CORS headers, so direct calls would be blocked
regardless. The worker exists to hold credentials and to be a CORS-allowed
origin. It is deliberately minimal: secrets plus request forwarding.

### Why Cloudflare Workers

Free plan rejects requests past the daily limit rather than billing for them.
No card attached, so cost cannot balloon. (Verify current limits against
Cloudflare's pricing page before relying on exact figures.)

### Why Supabase

Saved stops must be identical on every device â that was the requirement that
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

Stop IDs are typed in by hand. No GTFS index in v1 â that pipeline is only
worth building if hand-entry becomes annoying.

## Worker endpoints

```
GET    /stops              â list saved stops
POST   /stops              â add one (stop_id, optional label)
DELETE /stops/:id          â remove one
GET    /arrivals?stop=1234 â live arrivals for one stop
```

CORS restricted to the GitHub Pages origin.

### EMT auth

1. Log in against the EMT auth endpoint with credentials from worker env vars.
2. Response carries `accessToken` and `tokenSecExpiration` (~24h).
3. Cache the token in Worker KV with its expiry.
4. Check expiry before each call; re-login lazily on 401 rather than on a timer.

Arrivals response fields, per incoming bus â verify exact names against the
live docs before coding against them:
- `lineId` â line number
- `busTimeLeft` â seconds until arrival
- `busDistance` â metres from the stop

Quota is ~20,000 calls/day on the generic login, enormous for one user. If it
ever binds, register an app in MobilityLabs for a dedicated
`X-ClientId`/`passKey` pair.

Attribution: EMT asks that MobilityLabs be credited as the data source.

### Write protection

`POST` and `DELETE` are reachable by anyone who finds the worker URL. The page
sends `X-App-Key`; the worker rejects writes without it.

The key ships in public JS, so this is **not authentication** — it authenticates
nothing. It filters automated scanners, not a person who viewed source. Recorded
plainly so this reads as a chosen risk rather than an oversight.

Blast radius if bypassed: junk rows in, or deletion of, the `bus_stops` table.
EMT credentials and the Supabase service key live in worker env and are never
sent to the browser. RLS with zero policies means the table is unreachable
except through the worker. Recovery is deleting rows by hand — minutes.

The larger exposure is quota, not the table. `GET /arrivals` is unauthenticated
by design (the page needs it on load), so someone hammering it burns the
~20k/day allowance. Mitigated by caching arrivals in Worker KV for 20s, which
cuts quota use from normal browsing too. Symptom would be a page that stops
working until the daily reset.

Rejected as disproportionate for one user: Cloudflare Access in front of the
worker (real auth, free, ~15 min setup), and a passphrase typed once per device
into localStorage (never shipped in JS). Either is the correct move if this
stops being theoretical.

## Page behaviour

One page, no router. Stops listed as cards, each showing its next arrivals.

1. **Local countdown.** EMT returns seconds-to-arrival. Tick it down in the
   browser between fetches so numbers move every second rather than freezing.
2. **Staleness marker.** Every rendering of arrival data carries "updated N ago".
3. **Never render empty.** On load or failure, show last-known arrivals from
   localStorage with their staleness marker instead of a spinner or blank. A
   stale number beats a spinner â but only ever shown with its age attached.
4. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Two arrivals per stop: the next bus and the fallback if you miss it. That
matches the actual decision being made — leave now or not — and keeps cards
small enough that several stops fit one phone screen.

Refresh: automatically on page load and on returning to a backgrounded tab;
manually per-card (tap one stop) or all at once via a single control.

## Error handling

- EMT 401 â re-login once, retry, then surface the failure.
- EMT unreachable or slow â keep showing cached arrivals with staleness.
- Supabase unreachable â render cached stop list; disable add/remove.
- Unknown stop ID â EMT returns no arrivals; show that plainly rather than as an
  error, since a typo'd ID looks identical to a stop with nothing due.

## Testing

- Worker: EMT auth handshake, token cache hit/expiry/401-relogin, arrivals
  parsing against a recorded response, CORS, write-secret rejection.
- Page: countdown ticking, staleness formatting, cache fallback when the worker
  is down.
- Recorded EMT fixtures rather than live calls, so tests do not burn quota.

## Decided

- Repo keeps the name `emt_madrid_widget` despite there being no widget.
  Renaming was judged not worth the churn; the README carries a note explaining
  the name.
- Two arrivals per stop.
- Both per-card and refresh-all controls.
- Write protection: shared header plus a 20s arrivals cache (see above).

## History

Originally specified as an Android home screen widget (Glance, WorkManager,
sideloaded APK). Dropped: install and update friction, and platform limits,
outweighed the benefit over a home-screen webpage. The widget design's good
parts â tap-to-refresh, local countdown, staleness marker, never-empty state â
carried over intact. The "no backend" decision did not survive the move to a
public page.
