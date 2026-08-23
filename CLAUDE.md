# EMT Madrid Arrivals

A personal webpage showing live EMT bus arrival times for a handful of saved
stops. Opened from a phone home screen. Single user, not going to any store.

Design doc: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`.

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
web/    static page, deployed to GitHub Pages. Holds no secrets.
api/    Cloudflare Worker. Holds EMT credentials + SUPABASE_SERVICE_KEY.
supabase/   bus_stops.sql, bike_stations.sql
```

Page → worker → (EMT | Supabase). The page never calls EMT or Supabase directly:
browser JS keeps no secrets, and EMT sends no CORS headers.

## BiciMAD

Same auth, same host, read-only:

```
Stations GET v2/transport/bicimad/stations/          → 680 stations, one call
Near     GET v2/transport/bicimad/stations/arroundxy/{lon}/{lat}/{radius}/
Station  GET v1/transport/bicimad/stations/{id}/
```

Per station: `id` (EMT's key) and `number` (what is painted on it — they
differ, 1409 is signed "5"), `name`, `address`, `geometry`, `dock_bikes`,
`free_bases`, `total_bases`, `reservations_count`, `light` (0 green / 1 amber /
2 red), `no_available` (out of service), `overflow`, `tipo_estacionPBSC`
(FIXED, one VIRTUAL), `bikesGo` (empty everywhere so far).

All 680 arrive in one answer, so the worker fetches the whole city once a
minute and slices it locally — `arroundxy` is never needed, and an area query
costs no EMT call at all. Counts move constantly: KV's 60s floor is the
freshness contract, and every rendering carries its age.

**The API cannot unlock a bike and knows nothing about your account.** Every
user, trip, reservation and unlock path is a 404 (`bicimad/user/*`,
`bicimad/trips/*`, `bicimad/reserve/`, `bicimad/unlock/`, `mobilitylabs/user/info/`).
MobilityLabs publishes station telemetry only; unlocking runs through BiciMAD's
own app against PBSC's backend, which is not this API. So no fares, no trip
history, no spend tracking from here — anything of that sort would have to be
entered by hand.

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
not found / invalid token, `81` no detail record. Handle
both an HTTP error and a 200 carrying an error code.

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
Retries get through; the token cache means most calls skip login entirely.

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

**EMT's own `stroke` is per direction, not per line** (line 27 is `#a95516` out
and `#a9559c` back) and looks procedurally generated rather than branded, so it
is not a line identity. The page derives its own colour per line instead, by
golden-angle hue rotation over the line code, and uses it for both the drawn
route and every label of that line — same line, same colour, everywhere.

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

`startTime`/`stopTime` are the answer to "how can nothing be due?" — at 02:00 a
Plaza Castilla bay running 07:30–23:45 is correctly empty, not broken.

For a stop EMT has no detail record for, the same answer comes from the line:
`lines/{line}/timetable/` is keyed on the codes area search hands back. Three
traps in that response:

- **The times are datetimes, and the dates matter.** "16/08/2026 23:40" →
  "17/08/2026 5:45" is a night line crossing midnight. Compare instants, not
  clocks, or a Friday-night line running 04:40 → 06:15 *the next morning* reads
  as a 95-minute window.
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
worker rejects writes without it. Reads send neither it nor a content type, so
they stay CORS "simple requests" and skip the preflight — otherwise every read
costs two round trips, which on a phone is the difference you feel. The key ships in public JS — it stops
scanners, not people. Deliberate: blast radius is junk rows in a personal table.
Arrivals are cached 20s in KV, which also blunts quota abuse. See the design doc
for what was rejected and when to revisit.

## Page behaviour

Two arrivals per stop: the next bus and the fallback if you miss it.

1. **Local countdown.** Tick `estimateArrive` down in the browser between fetches
   so numbers move every second instead of freezing.
2. **Staleness marker.** Every rendering of arrival data carries "updated N ago".
3. **An empty board says when the first bus is.** "Nothing due" is the true
   answer at 04:00 but it is not a useful one, and it makes one stop look
   broken next to another that has night buses. Where nothing is due, the card
   shows the first departure of the day and the wait — computed from the same
   service windows the sheet lists, borrowing the line's hours for stops EMT
   has no detail record for. If a line *should* be running now, the text stays
   "No buses due right now": EMT having no estimate is a different thing from
   the stop being asleep, and promising a 07:00 first bus at 09:00 would be a
   lie.
4. **Never render empty.** Show last-known arrivals from localStorage rather
   than a spinner or blank. A stale number beats a spinner — but only ever with
   its age attached.
5. **Add/remove stops in the page**, since the phone is the device that has this
   problem. A TUI was considered and dropped: it would run on the laptop, which
   is exactly where you are not when you want to add a stop.

Refresh: automatically on load and on tab focus; manually per-card or all at
once.

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

Cached payload shapes are versioned in the worker's KV keys (`CACHE_VERSION`).
Bump it when a parsed shape changes, or week-old detail entries keep serving
the old one.

Line colour is derived from the line code by FNV-1a hashed into 24 hues and
two tones. A free-running hue put 5 and 107 five degrees apart — colliding
outright is fine, looking almost-the-same on a card listing six lines is not.

**GitHub Pages sends `max-age=600` on every asset and gives no way to change
it**, so a phone keeps running the old `app.js` after a deploy — a home-screen
one for longer. The Pages workflow stamps the commit sha onto each local asset
URL (`app.js?v=…`, including the `./cache.js` import inside it) so every deploy
is a new URL. If a change seems not to have shipped, check that stamp first.

## Testing

Recorded EMT fixtures, not live calls — tests shouldn't burn quota.

## Reference

`innocent_project` (same machine) is the closest pattern: Supabase with RLS and
zero policies, service key from a gitignored `.env`, plain REST against
`/rest/v1/<table>` with no SDK.

`fermartv/emt_madrid` (Home Assistant integration) and `fermartv/EMTMadrid`
(Python wrapper) are useful references for the auth handshake and response
shapes.
