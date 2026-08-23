-- Run once in the Supabase SQL editor, alongside bus_stops.sql.
-- Same shape and same rule: RLS on with zero policies, so only the
-- service-role key the worker holds can read or write it.
create table if not exists bike_stations (
  id uuid primary key default gen_random_uuid(),
  station_id text not null check (station_id ~ '^[0-9]+$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists bike_stations_station_id_key
  on bike_stations (station_id);

alter table bike_stations enable row level security;
