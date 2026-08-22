-- Run once in the Supabase SQL editor.
-- No policies: RLS on with zero policies means only the service-role key
-- can read or write this table. The worker holds that key; the page never
-- talks to Supabase directly.
create table if not exists bus_stops (
  id uuid primary key default gen_random_uuid(),
  stop_id text not null check (stop_id ~ '^[0-9]+$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists bus_stops_stop_id_key on bus_stops (stop_id);

alter table bus_stops enable row level security;
