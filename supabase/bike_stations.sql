-- Run once in the Supabase SQL editor, alongside bus_stops.sql.
create table if not exists bike_stations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  station_id text not null check (station_id ~ '^[0-9]+$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists bike_stations_user_station_key
  on bike_stations (user_id, station_id);
create index if not exists bike_stations_user_id_idx on bike_stations (user_id);

alter table bike_stations enable row level security;

create policy "Users read own bike stations" on bike_stations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own bike stations" on bike_stations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own bike stations" on bike_stations for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own bike stations" on bike_stations for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on bike_stations to authenticated;
