-- Age of Colony — first Supabase persistence schema.
--
-- Run this in the existing WorldColony Supabase SQL editor.
-- The backend writes through SUPABASE_SERVICE_ROLE_KEY; the browser continues
-- to talk only to the FastAPI service.

create extension if not exists pgcrypto;

create table if not exists public.aoc_games (
  id             uuid primary key default gen_random_uuid(),
  game_id        text not null unique,
  fixture_id     text not null,
  participant1   text,
  participant2   text,
  owner_anonymous_id text,
  owner_wallet  text,
  owner_name     text,
  status         text not null default 'created',
  mode           text,
  seed           bigint,
  event_index    integer not null default 0,
  public_state   jsonb not null default '{}'::jsonb,
  agent_usage    jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,

  constraint aoc_games_public_state_is_object_check
    check (jsonb_typeof(public_state) = 'object'),
  constraint aoc_games_agent_usage_is_object_check
    check (agent_usage is null or jsonb_typeof(agent_usage) = 'object')
);

create index if not exists aoc_games_updated_at_idx
  on public.aoc_games (updated_at desc);

alter table public.aoc_games
  add column if not exists owner_anonymous_id text,
  add column if not exists owner_wallet text,
  add column if not exists owner_name text;

create index if not exists aoc_games_fixture_idx
  on public.aoc_games (fixture_id);

create index if not exists aoc_games_owner_anonymous_idx
  on public.aoc_games (owner_anonymous_id, updated_at desc);

create index if not exists aoc_games_owner_wallet_idx
  on public.aoc_games (owner_wallet, updated_at desc);

create index if not exists aoc_games_status_idx
  on public.aoc_games (status);

create or replace function public.aoc_games_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists aoc_games_touch_updated_at on public.aoc_games;
create trigger aoc_games_touch_updated_at
  before update on public.aoc_games
  for each row execute function public.aoc_games_touch_updated_at();

create table if not exists public.aoc_game_events (
  id              uuid primary key default gen_random_uuid(),
  game_id         text not null references public.aoc_games(game_id) on delete cascade,
  event_index     integer not null,
  kind            text not null,
  message         text not null,
  data            jsonb not null default '{}'::jsonb,
  created_at_unix double precision,
  created_at      timestamptz not null default now(),

  constraint aoc_game_events_unique
    unique (game_id, event_index),
  constraint aoc_game_events_data_is_object_check
    check (jsonb_typeof(data) = 'object')
);

create index if not exists aoc_game_events_game_idx
  on public.aoc_game_events (game_id, event_index asc);

create index if not exists aoc_game_events_kind_idx
  on public.aoc_game_events (kind);

alter table public.aoc_games enable row level security;
alter table public.aoc_game_events enable row level security;

-- No public write policies are required for V0. The FastAPI backend writes with
-- the service role key, and the frontend reads through backend endpoints.

-- ---------------------------------------------------------------------
-- aoc_queens: the player's royal profile. wallet is the PRIMARY KEY, so
-- the database itself enforces exactly one queen per wallet — upserts
-- amend her, they can never create a second.
-- ---------------------------------------------------------------------
create table if not exists public.aoc_queens (
  wallet      text primary key,
  name        text not null,
  motto       text not null default '',
  emblem      text not null default '👑',
  crowned_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint aoc_queens_name_length_check check (char_length(name) between 1 and 24),
  constraint aoc_queens_motto_length_check check (char_length(motto) <= 48)
);

create or replace function public.aoc_queens_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  new.crowned_at = old.crowned_at;  -- coronation date is immutable
  return new;
end;
$$;

drop trigger if exists aoc_queens_touch_updated_at on public.aoc_queens;
create trigger aoc_queens_touch_updated_at
  before update on public.aoc_queens
  for each row execute function public.aoc_queens_touch_updated_at();
