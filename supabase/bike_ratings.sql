create table if not exists public.bike_ratings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  bike_number text not null check (bike_number ~ '^[0-9]+$'),
  rating smallint not null check (rating between 1 and 5),
  updated_at timestamptz not null default now(),
  unique (user_id, bike_number)
);

alter table public.bike_ratings enable row level security;

create policy "Users can read their bike ratings" on public.bike_ratings
  for select using (auth.uid() = user_id);
create policy "Users can create their bike ratings" on public.bike_ratings
  for insert with check (auth.uid() = user_id);
create policy "Users can update their bike ratings" on public.bike_ratings
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete their bike ratings" on public.bike_ratings
  for delete using (auth.uid() = user_id);

grant select, insert, update, delete on public.bike_ratings to authenticated;
