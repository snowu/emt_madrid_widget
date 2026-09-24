# Per-user EMT accounts

Ported onto `main` from `feat/per-user-emt-accounts` (2026-09-20). Supabase
email-link sign-in stays the app identity; a user may additionally connect
their own EMT email and password so EMT calls made for them spend their own
MobilityLabs quota instead of the shared login's.

## How it behaves

- **Optional, with a fallback.** Guests, users who never connected, expired
  app sessions and an unreachable account store all use the shared EMT login,
  exactly as before. (The original branch failed closed instead, which would
  have broken live times for everyone without a connection and every
  timer-driven tracking check.)
- **A connection that exists is always used.** If EMT rejects it (password
  changed), requests fail with `emt_account` (403) and the page asks the user
  to reconnect. Quota exhaustion keeps its own `quota` error. Neither falls
  back to the shared login, so a user's quota and the shared one never mix
  silently.
- **Tracking uses it too.** Tracking checks run on a timer with no signed-in
  caller, so the user's `TrackingRunner` keeps its own copy of the ciphertext
  (never plaintext), handed over whenever the page reads or changes the
  connection (`GET/PUT/DELETE /auth/emt`) and written only when the connection
  id changed. The runner passes it to the `StopPoller` of each stop it
  watches; a stop's poller rotates between its connected watchers' accounts,
  one per 2-minute poll, and falls back to the shared login when none is
  connected or the chosen one fails.
- **Public data stays shared.** Completed Cache API payloads are shared by
  everyone, whichever account fetched them. A cache miss that another request
  is already loading is still coalesced, so its cost lands on whoever asked
  first — the data is public, so that is a fairness detail, not a leak.
- **BiciMAD account status and trip history remain owner-only.** Opening them
  to connected users is a separate change: it exposes private account data.

## Storage and isolation

- Credentials are AES-256-GCM encrypted with a fresh nonce, with the app user
  id as associated data, using the `EMT_CREDENTIAL_KEY` Worker secret.
- `emt_accounts` (`supabase/emt-accounts.sql`) is read and written through
  PostgREST with the caller's own JWT, so RLS is the tenant boundary.
- Per-user EMT tokens live in KV under `emt:user:<user>:<connection>` and in
  isolate memory keyed the same way; never under the shared `emt:token`.
- `GET /auth/emt` returns connection state, email and connection id only.
  `PUT` logs in with the new credentials before replacing a working
  connection. Every response is `no-store`.

## Deploying

1. Run `supabase/emt-accounts.sql` once in the Supabase SQL editor. Check RLS
   with two users: neither may read or change the other's row.
2. `openssl rand -base64 32 | npx wrangler secret put EMT_CREDENTIAL_KEY`
   (from `api/`). Keep a backup: losing it only means users reconnect.
3. Deploy the worker (`npm run deploy`), then merge for the page.
4. Connect your own account from the account menu and check live times still
   load; `npm run metrics` should show calls moving off the shared login.

Until steps 1–2 are done, nothing changes: without the key the worker never
looks up connections, and the dialog reports that storage is not configured.
