# EMT Madrid Arrivals

Live EMT Madrid bus arrival times for a handful of saved stops. A webpage,
opened from a phone home screen.

**The repo is named `emt_madrid_widget` and there is no widget.** This started
as an Android home screen widget and became a webpage; the name was kept to
avoid churn.

- `web/` — static page, deployed to GitHub Pages. Holds no secrets.
- `api/` — Cloudflare Worker. Holds EMT credentials and the Supabase service key.
- `supabase/` — table definition.

Design: `docs/superpowers/specs/2026-08-18-emt-madrid-web-design.md`

Bus data from [EMT MobilityLabs](https://mobilitylabs.emtmadrid.es).
