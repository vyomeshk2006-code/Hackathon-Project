-- =====================================================================
-- Pickup Sports Tampa — 005: v3 tables, columns, views
-- Implements docs/database-contract-v3-proposal.md (approved).
-- Run after 001–004. Order: 005 → 006 → 007 (then seed.sql on a fresh project).
-- =====================================================================

-- ---------- Helpers used by constraints ----------
-- A non-empty set of valid skill levels with no duplicates.
create function private.valid_skill_levels(p_levels text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_levels is null or (
    cardinality(p_levels) between 1 and 3
    and p_levels <@ array['beginner', 'intermediate', 'advanced']
    and cardinality(p_levels) = (select count(distinct l) from unnest(p_levels) l)
  )
$$;

-- ---------- Changed tables ----------
alter table public.profiles
  add column replacement_alerts boolean not null default true,
  add column new_game_alerts    boolean not null default false;

alter table public.games
  add column join_mode    text not null default 'invite_only' check (join_mode in ('open', 'invite_only')),
  add column skill_levels text[] check (private.valid_skill_levels(skill_levels)),
  add column team_size    smallint check (team_size between 1 and 25),
  add constraint games_team_size_matches_max check (team_size is null or max_players = 2 * team_size);

alter table public.user_sports
  add column level_source text not null default 'self' check (level_source in ('self', 'verified')),
  add column rating_count smallint not null default 0;

-- reviews.rating now means SPORTSMANSHIP; skill_rating drives levels.
alter table public.reviews
  add column skill_rating smallint check (skill_rating between 1 and 5),
  add column sport_slug   text references public.sports (slug);
update public.reviews r set sport_slug = g.sport_slug from public.games g where g.id = r.game_id;
alter table public.reviews alter column sport_slug set not null;
create index reviews_reviewee_sport_idx on public.reviews (reviewee_id, sport_slug);

-- ---------- Squads ----------
create table public.squads (
  id         uuid primary key default gen_random_uuid(),
  name       text not null check (char_length(btrim(name)) between 1 and 40),
  sport_slug text not null references public.sports (slug),
  captain_id uuid not null references public.profiles (id) on delete cascade,
  join_code  text not null unique,
  created_at timestamptz not null default now()
);

create table public.squad_members (
  squad_id  uuid not null references public.squads (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (squad_id, player_id)
);
create index squad_members_player_idx on public.squad_members (player_id);

alter table public.invitations
  add column team     text check (team in ('A', 'B')),
  add column squad_id uuid references public.squads (id) on delete set null;

-- ---------- Join requests (invite-only games) ----------
create table public.join_requests (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending', 'approved', 'declined', 'cancelled')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz
);
create unique index join_requests_one_pending_idx on public.join_requests (game_id, player_id) where status = 'pending';
create index join_requests_player_idx on public.join_requests (player_id);

-- ---------- Withdrawals & emergency replacement (internal) ----------
create table public.game_withdrawals (
  id           uuid primary key default gen_random_uuid(),
  game_id      uuid not null references public.games (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  team         text check (team in ('A', 'B')),
  withdrawn_at timestamptz not null default now(),
  last_minute  boolean not null
);
create index game_withdrawals_game_player_idx on public.game_withdrawals (game_id, player_id);

create table public.replacement_alerts (
  id            uuid primary key default gen_random_uuid(),
  game_id       uuid not null references public.games (id) on delete cascade,
  withdrawal_id uuid not null unique references public.game_withdrawals (id) on delete cascade,
  open_team     text check (open_team in ('A', 'B')),
  created_at    timestamptz not null default now()
);

create table public.replacement_alert_recipients (
  alert_id  uuid not null references public.replacement_alerts (id) on delete cascade,
  game_id   uuid not null references public.games (id) on delete cascade,
  player_id uuid not null references public.profiles (id) on delete cascade,
  unique (game_id, player_id)                     -- alerted at most once per game
);

-- ---------- Notifications ----------
create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  type            text not null,
  title           text not null,
  body            text not null default '',
  game_id         uuid references public.games (id) on delete cascade,
  invitation_id   uuid references public.invitations (id) on delete set null,
  join_request_id uuid references public.join_requests (id) on delete set null,
  data            jsonb not null default '{}',
  read_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ---------- Game chat ----------
create table public.game_messages (
  id         uuid primary key default gen_random_uuid(),
  game_id    uuid not null references public.games (id) on delete cascade,
  sender_id  uuid not null references public.profiles (id) on delete cascade,
  body       text not null check (body = btrim(body) and char_length(body) between 1 and 1000),
  created_at timestamptz not null default now()
);
create index game_messages_game_idx on public.game_messages (game_id, created_at);

create table public.game_chat_reads (
  game_id      uuid not null references public.games (id) on delete cascade,
  player_id    uuid not null references public.profiles (id) on delete cascade,
  last_read_at timestamptz not null,
  primary key (game_id, player_id)
);

-- ---------- Hidden level scores ----------
create table private.skill_scores (
  player_id    uuid not null references public.profiles (id) on delete cascade,
  sport_slug   text not null references public.sports (slug),
  start_score  numeric(3,2) not null,              -- from the self-chosen level
  score        numeric(3,2) not null,              -- current blended score, 1.00–5.00
  level        text not null check (level in ('beginner', 'intermediate', 'advanced')),
  verified     boolean not null default false,     -- survives removing/re-adding the sport
  rating_count smallint not null default 0,
  updated_at   timestamptz not null default now(),
  primary key (player_id, sport_slug)
);

-- ---------- Views ----------
-- Anonymous reviews: no reviewer, game, or date. Runs as owner so anyone can read it.
create view public.public_reviews as
select r.id, r.reviewee_id, r.sport_slug, r.rating, r.skill_rating, r.comment
from public.reviews r;

-- The caller's chat "new messages" dot, one row per game they're on.
create view public.my_game_chat_status with (security_invoker = true) as
select gp.game_id,
       m.last_message_at,
       cr.last_read_at,
       coalesce(m.last_message_at > coalesce(cr.last_read_at, '-infinity'::timestamptz), false) as has_new
from public.game_players gp
left join lateral (select max(gm.created_at) as last_message_at
                   from public.game_messages gm where gm.game_id = gp.game_id) m on true
left join public.game_chat_reads cr on cr.game_id = gp.game_id and cr.player_id = gp.player_id
where gp.player_id = auth.uid();

-- The caller's squads, including the join code (hidden from non-members).
create view public.my_squads as
select s.id, s.name, s.sport_slug, s.captain_id, s.join_code,
       (select count(*) from public.squad_members m where m.squad_id = s.id)::int as member_count,
       s.captain_id = auth.uid() as is_captain
from public.squads s
where exists (select 1 from public.squad_members m where m.squad_id = s.id and m.player_id = auth.uid());

-- How many games the caller can still create today (America/New_York).
create view public.my_game_quota as
select count(g.id)::int                as games_created_today,
       greatest(0, 2 - count(g.id))::int as games_left_today,
       (((now() at time zone 'America/New_York')::date + 1)::timestamp at time zone 'America/New_York') as resets_at
from (select auth.uid() as uid) me
left join public.games g
  on g.organizer_id = me.uid
 and (g.created_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date
where me.uid is not null;
