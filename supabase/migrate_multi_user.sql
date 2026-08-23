-- Run this once for an existing installation, after creating your own user in
-- Supabase Auth. Replace 99287d55-dbc6-48c1-af06-8b4558bc1d51 below with that user's UUID.
-- The transaction deliberately fails if the placeholder was not replaced.
begin;

do $$
begin
  if '99287d55-dbc6-48c1-af06-8b4558bc1d51' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'Replace 99287d55-dbc6-48c1-af06-8b4558bc1d51 with the owner Supabase Auth UUID first';
  end if;
end $$;

alter table bus_stops add column if not exists user_id uuid references auth.users(id) on delete cascade;
alter table bike_stations add column if not exists user_id uuid references auth.users(id) on delete cascade;

update bus_stops set user_id = '99287d55-dbc6-48c1-af06-8b4558bc1d51'::uuid where user_id is null;
update bike_stations set user_id = '99287d55-dbc6-48c1-af06-8b4558bc1d51'::uuid where user_id is null;

alter table bus_stops alter column user_id set default auth.uid();
alter table bus_stops alter column user_id set not null;
alter table bike_stations alter column user_id set default auth.uid();
alter table bike_stations alter column user_id set not null;

drop index if exists bus_stops_stop_id_key;
drop index if exists bike_stations_station_id_key;
create unique index if not exists bus_stops_user_stop_key on bus_stops (user_id, stop_id);
create unique index if not exists bike_stations_user_station_key on bike_stations (user_id, station_id);
create index if not exists bus_stops_user_id_idx on bus_stops (user_id);
create index if not exists bike_stations_user_id_idx on bike_stations (user_id);

drop policy if exists "Users read own bus stops" on bus_stops;
drop policy if exists "Users add own bus stops" on bus_stops;
drop policy if exists "Users update own bus stops" on bus_stops;
drop policy if exists "Users delete own bus stops" on bus_stops;
create policy "Users read own bus stops" on bus_stops for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own bus stops" on bus_stops for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own bus stops" on bus_stops for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own bus stops" on bus_stops for delete to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users read own bike stations" on bike_stations;
drop policy if exists "Users add own bike stations" on bike_stations;
drop policy if exists "Users update own bike stations" on bike_stations;
drop policy if exists "Users delete own bike stations" on bike_stations;
create policy "Users read own bike stations" on bike_stations for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own bike stations" on bike_stations for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own bike stations" on bike_stations for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own bike stations" on bike_stations for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on bus_stops, bike_stations to authenticated;
commit;
