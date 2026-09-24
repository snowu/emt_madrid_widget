-- Only ciphertext is stored. EMT_CREDENTIAL_KEY lives in Worker secrets.
create table if not exists public.emt_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  connection_id uuid not null,
  credentials jsonb not null check (octet_length(credentials::text) <= 8192)
);
alter table public.emt_accounts enable row level security;
drop policy if exists "Users manage own EMT connection" on public.emt_accounts;
create policy "Users manage own EMT connection" on public.emt_accounts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
revoke all on public.emt_accounts from anon;
grant select, insert, update, delete on public.emt_accounts to authenticated;
