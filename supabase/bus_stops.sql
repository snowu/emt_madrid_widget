-- Run once in the Supabase SQL editor.
create table if not exists bus_stops (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  stop_id text not null check (stop_id ~ '^[0-9]+$'),
  label text,
  enabled boolean not null default true,
  created_at timestamptz not null default now()
);

create unique index if not exists bus_stops_user_stop_key on bus_stops (user_id, stop_id);
create index if not exists bus_stops_user_id_idx on bus_stops (user_id);

alter table bus_stops enable row level security;

create policy "Users read own bus stops" on bus_stops for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users add own bus stops" on bus_stops for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users update own bus stops" on bus_stops for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "Users delete own bus stops" on bus_stops for delete to authenticated
  using ((select auth.uid()) = user_id);

grant select, insert, update, delete on bus_stops to authenticated;
