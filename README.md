# EMT Madrid Arrivals

Live EMT Madrid bus arrival times for a handful of saved stops. A webpage,
opened from a phone home screen.

**The repo is named `emt_madrid_widget` and there is no widget.** This started
as an Android home screen widget and became a webpage; the name was kept to
avoid churn.

- `web/` — static page, deployed to GitHub Pages. Holds no secrets.
- `api/` — Cloudflare Worker. Holds EMT credentials and the Supabase service key.
- `supabase/` — per-user table definitions and RLS migration.

Users sign in with a Supabase email magic link. Supabase Auth owns credentials;
the Worker forwards each JWT to PostgREST and RLS isolates saved stops and bike
stations by user. Public transport responses remain shared and cached.

The optional owner-only BiciMAD account badge reads only a normalized
enabled/blocked summary. Its MPass password and integrator values are Worker
secrets and are used only to renew the owner's short-lived token on demand.

## Multi-user setup

1. In Supabase Auth, enable email magic links and new-user sign-ups, then set
   the site/redirect URL to
   `https://snowu.github.io/emt_madrid_widget/`. Add the same URL under
   **Redirect URLs** (a trailing `**` is fine). Configure custom SMTP under
   **Authentication → Email → SMTP Settings**; the same verified email-link
   flow handles first-time sign-up and returning sign-in.
2. Sign in the owner first and copy their Auth user UUID.
3. Replace every `OWNER_AUTH_USER_ID` in
   `supabase/migrate_multi_user.sql` with that UUID, then run the script in the
   Supabase SQL editor. It assigns existing saved rows to the owner and installs
   per-user RLS policies without deleting data.
4. Set Worker secrets with `wrangler secret put` for `SUPABASE_URL`,
   `SUPABASE_ANON_KEY`, and `OWNER_USER_ID`. For the owner-only account check,
   also set `MPASS_CLIENT_ID`, `MPASS_PASSKEY`, and `MPASS_DEVICE_ID`. MPass
   reuses `EMT_EMAIL` and `EMT_PASSWORD`; optional `MPASS_EMAIL` and
   `MPASS_PASSWORD` overrides remain available if the accounts ever differ.
5. Deploy the Worker, then deploy `web/`. Friends can create their own verified
   accounts; each receives an isolated empty set of saved stops and stations.

The legacy `SUPABASE_SERVICE_KEY` and public `APP_KEY` are no longer used for
normal application traffic and can be removed after the migration is verified.

## EMT usage metrics

The Worker records exact EMT HTTP attempts plus edge-cache hits/misses in the
`hubwise_emt_metrics` Analytics Engine dataset. It never records tokens, email,
coordinates, or response bodies.

Create one Cloudflare API token with only **Account Analytics: Read**, then:

```bash
cd api
npx wrangler secret put CLOUDFLARE_ANALYTICS_TOKEN
cp ../.env.metrics.example ../.env.metrics
# Put the same read-only token in .env.metrics for local reports.
npm run metrics
npm run metrics -- --days 7
```

The Hubwise account menu also exposes the same report to the owner. Analytics
Engine retains three months; no KV operations are consumed.

Design: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`

Bus data from [EMT MobilityLabs](https://mobilitylabs.emtmadrid.es).

## Background arrival and bike alerts

Open a bus stop and tap **Track** beside a line, or open a bike station and tap
**Track**. Allow browser notifications when prompted. **Account → Tracked
alerts** lists active watches and lets you stop them or enable another device.
Watches are shared across your signed-in devices; signing out disconnects that
browser's notifications. Up to 20 watches and five devices are supported per user.

- Buses are checked every two minutes. Each newly observed bus at **900 seconds
  or less** triggers an alert, including a first check already below the threshold.
  A vehicle is remembered through brief omissions and ETA corrections, and can
  notify again after 30 minutes outside the alert window (a later circuit).
- Bike stations are checked every 30 seconds, using rentable bikes from GBFS.
  Zero bikes arms alerts. Increases to 1–4 bikes notify; more than four silences
  alerts until the rack reaches zero again. Initial nonzero counts do not arm
  alerts. Polling detects net count increases; returns and rentals between checks
  can cancel each other out. Stale feeds and missing counts never become zero.
- Checks run in a persistent Cloudflare Durable Object per user, even when the
  page is closed. Alarm scheduling and push delivery are best effort, not exact
  wall-clock guarantees. A push expires after two minutes to avoid late alerts.
  Failed checks retry; expired push subscriptions are removed. No active devices
  pauses the runner without deleting its watches.

On iOS/iPadOS, open the app from its Home Screen installation to enable Web Push.
The service worker handles notifications only; it does not cache pages or data.

One-time push setup (preserve the same key pair on subsequent deployments):

```bash
mkdir -p .local
node tools/generate-push-keys.mjs .local/push-secrets.json
cd api
npx wrangler secret bulk ../.local/push-secrets.json
npx wrangler deploy
```

Deploy `web/` through the existing Pages workflow. The `tracking-v1` migration
creates the SQLite-backed `TrackingRunner`; existing KV and scheduled jobs remain
in place. Never commit or rotate the private key file casually: existing browser
subscriptions are tied to the public key. For local development, add the three
`VAPID_*` fields to the ignored `api/.dev.vars` file.

Validation: `npm --prefix api test`, `node --test test/*.test.mjs`, and
`cd api && npx wrangler deploy --dry-run`. Tracking tests exercise threshold
crossings, bike re-arming, encrypted push construction, durable alarms, retries,
expired subscriptions, authentication, user isolation, and cancellation races.
