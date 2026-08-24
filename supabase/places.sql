-- Actual destinations (home, work, park), deliberately independent of EMT stops.
create table if not exists public.places (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 80),
  lat double precision not null check (lat between -90 and 90),
  lon double precision not null check (lon between -180 and 180),
  geofence_radius_m integer not null default 200 check (geofence_radius_m between 50 and 1500),
  destination_radius_m integer not null default 500 check (destination_radius_m between 50 and 1500),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists places_user_id_idx on public.places (user_id);
alter table public.places enable row level security;

drop policy if exists "Users read own places" on public.places;
drop policy if exists "Users add own places" on public.places;
drop policy if exists "Users update own places" on public.places;
drop policy if exists "Users delete own places" on public.places;
create policy "Users read own places" on public.places for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own places" on public.places for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own places" on public.places for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own places" on public.places for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on public.places to authenticated;
