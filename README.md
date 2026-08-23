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

Design: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`

Bus data from [EMT MobilityLabs](https://mobilitylabs.emtmadrid.es).
