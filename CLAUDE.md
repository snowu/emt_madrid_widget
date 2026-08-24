# EMT Madrid Arrivals

A personal webpage showing live EMT bus arrival times and BiciMAD dock counts
for a handful of saved stops. Opened from a phone home screen. Single user, not
going to any store.

Design doc: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`.
Implementation plan: `docs/superpowers/plans/2026-08-18-emt-arrivals-web-app.md`.

**The repo is named `emt_madrid_widget` and there is no widget.** This started
as an Android home screen widget and became a webpage; the name was kept to
avoid churn. Ignore it.

## Scope

- **In:** EMT Madrid city buses, and BiciMAD (same MobilityLabs API, same
  token).
- **Out (for now):** Metro, Cercanías, interurbanos. Those are CRTM, a separate
  API with a different stop ID namespace. Don't mix the two without an explicit
  decision — stop IDs are not interchangeable.

## Layout

```
web/                 static page, deployed to GitHub Pages. Holds no secrets.
  index.html         every dialog and view lives here; nothing is templated in JS
  app.js             the whole page (~1.6k lines), one ES module, no framework
  cache.js           localStorage read/write helpers
  trips.js           pure trip identity, ordering and incremental-merge helpers
  style.css          system/light/dark themes, phone-first; no preprocessor
  manifest.webmanifest, icon.svg    home-screen install
api/                 Cloudflare Worker. Holds EMT and optional owner MPass credentials.
  src/index.js       routing, CORS, auth boundaries, every edge-cache decision
  src/emt.js         EMT auth + buses: token, arrivals, detail, nearby, timetable, route
  src/bikes.js       BiciMAD stations + local distance filtering
  src/trip-monitor.js bounded 30-minute owner trip reconciliation monitor
  src/stops.js       Supabase REST for saved bus stops and saved bike stations
  src/errors.js      EmtError kinds → HTTP status
  test/              vitest under workerd, recorded fixtures in test/fixtures/
  wrangler.toml      name, KV binding, ALLOWED_ORIGIN. No secrets.
  vitest.config.js   fake credential bindings for tests
