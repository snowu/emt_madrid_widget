---
status: accepted
---

# One EMT client and one Hub planner, each behind a small interface

Decided 2026-10-16 from an architecture review. Two pieces of the worker kept
their rules spread across callers: every EMT fetcher carried its own copy of the
code-80 re-login dance (seven copies, already disagreeing on which codes mean
success), and hub planning lived in the router (`index.js`) where its night,
radius and walking rules could only be reached through HTTP and had two tests.
We deepen both, EMT client first, one PR each.

## EMT client

- `emtClient(env, { account, who })` in `emt.js` is the only way to call EMT.
  `account` is either a lazy resolver (per request, so cache hits never look up
  a connection) or a fixed account (stop pollers, live stops). `who` is the
  metrics caller class.
- The client owns the token, the code-80 force-re-login retry, the 5xx retry,
  metrics, and per-endpoint success codes (arrivals `00`/`01`, everything else
  `00`). Anything else goes through `raiseForCode`, so a spent quota on the
  BiciMAD stations fallback is `quota` (503), not `upstream` (502).
- Fetchers keep their names and parsers and take the client first
  (`getArrivals(emt, stopId)`). They no longer read credentials from `env`:
  `EMT_ACCOUNT_CONTEXT`, `EMT_SESSION_ID`, `scopedEnvironment` and the exported
  `getToken` go away. The Account travels explicitly.
- One token cache keyed by session; the shared login is the session `shared`.
  KV keys stay `emt:token` and `emt:user:<id>` so a deploy forces no re-login.
  Two behaviours that differ today stay, as options rather than code paths: the
  shared token's 60-second KV re-read window, and reporting a rejected user
  password as `emt_account`.
- Out of scope: MPass/EMTPay (`bicimad-account.js`) is a different system with
  different credentials, and account rotation in `StopPoller`/`LiveStop` is
  left as is (they only swap a scoped env for a client).

## Hub planner

- `journey-planner.js` gains `plan({ origin, destinations }, { sources, tier,
  now })`, returning the payload `/journeys` returns today. It owns the night
  window (Madrid time, derived from `now`), both access and transfer radii,
  `PLANNER_BUDGETS`, the walking gate, route rationing, the per-read
  deadlines, transfer verification, incidents, ranking and input validation
  (`bad_request`, 400, replacing the old `not_found`).
- **Planner sources** is the seam: one object with five reads (nearby stops,
  board, route, incidents, walking matrix). The production adapter,
  `plannerSources(requestUrl, emt, env, ctx)`, stays in `index.js` with the
  map-grid nearby sharing and its `gridCells` cap, because index.js holds every
  edge-cache decision. Tests pass an in-memory adapter and a fixed `now`.
- The router only authenticates, builds the adapter, calls `plan()` and
  serialises.
- The scoring functions stay exported for their existing tests; new tests go
  through `plan()`.

## Considered options

- **Deadlines in the adapter.** Rejected: "dropping a stop beats waiting" is a
  planning decision, and putting it behind the seam would hide it from the
  tests that need to exercise it.
- **Sharing `nextDeparture` with the page now.** Deferred: Pages deploys only
  `web/`, so the page cannot import a worker file. `firstLegTimes` in `app.js`
  stays a deliberate copy, with named constants and a pointer to the planner,
  until a page/worker shared file exists.
- **Merging StopPoller and LiveStop account rotation** in the same change.
  Deferred to its own change, to keep the EMT client PR mechanical.
