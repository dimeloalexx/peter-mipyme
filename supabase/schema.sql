-- Peter Mipyme cloud sync schema.
-- One row per business (products + current day), plus one row per daily closing,
-- so the growing history is never re-uploaded as a whole.
-- Every row belongs to the logged-in account (owner) and RLS keeps accounts apart.

create table if not exists public.businesses (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  id text not null,
  name text not null default '',
  data jsonb not null,
  rev bigint not null default 1,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (owner, id)
);

create sequence if not exists public.closes_seq;

create table if not exists public.closes (
  owner uuid not null default auth.uid() references auth.users (id) on delete cascade,
  business_id text not null,
  id text not null,
  data jsonb not null,
  deleted boolean not null default false,
  seq bigint not null default nextval('public.closes_seq'),
  created_at timestamptz not null default now(),
  primary key (owner, business_id, id)
);

create index if not exists closes_owner_seq_idx on public.closes (owner, seq);

-- Any change to a closing (e.g. marking it deleted) moves it to the end of the feed,
-- so other phones pick it up with a simple "seq > last seen" query.
create or replace function public.closes_bump_seq()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.seq := nextval('public.closes_seq');
  return new;
end;
$$;

drop trigger if exists closes_bump_seq on public.closes;
create trigger closes_bump_seq
  before update on public.closes
  for each row execute function public.closes_bump_seq();

alter table public.businesses enable row level security;
alter table public.closes enable row level security;

drop policy if exists "Own businesses" on public.businesses;
create policy "Own businesses" on public.businesses
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

drop policy if exists "Own closes" on public.closes;
create policy "Own closes" on public.closes
  for all to authenticated
  using (owner = (select auth.uid()))
  with check (owner = (select auth.uid()));

revoke all on public.businesses, public.closes from anon;
grant select, insert, update, delete on public.businesses, public.closes to authenticated;
grant usage on sequence public.closes_seq to authenticated;