supabase/            bus_stops.sql, bike_stations.sql — run by hand, once
.github/workflows/pages.yml    deploys web/ and stamps the cache-buster
```

Page → worker → (EMT | Supabase). The page never calls EMT or Supabase directly:
browser JS keeps no secrets, and EMT sends no CORS headers.

Deployed: page at `https://snowu.github.io` (the worker's `ALLOWED_ORIGIN`),
worker at `https://emt-arrivals.zancato-t.workers.dev` (the page's `API`).
Both are hardcoded; changing one means changing the other.

## Worker API

Live transport reads are open and share global caches. Saved stops/stations
require a Supabase bearer token for every method; Postgres RLS scopes rows to
that authenticated user.

```
GET    /auth/config                public Supabase URL + publishable/anon key
GET    /auth/me                    current user summary + owner flag
GET    /arrivals?stop=&limit=      limit 1–20, default 2
GET    /stops                      saved stops (Supabase rows)
POST   /stops                      {stopId, label?}          → 201
PATCH  /stops/:rowId               {label}                    empty label → EMT's name
DELETE /stops/:rowId                                         → 204
GET    /stops/:stopId/detail       name, address, coords, lines
GET    /stops/nearby?lat=&lon=&radius=   radius 50–3000, default 500
GET    /lines/:line/route          both directions: paths + stops
GET    /lines/:line/timetable      service window per day type
GET    /bikes/stations?ids=a,b     all 680, or just the ids asked for
GET    /bikes/nearby?lat=&lon=&radius=&ids=   nearby plus optional saved stations
GET    /bikes/account?refresh=1       cached eligibility; refresh=1 rechecks upstream
GET    /bikes/trips?page=&bike=       owner-only normalized trip history
GET    /bikes/ratings                 current user's bike ratings
PUT    /bikes/ratings/:bikeNumber     {rating: 1..5}
GET    /bikes/saved                favourite stations
POST   /bikes/saved                {stationId, label?}       → 201
PATCH  /bikes/saved/:rowId         {label}
DELETE /bikes/saved/:rowId                                   → 204
```

`:rowId` is the Supabase uuid, not the EMT id — `/stops/:stopId/detail` is the
one route keyed on EMT's number. Errors come back as
`{error: kind, message}` with `user_auth` (401) and `forbidden` (403) for caller
authorization, plus `auth | quota | not_found | upstream` for dependencies.
Upstream auth and upstream failures are 502; quota is 503 until daily reset.

### Cache keys and TTLs

Public transport payloads use the Workers Cache API, which does not consume KV
operations. KV holds shared credentials plus the normalized owner-status cache.
TTLs are declared at the top of `src/index.js`:

| key | storage | TTL | why |
| --- | --- | --- | --- |
| `emt:token` | KV + isolate memory | login expiry − 60s | shared credential, not public data |
| `bicimad:owner-session` | KV + isolate memory | login expiry − 60s | private MPass session, NIF and normalized account status |
| `arrivals/` | Cache API | 20s | one full board serves card and detail views |
| `bikes` | Cache API | 45s | one call serves the whole city, nearby and saved stations |
| `bike-info` | Cache API | 24h | station names and coordinates are nearly static |
| `detail/` | Cache API | 7 days | stops do not move |
| `route/` | Cache API | 7 days | geometry changes when EMT redraws a line |
| `nearby/` | Cache API | 24h | keyed on a ~110m grid (`grid3`) |
| `timetable/` | Cache API | 24h | changes with the season, not the hour |

`CACHE_VERSION` is currently **v4**. Bump it when a parsed public payload shape
changes so old Cache API objects cannot serve an incompatible response.

## Development

```bash
cd api
npm install
npm test          # vitest under workerd; 94 tests, no network, no quota burnt
npm run dev       # wrangler dev, needs .dev.vars
npm run deploy    # wrangler deploy
```

The page has no build step: open `web/index.html`, or serve the directory. It
talks to the deployed worker, not a local one, unless you edit `API` in
`app.js`.

**Secrets never go in `wrangler.toml`.** A `[vars]` entry blocks creating a
secret of the same name later. Locally they live in `.dev.vars` (gitignored,
`cp .dev.vars.example .dev.vars`); in production, `wrangler secret put <NAME>`
for each of `EMT_EMAIL`, `EMT_PASSWORD`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and `OWNER_USER_ID`, plus the optional MPass secrets below.
Tests get fakes from `vitest.config.js`'s miniflare bindings.

The optional `/bikes/account` route first verifies the Supabase user and allows
only `OWNER_USER_ID`. It logs in lazily with the `MPASS_EMAIL`,
`MPASS_PASSWORD`, `MPASS_CLIENT_ID`, `MPASS_PASSKEY`, and `MPASS_DEVICE_ID`
Worker secrets, caching only the resulting token in KV until its reported
expiry. It returns only booleans, the opaque numeric state, and a timestamp—
never PII or upstream identifiers.

Supabase tables are created by hand: paste `supabase/bus_stops.sql` and
`supabase/bike_stations.sql` into the SQL editor, once. The bikes one is
optional — without it the favourites call 502s and the page says so rather than
breaking the section.

Deploys: pushing to `main` with changes under `web/**` runs the Pages workflow.
The worker is **not** deployed by CI — `npm run deploy` by hand.

`wrangler.toml`'s `compatibility_date` is ahead of the installed runtime, so
tests print a "falling back to 2024-12-30" warning per worker. Expected noise.

## Testing

Recorded EMT fixtures, not live calls — tests shouldn't burn quota. New
fixtures are recorded from a real answer and left in EMT's own shape
(`code`, `data[0].Arrive[]`, capital `D` in `DistanceBus`), with a comment
saying when they were recorded.

Conventions, worth matching:

- `import { env } from "cloudflare:test"` gives real bindings. Reset module-level
  token/session state in `beforeEach`; use unique request keys where a Cache API
  assertion must guarantee a cold miss.
- Upstream is stubbed with `vi.spyOn(globalThis, "fetch")` returning a **fresh
  `Response` per call** — bodies are single-use, and the retry paths call twice.
- `src/index.js` is exercised through `worker.fetch` with
  `createExecutionContext` / `waitOnExecutionContext`, not by importing routes.
- Seed `emt:token` in `beforeEach` unless the login path is what is under test;
  otherwise every test needs a login response in its mock.
- A cache test asserts the *second* call makes no upstream request. That is the
  actual contract — not that the value came back.

The Worker routes, auth boundaries, Cache API reuse, concurrent-miss
coalescing, and underlying parsers are covered. The browser UI still relies on
syntax checks and manual browser verification rather than DOM tests.

## Data source

**EMT MobilityLabs** — https://mobilitylabs.emtmadrid.es
API reference: https://apidocs.emtmadrid.es

Auth flow, all inside the worker:
1. Log in against the auth endpoint to receive an `accessToken`.
2. Token is valid roughly 24h (`tokenSecExpiration` in the login response).
3. Cache it in Worker KV with its expiry and in isolate memory for hot calls.
4. Re-login lazily on an auth-failure code rather than on a timer.

EMT reports failure as a `code` field inside a 200 response, not as an HTTP
status: `01` login ok **and** arrivals-with-no-estimations (empty `Arrive[]`,
e.g. night hours — it is a success there), `89` bad password, `92` no such
user, `98` quota spent; `00` ok (arrivals with data, stop detail), `80` stop
not found / invalid token, `81` no detail record. Handle
both an HTTP error and a 200 carrying an error code.

**Code 80 is ambiguous** — "stop not found" and "your token expired" are the
same code — so every fetcher in `emt.js` re-logs in once with
`getToken(env, {force: true})` and retries before believing the stop is bad.
Any new endpoint needs that same three-line dance.

**Code 81 does not mean the stop is nonexistent.** EMT's detail table has
holes for real stops: stop 30 (Plaza Castilla, lines 107/129/005/070) answers
81 on detail on v1 *and* v2 while arroundxy lists it and arrivals accepts it.
Bogus ids get code 80 with "Bus Stop disabled or not exists" on arrivals.
Validate stop ids against arrivals or arroundxy, never against detail alone.

Versioning: auth is v1; every transport call we make is v2. The docs list
detail under v1 too, but v2 answers identically (verified live 2026-08-23,
stops 1547/28/29), so we don't use it. Some transport endpoints exist under
both but only answer on v2 (`stops/arroundxy/` silently returns "no records"
on v1). When a call comes back empty on principle, try the other version.

Cloudflare↔EMT quirk: outbound TLS from Workers to `openapi.emtmadrid.es`
fails intermittently with HTTP 525 (same class as workerd#776 vs DeepL).
`emtFetch` retries once on any 5xx and passes 4xx straight through — a 4xx is
an answer, not a blip. Use it rather than bare `fetch` for anything EMT-bound;
the token cache means most calls skip login entirely.

Endpoints, verified 2026-08-18 against `fermartv/EMTMadrid`, re-verified live
2026-08-23:

```
Login      GET  v1/mobilitylabs/user/login/     headers: email, password
Arrivals   POST v2/transport/busemtmad/stops/{stop_id}/arrives/
                headers: accessToken
                body:    {stopId, Text_EstimationsRequired_YN: "Y"}
Stop detail GET  v2/transport/busemtmad/stops/{stop_id}/detail/
                headers: accessToken  → data[0].stops[0]:
                {stop, name, postalAddress, geometry.coordinates, dataLine[]}
Area search GET  v2/transport/busemtmad/stops/arroundxy/{lon}/{lat}/{radius}/
                headers: accessToken  → data[]: {stopId, stopName, lines[]}
Line hours GET  v2/transport/busemtmad/lines/{line}/timetable/
                headers: accessToken  → data[]: one row per day type with
                {dayType, dateIni, dateEnd, first/endTimeService A and B}
```

```
Line route GET  v2/transport/busemtmad/lines/{line}/route/
                headers: accessToken  → data:
                {label, line, nameSectionA, nameSectionB,
                 itinerary: {toA, toB}, stops: {toA, toB}}
                stops[] ride along in the same answer: {stopNum, stopName,
                distance} as GeoJSON Points — every stop on the line for free.
```

The itinerary arrives as ~160 one-segment GeoJSON Features per direction, not
one line — they are not guaranteed to join end to end, so keep them as separate
segments and let Leaflet draw the array as one multi-polyline. Coordinates come
with 15 decimal places; rounding to 6 (~10cm) roughly halves the payload, which
takes a line from 114KB to about 21KB.

**Every coordinate in this API is GeoJSON `[lon, lat]`** — EMT stop detail,
area search, route geometry, BiciMAD stations. The worker passes them through
in that order and never flips them; `web/app.js` flips at the Leaflet call,
which wants `[lat, lon]`. A pin in the sea is this, every time.

**EMT's own `stroke` is per direction, not per line** (line 27 is `#a95516` out
and `#a9559c` back) and looks procedurally generated rather than branded, so it
is not a line identity. The page derives its own colour per line instead — see
Page behaviour — and uses it for both the drawn route and every label of that
line.

Other line endpoints, verified 2026-08-23 but not used yet:
`lines/{line}/stops/{1|2}/` (ordered stop list + frequency bands),
`lines/info/{yyyymmdd}/` on v1 (index of all 239 lines).
`lines/{line}/` and `lines/{line}/grouproute/` are 404.

**Detail's line list is `dataLine[]`, not the `lines[]` the docs show.** A v2
detail answer has no `lines` key at all, so reading it yields an empty list for
every stop — which is how the page spent a day claiming no stop had any lines.
Each `dataLine` entry is one line for *today's* day type (`dayType` FE/SA/LA)
and carries what the page actually needs:

```
{line: "005", label: "5", direction, headerA, headerB,
 startTime: "07:30", stopTime: "23:30", maxFreq, minFreq}
```

`line` is EMT's internal code, `label` is what the bus is signed with — they
differ (005→5, 070→70, 523→N23, 833→SE833) and arrivals report the *label*.
Area search sends the same pair per line but no hours. A bare code cannot be
turned into a label by trimming zeros; if you only have the code, show it.
`lineEntry()` in `emt.js` normalises both shapes — detail objects and area
search's bare codes — into one record, and `normaliseLine()` in `app.js`
additionally tolerates the string-only shape older devices cached.

`startTime`/`stopTime` are the answer to "how can nothing be due?" — at 02:00 a
Plaza Castilla bay running 07:30–23:45 is correctly empty, not broken.

For a stop EMT has no detail record for, the same answer comes from the line:
`lines/{line}/timetable/` is keyed on the codes area search hands back. Three
traps in that response:

- **The times are datetimes, and the dates matter.** "16/08/2026 23:40" →
  "17/08/2026 5:45" is a night line crossing midnight. Compare instants, not
  clocks, or a Friday-night line running 04:40 → 06:15 *the next morning* reads
  as a 95-minute window. `serviceWindow()` reads `overnight` off the dates for
  exactly this reason.
- **Day types are LA (weekday), SA, FE (Sunday/holiday) and V** — Friday
  nights, which only night lines carry. A line with no row for today does not
  run today: line 833 (signed SE833) is weekdays-only, so on a Sunday its
  absence is the answer.
- **`lines/{line}/info/{date}/` ignores the date** for day-type selection — it
  returns all day types with a fixed `dateRef`. Pick the row yourself, using
  the `dayType` EMT stamps on stop detail (its own calendar, holidays
  included) rather than deriving one from the weekday.

Line hours are the whole line's first and last bus across both directions, so
they can be wider than the stop's own — the page marks borrowed hours with a
`*` rather than passing them off as stop-specific.

`estimateArrive = 888888` is EMT's "running on schedule, no GPS estimate yet"
sentinel, not a real countdown.

Arrivals live at `data[0].Arrive[]`. Per bus:
- `line` — line number (string)
- `estimateArrive` — seconds until arrival
- `DistanceBus` — metres from the stop (capital D)

Also present: `bus`, `destination`, `geometry.coordinates`, `isHead`.

`StopInfo[]` in the arrivals answer is always empty — with estimations and
without. It is not a way to learn about a stop.

The worker parses and caches **every** arrival EMT sent, sorted soonest-first,
and `limit` only trims what one caller gets. The card (2) and the stop sheet
(8) therefore share a single fetch.

Quota: ~20,000 calls/day on the generic login. If it ever binds, register an app
in MobilityLabs for a dedicated `X-ClientId` / `passKey` pair.

Attribution: EMT asks that MobilityLabs be credited as the data source.

## BiciMAD

**Counts come from PBSC's own GBFS feed, not MobilityLabs.** PBSC operates
BiciMAD and publishes the system feed at
`https://madrid.publicbikesystem.net/customer/ube/gbfs/v1/en/` — no auth, no
CORS headers (so the worker proxies it), 30s TTL:

```
station_information  names, addresses, lat/lon, capacity, short_name
station_status       num_bikes_available, num_bikes_disabled, num_docks_*,
                     is_renting, is_returning, is_installed, status
system_information   679 stations, 8942 ebikes, 0 mechanical
system_pricing_plans EMPTY — plans: []. No fares here.
```

PBSC currently publishes neither `vehicle_status` nor the legacy
`free_bike_status` for Madrid (both paths return 404), so the public surface
cannot map individual bike ids to their present station. MobilityLabs'
`bikesGo` is empty as well. Trip history can score a known bike id, but cannot
locate it; ranking bikes within a station requires a legitimate customer-app
station-detail response that actually contains those ids.

**MobilityLabs' `dock_bikes` counts bikes that are docked, not bikes you can
rent.** Measured 2026-08-23: the two disagree on **227 of 680 stations**, and
859 bikes city-wide are flagged `num_bikes_disabled`. Metro Callao read 5 bikes
on MobilityLabs and 0 rentable on GBFS. Station ids are the same namespace in
both, so the feeds merge on `station_id`. GBFS is the source; MobilityLabs
stands in when it is unreachable, and the page says so, because its counts are
the rougher kind.

GBFS is a *publication* spec: it has no write operations at all, by design.

The MobilityLabs BiciMAD endpoints, kept as the fallback:

```
Stations GET v2/transport/bicimad/stations/          → 680 stations, one call
Near     GET v2/transport/bicimad/stations/arroundxy/{lon}/{lat}/{radius}/
Station  GET v1/transport/bicimad/stations/{id}/
```

Per station: `id` (EMT's key) and `number` (what is painted on it — they
differ, 1409 is signed "5"), `name`, `address`, `geometry`, `dock_bikes`,
`free_bases`, `total_bases`, `reservations_count`, `light` (0 green / 1 amber /
2 red / 3 black), `no_available` (out of service), `overflow`,
`tipo_estacionPBSC` (FIXED, one VIRTUAL), `bikesGo` (empty everywhere so far).

All stations arrive in one answer, so the worker fetches the whole city at
most once per 45-second edge-cache window and slices it locally — `arroundxy`
is never needed, and an area query usually costs no upstream call at all.
`stationsNear()` filters by an equirectangular
distance, which over a few km in Madrid is accurate to centimetres and far
cheaper than haversine per station. `parseStation()` trims EMT's record to
about a fifth of its size (318KB → ~60KB for the city) and inverts
`no_available` into `inService`, so the page reads the field the way it renders
it. Counts move constantly: the Cache API's 45-second TTL is the freshness
contract, and every rendering carries its age.

**Public transport endpoints do not expose subscriber accounts.** A sweep of
MobilityLabs' transport families found stations but no customer account data.
Its login is an API-developer account (`nameApp: OPENAPI MobilityLabs`, quota),
not a BiciMAD subscription. PBSC's `madrid.publicbikesystem.net/customer/*`
paths are also not what the current BiciMAD app uses for account features.

**Per-user state lives in EMT MPass/EMTPay (mapped from the published Android
app 5.8.8 on 2026-08-23).** The current app uses:

```
GET https://apiemtpay.emtmadrid.es/v2/bicimad/userdata/
    NM_STATE, IT_STATUS, DS_BALANCE, contracts and access media
GET https://apiemtpay.emtmadrid.es/v2/bicimad/trips/
    start/end time, trip cost, old/new balance, bonuses and penalties
GET https://api.mpass.mobi/v1/core/identity/whoami
GET https://api.mpass.mobi/v3/transportcard/list/0
```

The APK also contains live v3/v4 userdata variants. All are authenticated with
a legitimate MPass `accessToken`, user id and device/app headers; trips also
need NIF and the BiciMAD session id. The MPass media-state enum is
`INACTIVO=1`, `ACTIVO=2`, `BLOQUEADO=3`, `PENDIENTE=4`, `SIN_USUARIO=5`, but
those values describe an access medium and must not be assumed to equal
`NM_STATE`. Exact user-state labels require observing the account holder's real
response.

The official customer operation at
`apiemtpay.emtmadrid.es/v1/bicimad/booking/` reserves a **dock/base at a
station** (POST; DELETE cancels). It does not lock a particular bike. PBSC's
Comet frontend has temporary bike-lock operations, but those are fleet-operator
controls and are not customer features.

The older `mpass.mobi` portal additionally references account, linked-card and
debt views through `maas.emtmadrid.es:8243`, but its bundled application key
has rotated. Do not bypass either application or user authentication. The
account owner has approved read-only investigation; use their normally issued
session, never copy embedded app credentials into this repo, and never invoke
write endpoints while researching. Full findings and response fields are in
`docs/bicimad-account-api-research.md`; `tools/bicimad-account.mjs` is the
GET-only probe.

The captured trips request exposes only `page`; no date, cursor or `since`
parameter has been observed. The browser therefore persists normalized trips
per signed-in user and performs overlap-based incremental sync: newest-first
feeds start at page 0 and stop on a known trip; an oldest-first ordering resumes
from the previous final page. A manual Refresh repeats that sync.

A `*/30 * * * *` Cron Trigger polls only trip page 0 while the app is closed.
One KV key holds the latest normalized page and at most four field-delta
revisions per trip. Revisions disappear after 48 hours without another change;
raw EMTPay payloads, credentials and identity fields are never stored. The
owner-only `/bikes/trip-diagnostics` route supplies these revisions to the
existing trip cards.

Aggregate usage *is* available separately: datos.madrid.es publishes
anonymised BiciMAD trips 2017-2023 and station status by day/hour.

## Architecture decisions

**Minimal backend, holding only secrets.** The worker exists because a public
page cannot hold credentials and cannot call EMT directly (CORS). It forwards
requests and retains shared login state, normalized owner status, and one
bounded normalized trip-monitor snapshot; raw account payloads never enter a
cache or browser response.

**Cloudflare Workers, free plan, no card attached.** Past the daily limit the
free plan rejects requests rather than billing. Cost cannot balloon.

**Supabase Auth + RLS for saved data.** Users enter no app password: Supabase
sends an email magic link. The page sends the resulting JWT to the Worker; the
Worker forwards it to PostgREST with the publishable/anon project key. RLS
compares `auth.uid()` with each row's `user_id`, providing the actual tenant
boundary even if a route filter is missed.

**localStorage is a cache, not shared state.** Public arrival/detail/count data
is shared locally. Saved-stop, favourite-station, owner-status and normalized
trip-history caches are namespaced by Supabase user id so two people using one
browser never see each other's data. EMT/Supabase remain authoritative;
`cache.js` only provides last-known and incremental-sync state.

**Stop IDs are typed in by hand.** No GTFS index; build that pipeline only if
hand-entry becomes annoying. (The map's nearby search has since made this
mostly moot for discovery.)

**Personal reads and writes are authenticated.** The page sends its Supabase
JWT, and Postgres RLS authorizes the row. Public transport reads stay open so
all users share the same upstream cache.

**No framework, no build step, no bundler.** `app.js` is one ES module
importing one other. Leaflet and Supabase Auth come from CDN `<script>` tags.
Every dialog and control is already in `index.html`; JS fills them rather than
templating. Keeping it that way is why a deploy is "copy `web/` to Pages".

## Page behaviour

Two sections — Buses and BiciMAD — behind a top menu, each with a List and a
Map view. The section menu swaps the title, the FAB (add stop) for the locate
button, and which pair of panes is visible.

Two arrivals per stop: the next bus and the fallback if you miss it.

1. **Local countdown.** A 1s interval re-renders so `estimateArrive` and every
   "updated N ago" tick between fetches instead of freezing. It refetches
   nothing.
2. **Staleness marker.** Every rendering of arrival or bike data carries
   "updated N ago".
3. **An empty board says when the first bus is.** "Nothing due" is the true
   answer at 04:00 but it is not a useful one, and it makes one stop look
   broken next to another that has night buses. Where nothing is due, the card
   shows the first departure of the day and the wait — computed from the same
   service windows the sheet lists, borrowing the line's hours for stops EMT
   has no detail record for. If a line *should* be running now, the text stays
   "No buses due right now": EMT having no estimate is a different thing from
   the stop being asleep, and promising a 07:00 first bus at 09:00 would be a
   lie.
4. **Never render empty.** Show last-known data from localStorage rather than a
   spinner or blank — `render()` runs before `loadStops()` on boot. A stale
   number beats a spinner, but only ever with its age attached.
5. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Refresh: on load, on `visibilitychange` back to visible (exactly when the data
is most stale), and manually per-card or all at once.

6. **Tap a card to open the stop.** The sheet holds a small map of where it is,
   the full arrival board rather than the card's two, the lines with today's
   hours, and an editable name. An empty name hands the title back to EMT's.
7. **Heal detail-less stops from area search.** A stop EMT has no detail record
   for (code 81) has no name, lines or coordinates of its own. arroundxy knows
   all three, so on load the page searches around each saved stop it *can*
   place and fills in the blind ones — stops cluster, so a Plaza Castilla bay
   is healed by the bay next to it. Results are cached in the worker for a day,
   so this costs close to nothing.
8. **Line routes on the map, one direction at a time.** Every line in a map
   popup is a chip; tapping cycles out → back → off, and the legend chip names
   where that direction ends up ("70 → ALSACIA"). Both directions drawn at once
   was unreadable: they run along the same streets, so one hides the other.
   Arrowheads along the path give the heading — solid versus dashed is not
   legible at the zoom a phone map sits at. The polylines are
   `interactive: false`: a route running through a stop must not swallow taps
   meant for the pin.
9. **Stops en route come free.** The route answer already carries every stop
   the line calls at, so drawing them costs no extra request. They are drawn as
   dots in the line's colour for the direction on screen, skipping saved stops,
   which have their own pin.
10. **Times before you save a stop.** An unsaved stop's popup shows its live
   arrivals, so you can tell whether it is the right side of the road before
   adding it. Those arrivals stay in memory — localStorage is the cache for
   stops you actually keep.
11. **Bikes are counts, not countdowns.** A station card shows rentable bikes
   over total station capacity, lists disabled bikes separately, marks
   out-of-service stations,
   and carries the age of the whole city fetch. The locate button asks for
   geolocation and recentres; without it the map falls back to Puerta del Sol.
   Saved stations are optional — if `bike_stations` was never created, the page
   says so once and the rest of the section still works.

Cached payload shapes are versioned in the worker's Cache API keys (`CACHE_VERSION`).
Bump it when a parsed shape changes, or week-old detail entries keep serving
the old one.

Line colour is derived from the line code by FNV-1a, quantised into 24 hues
with lightness and saturation each picked by a hash bit. A free-running hue put
5 and 107 five degrees apart — colliding outright is fine, looking
almost-the-same on a card listing six lines is not. (The docstring above
`lineColor` still says "golden-angle rotation"; the code has been FNV-1a since,
and the comment inside the function is the accurate one.)
The same colour is used for the line's label on a card, its chip in a popup,
its route polyline and its en-route dots: same line, same colour, everywhere.

**GitHub Pages sends `max-age=600` on every asset and gives no way to change
it**, so a phone keeps running the old `app.js` after a deploy — a home-screen
one for longer. The Pages workflow stamps the commit sha onto each local asset
URL (`app.js?v=…`, including the `./cache.js` import inside it) so every deploy
is a new URL. If a change seems not to have shipped, check that stamp first.
The `sed` in that workflow matches asset names literally — **adding a new file
to `web/` means adding it to the workflow's pattern**, or it deploys uncached.

## Reference

Supabase Auth issues the browser session; PostgREST evaluates the user JWT
against the per-table RLS policies. `supabase/migrate_multi_user.sql` converts
the original owner-only tables without discarding existing rows.

`fermartv/emt_madrid` (Home Assistant integration) and `fermartv/EMTMadrid`
(Python wrapper) are useful references for the auth handshake and response
shapes.
