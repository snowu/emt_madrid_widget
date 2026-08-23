# Performance and external-call audit

Reviewed against the current browser and Worker request paths on 2026-08-23.
The priority is to protect EMT's daily allowance and Cloudflare's free quotas
without making live arrival or bike data misleadingly stale.

## Storage and request boundaries

- Public EMT and GBFS responses use `caches.default`, not Workers KV. Cache API
  operations do not spend the project's KV operation allowance.
- KV contains only the shared EMT token and the owner-only MPass session. Both
  also have isolate-memory hot caches, and concurrent cold logins share one
  promise.
- Public cache misses for the same key share one in-flight promise per Worker
  isolate. This closes the gap before `ctx.waitUntil(cache.put(...))` finishes.
- Supabase remains authoritative for each user's saved stops, saved stations,
  and ratings. Its JWT plus row-level security performs identity enforcement.

## Calls by user action

| Action | Browser → Worker | External calls on a warm cache | Cold-cache ceiling |
| --- | ---: | ---: | ---: |
| Open signed-in app | config, identity, saved buses, saved bikes | 3 Supabase; stale arrivals only | one EMT arrival call per stale saved stop |
| Refresh one bus stop | 1 | 0 inside 20s edge TTL | 1 EMT arrival call |
| Refresh all buses | one request per saved stop, concurrent | 0 for warm stops | one EMT arrival call per cold stop |
| Open or pan bus map | 1 per ~110m search cell | 0 for a cached cell | 1 EMT nearby call |
| Open or pan bike map | 1 combined nearby + saved request | 0 inside 45s | 2 GBFS reads; 1 MobilityLabs fallback if GBFS fails |
| Reopen bike trip history | 0 after first complete load | 0 | one EMTPay trip call per 30-row page, plus userdata once per MPass session |
| Read bike account status | 1, owner only | 1 EMTPay userdata call | plus 1 MPass login when the session expired |
| Read/write bike ratings | 1 | 1 Supabase REST call | same |

The browser coalesces identical concurrent GETs. Bus arrival data also has a
20-second local freshness guard, and the one-second countdown timer updates
text nodes instead of rebuilding every card. A bulk refresh writes the whole
arrival cache once and renders once.

## Removed amplification

- Bike map refresh no longer follows `/bikes/nearby` with a separate
  `/bikes/stations?ids=...`; saved stations ride in the nearby response.
- Trip searches no longer download all history again. The full history and
  ratings are loaded once per browser session, then filtered/grouped locally.
- Each trip page no longer performs an identical userdata lookup; the NIF is
  retained only in the encrypted Worker secret store/session cache.
- Nearby healing for detail-less saved bus stops clusters origins covered by a
  500m search instead of issuing overlapping calls around every known stop.
- Ratings no longer call Supabase Auth before PostgREST. The bearer JWT and RLS
  already validate the user during the one required database request.
- Location-based ordering is browser-only arithmetic over coordinates already
  loaded; reordering itself makes no EMT call.

## Intentional trade-offs and remaining ceilings

- Cache API is data-centre-local, unlike globally replicated KV. A cold request
  in a different Cloudflare location can call EMT again, but the app's small,
  Madrid-centred audience makes that cheaper than consuming KV operations for
  every read and write.
- Arrival requests remain per stop because EMT exposes a per-stop endpoint.
  Parallel refresh minimizes latency; the 20-second edge and browser guards
  prevent rapid repeats.
- Trip history is paginated upstream and owner-only. Pages stay sequential to
  avoid a burst of private EMTPay calls and because the final page is unknown.
- Saved buses and saved bike stations remain separate Supabase calls. Combining
  the Worker routes would remove one browser round trip but not one database
  call, while coupling two independently optional datasets.
