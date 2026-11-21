-- =====================================================================
-- Pickup Sports Tampa — 001: tables, indexes, stats views
-- Implements docs/database-contract-v2.md.
-- Run in the Supabase SQL Editor in order: 001, 002, 003, 004 (then seed.sql).
-- =====================================================================

-- ---------- Reference data ----------
create table public.neighborhoods (
  slug text primary key,
  name text not null unique,
  lat  double precision not null,     -- approximate center point, never an address
  lng  double precision not null
);

create table public.sports (
  slug        text primary key,
  name        text not null unique,
  stat_fields text[] not null default '{}'   -- per-player stats this sport tracks
);

-- ---------- Profiles ----------
-- Created only by save_profile(); onboarding is gated on this row existing.
create table public.profiles (
  id                  uuid primary key references auth.users (id) on delete cascade,
  display_name        text not null check (display_name = btrim(display_name) and char_length(display_name) between 1 and 60),
  neighborhood        text not null references public.neighborhoods (slug),
  travel_radius_miles smallint not null check (travel_radius_miles between 1 and 50),
  bio                 text not null default '' check (char_length(bio) <= 300),
  created_at          timestamptz not null default now()
);
create index profiles_neighborhood_idx on public.profiles (neighborhood, display_name, id);

create table public.user_sports (
  user_id     uuid not null references public.profiles (id) on delete cascade,
  sport_slug  text not null references public.sports (slug),
  skill_level text not null check (skill_level in ('beginner', 'intermediate', 'advanced')),
  primary key (user_id, sport_slug)
);
create index user_sports_sport_idx on public.user_sports (sport_slug, user_id);

-- ---------- Games ----------
create table public.games (
  id           uuid primary key default gen_random_uuid(),
  organizer_id uuid not null references public.profiles (id) on delete cascade,
  sport_slug   text not null references public.sports (slug),
  title        text not null check (char_length(btrim(title)) between 1 and 80),
  venue        text not null check (char_length(btrim(venue)) between 1 and 100),
  neighborhood text not null references public.neighborhoods (slug),
  starts_at    timestamptz not null,
  max_players  smallint not null check (max_players between 2 and 50),
  status       text not null default 'scheduled' check (status in ('scheduled', 'cancelled', 'completed')),
  created_at   timestamptz not null default now()
);
create index games_organizer_idx    on public.games (organizer_id, starts_at);
create index games_neighborhood_idx on public.games (neighborhood, starts_at);

create table public.game_players (
  game_id   uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  team      text check (team in ('A', 'B')),
  joined_at timestamptz not null default now(),
  primary key (game_id, player_id)
);
create index game_players_player_idx on public.game_players (player_id, game_id);

create table public.invitations (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games (id) on delete cascade,
  sender_id    uuid not null references public.profiles (id) on delete cascade,
  recipient_id uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (sender_id <> recipient_id)
);
-- One *pending* invitation per recipient per game; re-inviting after cancel/expire is allowed.
create unique index invitations_one_pending_idx on public.invitations (game_id, recipient_id) where status = 'pending';
create index invitations_recipient_idx on public.invitations (recipient_id, status);

-- ---------- Results & stats ----------
-- One result per game. Re-submitting overwrites it (revision + 1) and resets to
-- 'pending', so stats (computed from 'final' only) never double-count.
create table public.game_results (
  game_id        uuid primary key references public.games (id) on delete cascade,
  team_a_score   smallint not null check (team_a_score between 0 and 999),
  team_b_score   smallint not null check (team_b_score between 0 and 999),
  status         text not null default 'pending' check (status in ('pending', 'final', 'disputed')),
  submitted_by   uuid not null references public.profiles (id),
  submitted_at   timestamptz not null default now(),
  confirmed_by   uuid references public.profiles (id),
  confirmed_at   timestamptz,
  dispute_reason text,
  revision       smallint not null default 1
);

create table public.player_game_stats (
  game_id   uuid not null references public.game_results (game_id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  team      text not null check (team in ('A', 'B')),
  outcome   text not null check (outcome in ('win', 'loss', 'draw')),
  goals     smallint not null default 0 check (goals >= 0),
  assists   smallint not null default 0 check (assists >= 0),
  points    smallint not null default 0 check (points >= 0),
  primary key (game_id, player_id)
);
create index player_game_stats_player_idx on public.player_game_stats (player_id);

-- ---------- Reviews ----------
create table public.reviews (
  id          uuid primary key default gen_random_uuid(),
  game_id     uuid not null references public.games (id) on delete cascade,
  reviewer_id uuid not null references public.profiles (id) on delete cascade,
  reviewee_id uuid not null references public.profiles (id) on delete cascade,
  rating      smallint not null check (rating between 1 and 5),
  comment     text not null default '' check (char_length(comment) <= 500),
  created_at  timestamptz not null default now(),
  unique (game_id, reviewer_id, reviewee_id),
  check (reviewer_id <> reviewee_id)
);
create index reviews_reviewee_idx on public.reviews (reviewee_id);

-- ---------- Stats views ----------
-- These expose only public aggregates, so they run as the view owner: a
-- player's totals are the same for every viewer.
create view public.player_sport_stats as
select s.player_id,
       g.sport_slug,
       count(*)::int                                  as games_played,
       (count(*) filter (where s.outcome = 'win'))::int  as wins,
       (count(*) filter (where s.outcome = 'loss'))::int as losses,
       (count(*) filter (where s.outcome = 'draw'))::int as draws,
       coalesce(sum(s.goals), 0)::int                 as goals,
       coalesce(sum(s.assists), 0)::int               as assists,
       coalesce(sum(s.points), 0)::int                as points
from public.player_game_stats s
join public.game_results r on r.game_id = s.game_id and r.status = 'final'
join public.games g        on g.id = s.game_id
group by s.player_id, g.sport_slug;

create view public.player_stats as
select player_id,
       sum(games_played)::int as games_played,
       sum(wins)::int    as wins,
       sum(losses)::int  as losses,
       sum(draws)::int   as draws,
       sum(goals)::int   as goals,
       sum(assists)::int as assists,
       sum(points)::int  as points
from public.player_sport_stats
group by player_id;

create view public.player_ratings as
select reviewee_id as player_id,
       round(avg(rating)::numeric, 2) as avg_rating,
       count(*)::int                   as review_count
from public.reviews
group by reviewee_id;
