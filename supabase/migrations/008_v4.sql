-- =====================================================================
-- Pickup Sports Tampa — 008: v4 (docs/database-contract-v4.md)
--   1. Discovery: every signed-in user can see all upcoming scheduled games
--   2. Extensible sports catalog + create_sport
--   3. Per-sport stat definitions; results take { player_id, metrics: {...} }
--   4. Game description; browse_games shows full games by default
-- Run after 001–007. On an existing v3 database this is the only file to run.
-- =====================================================================

-- ---------- Game description ----------
alter table public.games add column description text check (char_length(description) <= 500);

-- =====================================================================
-- Sports catalog
-- =====================================================================

-- Display form: NFKC, trimmed, whitespace collapsed.
create function private.clean_sport_name(p_name text) returns text
language sql immutable set search_path = '' as $$
  select regexp_replace(btrim(normalize(coalesce(p_name, ''), NFKC)), '\s+', ' ', 'g')
$$;

-- URL-friendly base slug: strip accents (NFKD + drop combining marks), non a-z0-9 runs → '-'.
create function private.sport_slug_base(p_name text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(regexp_replace(
           regexp_replace(lower(normalize(btrim(coalesce(p_name, '')), NFKD)), '[̀-ͯ]', '', 'g'),
           '[^a-z0-9]+', '-', 'g'), '-'), ''), 'sport')
$$;

alter table public.sports add column normalized_name text;
update public.sports s set normalized_name = lower(private.clean_sport_name(s.name));
alter table public.sports alter column normalized_name set not null;
alter table public.sports add constraint sports_normalized_name_key unique (normalized_name);

insert into public.sports (slug, name, normalized_name, stat_fields) values
  ('cricket',           'Cricket',           'cricket',           '{runs,wickets}'),
  ('tennis',            'Tennis',            'tennis',            '{sets_won}'),
  ('badminton',         'Badminton',         'badminton',         '{sets_won}'),
  ('american-football', 'American Football', 'american football', '{}'),
  ('baseball',          'Baseball',          'baseball',          '{}'),
  ('table-tennis',      'Table Tennis',      'table tennis',      '{}'),
  ('futsal',            'Futsal',            'futsal',            '{}'),
  ('handball',          'Handball',          'handball',          '{}'),
  ('ultimate-frisbee',  'Ultimate Frisbee',  'ultimate frisbee',  '{}')
on conflict (slug) do nothing;
update public.sports set stat_fields = '{points,rebounds,assists}' where slug = 'basketball';
update public.sports set stat_fields = '{points,aces,blocks}'      where slug = 'volleyball';

-- =====================================================================
-- Stat definitions + per-game values
-- =====================================================================
create table public.sport_stat_definitions (
  sport_slug   text not null references public.sports (slug) on delete cascade,
  stat_key     text not null check (stat_key ~ '^[a-z][a-z0-9_]{0,30}$'),
  display_name text not null,
  sort_order   smallint not null default 1,
  max_value    int not null default 32767 check (max_value between 1 and 32767),
  level_weight numeric(5,2) not null default 1 check (level_weight > 0),   -- weight in the level "contribution"
  primary key (sport_slug, stat_key)
);

insert into public.sport_stat_definitions (sport_slug, stat_key, display_name, sort_order, level_weight) values
  ('soccer',     'goals',    'Goals',    1, 1),
  ('soccer',     'assists',  'Assists',  2, 0.75),
  ('basketball', 'points',   'Points',   1, 1),
  ('basketball', 'rebounds', 'Rebounds', 2, 1),
  ('basketball', 'assists',  'Assists',  3, 1.5),
  ('cricket',    'runs',     'Runs',     1, 1),
  ('cricket',    'wickets',  'Wickets',  2, 20),
  ('volleyball', 'points',   'Points',   1, 1),
  ('volleyball', 'aces',     'Aces',     2, 1),
  ('volleyball', 'blocks',   'Blocks',   3, 1),
  ('tennis',     'sets_won', 'Sets won', 1, 1),
  ('badminton',  'sets_won', 'Sets won', 1, 1);

-- v2 columns stay (kept in sync for goals/assists/points); widen their limits to the metric range.
alter table public.player_game_stats
  drop constraint player_game_stats_goals_check,
  drop constraint player_game_stats_assists_check,
  drop constraint player_game_stats_points_check,
  add constraint player_game_stats_goals_check   check (goals   between 0 and 32767),
  add constraint player_game_stats_assists_check check (assists between 0 and 32767),
  add constraint player_game_stats_points_check  check (points  between 0 and 32767);

create table public.player_game_stat_values (
  game_id    uuid not null,
  player_id  uuid not null,
  sport_slug text not null,
  stat_key   text not null,
  value      int  not null check (value between 0 and 32767),
  primary key (game_id, player_id, stat_key),
  foreign key (game_id, player_id) references public.player_game_stats (game_id, player_id) on delete cascade,
  foreign key (sport_slug, stat_key) references public.sport_stat_definitions (sport_slug, stat_key)
);
create index player_game_stat_values_player_idx on public.player_game_stat_values (player_id, sport_slug);

-- Backfill existing results (v2/v3 goals/assists/points) into the new values table.
insert into public.player_game_stat_values (game_id, player_id, sport_slug, stat_key, value)
select s.game_id, s.player_id, g.sport_slug, d.stat_key,
       case d.stat_key when 'goals' then s.goals when 'assists' then s.assists when 'points' then s.points else 0 end
from public.player_game_stats s
join public.games g                   on g.id = s.game_id
join public.sport_stat_definitions d on d.sport_slug = g.sport_slug;

-- ---------- Views (public aggregates, FINAL results only) ----------
create or replace view public.player_sport_stats as
select s.player_id,
       g.sport_slug,
       count(*)::int                                     as games_played,
       (count(*) filter (where s.outcome = 'win'))::int  as wins,
       (count(*) filter (where s.outcome = 'loss'))::int as losses,
       (count(*) filter (where s.outcome = 'draw'))::int as draws,
       coalesce(sum(s.goals), 0)::int                    as goals,
       coalesce(sum(s.assists), 0)::int                  as assists,
       coalesce(sum(s.points), 0)::int                   as points,
       round(100.0 * count(*) filter (where s.outcome = 'win') / count(*), 1) as win_pct
from public.player_game_stats s
join public.game_results r on r.game_id = s.game_id and r.status = 'final'
join public.games g        on g.id = s.game_id
group by s.player_id, g.sport_slug;

create or replace view public.player_stats as
select player_id,
       sum(games_played)::int as games_played,
       sum(wins)::int    as wins,
       sum(losses)::int  as losses,
       sum(draws)::int   as draws,
       sum(goals)::int   as goals,
       sum(assists)::int as assists,
       sum(points)::int  as points,
       round(100.0 * sum(wins) / nullif(sum(games_played), 0), 1) as win_pct
from public.player_sport_stats
group by player_id;

create view public.player_sport_metric_totals as
select v.player_id, v.sport_slug, v.stat_key, d.display_name, d.sort_order, sum(v.value)::int as total
from public.player_game_stat_values v
join public.game_results r            on r.game_id = v.game_id and r.status = 'final'
join public.sport_stat_definitions d on d.sport_slug = v.sport_slug and d.stat_key = v.stat_key
group by v.player_id, v.sport_slug, v.stat_key, d.display_name, d.sort_order;

-- =====================================================================
-- Security
-- =====================================================================
revoke all on public.sport_stat_definitions, public.player_game_stat_values, public.player_sport_metric_totals
  from anon, authenticated;
grant select on public.sport_stat_definitions to anon, authenticated;
grant select on public.player_game_stat_values, public.player_sport_metric_totals to authenticated;

alter table public.sport_stat_definitions  enable row level security;
alter table public.player_game_stat_values enable row level security;
create policy "stat definitions: readable" on public.sport_stat_definitions for select to anon, authenticated using (true);
create policy "stat values: roster read" on public.player_game_stat_values for select to authenticated
  using (private.is_game_player(game_id));

-- Discovery: every signed-in user can see upcoming scheduled games (and their rosters).
-- Past, cancelled and completed games keep the v3 rules.
create or replace function private.can_view_game(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and ((g.status = 'scheduled' and g.starts_at > now())
           or g.organizer_id = auth.uid()
           or g.join_mode = 'open'
           or (g.skill_levels is not null and exists (
                 select 1 from public.user_sports us
                 where us.user_id = auth.uid() and us.sport_slug = g.sport_slug
                   and us.skill_level = any (g.skill_levels)))
           or exists (select 1 from public.game_players gp where gp.game_id = g.id and gp.player_id = auth.uid())
           or exists (select 1 from public.invitations i
                      where i.game_id = g.id and i.recipient_id = auth.uid() and i.status = 'pending')
           or exists (select 1 from public.replacement_alert_recipients rr
                      where rr.game_id = g.id and rr.player_id = auth.uid()))
  )
$$;

-- =====================================================================
-- Functions
-- =====================================================================

-- Add a sport (or get the existing one). Same name in any case/spacing → same sport.
create function public.create_sport(p_name text)
returns table (slug text, name text, created boolean)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_disp text := private.clean_sport_name(p_name);
  v_norm text;
  v_base text;
  v_slug text;
  v_n    int := 1;
  v_row  public.sports;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if char_length(v_disp) not between 2 and 40
     or v_disp !~ '^[[:alnum:]]'
     or v_disp ~ '[[:cntrl:]<>@#$%^*=~`|\\{}\[\];:"?_]' then
    raise exception 'VALIDATION';
  end if;
  v_norm := lower(v_disp);

  perform pg_advisory_xact_lock(hashtext('create_sport'));   -- serialize concurrent creates
  select * into v_row from public.sports s where s.normalized_name = v_norm;
  if found then
    return query select v_row.slug, v_row.name, false;
    return;
  end if;

  v_base := private.sport_slug_base(v_disp);
  v_slug := v_base;
  while exists (select 1 from public.sports s where s.slug = v_slug) loop
    v_n := v_n + 1;
    v_slug := v_base || '-' || v_n;
  end loop;

  insert into public.sports (slug, name, normalized_name, stat_fields) values (v_slug, v_disp, v_norm, '{}');
  return query select v_slug, v_disp, true;
end $$;

-- ---------- create_game: + description; new-game alerts for every game ----------
drop function public.create_game(text, text, text, text, timestamptz, smallint, text, text[], smallint);

create function public.create_game(
  p_sport_slug text, p_title text, p_venue text, p_neighborhood text, p_starts_at timestamptz, p_max_players smallint,
  p_join_mode text default 'invite_only', p_skill_levels text[] default null, p_team_size smallint default null,
  p_description text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_id    uuid;
  v_today int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid) then raise exception 'PROFILE_REQUIRED'; end if;

  if not exists (select 1 from public.sports s where s.slug = p_sport_slug)
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or char_length(btrim(coalesce(p_title, ''))) not between 1 and 80
     or char_length(btrim(coalesce(p_venue, ''))) not between 1 and 100
     or char_length(btrim(coalesce(p_description, ''))) > 500
     or p_max_players is null or p_max_players not between 2 and 50
     or p_starts_at is null or p_starts_at <= now()
     or p_join_mode is null or p_join_mode not in ('open', 'invite_only')
     or not private.valid_skill_levels(p_skill_levels)
     or (p_team_size is not null and (p_team_size not between 1 and 25 or p_max_players <> 2 * p_team_size)) then
    raise exception 'VALIDATION';
  end if;

  perform pg_advisory_xact_lock(hashtext('create_game:' || v_uid::text));
  select count(*) into v_today from public.games g
  where g.organizer_id = v_uid
    and (g.created_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date;
  if v_today >= 2 then raise exception 'DAILY_LIMIT_REACHED'; end if;

  insert into public.games (organizer_id, sport_slug, title, description, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size)
  values (v_uid, p_sport_slug, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), btrim(p_venue),
          p_neighborhood, p_starts_at, p_max_players, p_join_mode, p_skill_levels, p_team_size)
  returning id into v_id;

  insert into public.game_players (game_id, player_id) values (v_id, v_uid);

  -- every upcoming game is now discoverable, so alert eligible opted-in players for all of them
  perform private.notify(p.id, 'new_game_nearby',
    'New ' || sp.name || ' game near ' || gn.name,
    btrim(p_title) || ' · ' || private.game_when(p_starts_at),
    v_id)
  from public.profiles p
  join public.user_sports us   on us.user_id = p.id and us.sport_slug = p_sport_slug
  join public.neighborhoods pn on pn.slug = p.neighborhood
  join public.neighborhoods gn on gn.slug = p_neighborhood
  join public.sports sp        on sp.slug = p_sport_slug
  where p.new_game_alerts
    and p.id <> v_uid
    and (p_skill_levels is null or us.skill_level = any (p_skill_levels))
    and private.distance_miles(pn.lat, pn.lng, gn.lat, gn.lng) <= p.travel_radius_miles;

  return v_id;
end $$;

-- ---------- browse_games: every upcoming game, full ones included by default ----------
drop function public.browse_games(text, text, date, date, boolean);

create function public.browse_games(
  p_sport_slug text default null, p_neighborhood text default null,
  p_from date default null, p_to date default null, p_only_open_spots boolean default false
) returns table (
  id uuid, title text, description text, sport_slug text, venue text, neighborhood text, starts_at timestamptz,
  max_players smallint, team_size smallint, join_mode text, skill_levels text[],
  organizer_id uuid, organizer_name text, player_count int, spots_left int, distance_miles numeric,
  is_member boolean, can_join boolean, can_request boolean, has_pending_request boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if (p_sport_slug is not null and not exists (select 1 from public.sports s where s.slug = p_sport_slug))
     or (p_neighborhood is not null and not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)) then
    raise exception 'VALIDATION';
  end if;

  return query
  with base as (
    select g.id as gid, g.title as gtitle, g.description as gdesc, g.sport_slug as gsport, g.venue as gvenue,
           g.neighborhood as ghood, g.starts_at as gstart, g.max_players as gmax, g.team_size as gteam,
           g.join_mode as gmode, g.skill_levels as glevels, g.organizer_id as gorg,
           (select count(*) from public.game_players gp where gp.game_id = g.id)::int as pc,
           exists (select 1 from public.game_players gp where gp.game_id = g.id and gp.player_id = v_uid) as mem,
           (select us.skill_level from public.user_sports us where us.user_id = v_uid and us.sport_slug = g.sport_slug) as my_level,
           exists (select 1 from public.join_requests jr
                   where jr.game_id = g.id and jr.player_id = v_uid and jr.status = 'pending') as req
    from public.games g
    where g.status = 'scheduled' and g.starts_at > now()
      and (p_sport_slug   is null or g.sport_slug = p_sport_slug)
      and (p_neighborhood is null or g.neighborhood = p_neighborhood)
      and (p_from is null or (g.starts_at at time zone 'America/New_York')::date >= p_from)
      and (p_to   is null or (g.starts_at at time zone 'America/New_York')::date <= p_to)
  )
  select b.gid, b.gtitle, b.gdesc, b.gsport, b.gvenue, b.ghood, b.gstart, b.gmax, b.gteam, b.gmode, b.glevels,
         b.gorg, p.display_name, b.pc, (b.gmax - b.pc)::int,
         round(private.distance_miles(me.lat, me.lng, gn.lat, gn.lng)::numeric, 1),
         b.mem,
         coalesce(b.gmode = 'open' and not b.mem and b.gmax > b.pc and b.my_level is not null
                  and (b.glevels is null or b.my_level = any (b.glevels)), false),
         coalesce(b.gmode = 'invite_only' and not b.mem and b.gmax > b.pc and not b.req and b.my_level is not null
                  and (b.glevels is null or b.my_level = any (b.glevels)), false),
         b.req
  from base b
  join public.profiles p       on p.id = b.gorg
  join public.neighborhoods gn on gn.slug = b.ghood
  left join (select n.lat, n.lng from public.profiles pr
             join public.neighborhoods n on n.slug = pr.neighborhood
             where pr.id = v_uid) me on true
  where (not coalesce(p_only_open_spots, false) or b.gmax > b.pc)
  order by b.gstart, b.gid;
end $$;

-- ---------- Join requests: any invite-only game (null levels = all levels) ----------
create or replace function public.request_to_join(p_game_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_id    uuid;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.join_mode <> 'invite_only' then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'VALIDATION';
  end if;
  if not private.level_allowed(v_game.skill_levels, v_uid, v_game.sport_slug) then raise exception 'NOT_ELIGIBLE'; end if;

  select jr.id into v_id from public.join_requests jr
  where jr.game_id = p_game_id and jr.player_id = v_uid and jr.status = 'pending';
  if found then return v_id; end if;

  select count(*) into v_count from public.game_players gp where gp.game_id = p_game_id;
  if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;

  insert into public.join_requests (game_id, player_id) values (p_game_id, v_uid) returning id into v_id;
  perform private.notify(v_game.organizer_id, 'join_request_received',
    private.display_name(v_uid) || ' wants to join ' || v_game.title, 'Approve or decline the request.',
    p_game_id, null, v_id);
  return v_id;
end $$;

-- Approval re-checks the player's eligibility under the game lock.
create or replace function public.respond_to_join_request(p_request_id uuid, p_response text, p_team text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game_id uuid;
  v_game    public.games;
  v_req     public.join_requests;
  v_count   int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_response is null or p_response not in ('approved', 'declined')
     or (p_team is not null and p_team not in ('A', 'B')) then
    raise exception 'VALIDATION';
  end if;
  select jr.game_id into v_game_id from public.join_requests jr where jr.id = p_request_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_req  from public.join_requests jr where jr.id = p_request_id for update;
  if v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_req.status = p_response then return p_response; end if;
  if v_req.status <> 'pending' then raise exception 'INVITATION_CLOSED'; end if;

  if p_response = 'approved' then
    if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
    if not exists (select 1 from public.game_players gp where gp.game_id = v_game.id and gp.player_id = v_req.player_id) then
      if not private.level_allowed(v_game.skill_levels, v_req.player_id, v_game.sport_slug) then
        raise exception 'NOT_ELIGIBLE';
      end if;
      select count(*) into v_count from public.game_players gp where gp.game_id = v_game.id;
      if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;
      if p_team is not null and v_game.team_size is not null
         and private.team_count(v_game.id, p_team) >= v_game.team_size then
        raise exception 'TEAM_FULL';
      end if;
      insert into public.game_players (game_id, player_id, team) values (v_game.id, v_req.player_id, p_team);
    end if;
  end if;

  update public.join_requests jr set status = p_response, responded_at = now() where jr.id = p_request_id;
  perform private.notify(v_req.player_id,
    case when p_response = 'approved' then 'join_request_approved' else 'join_request_declined' end,
    case when p_response = 'approved' then 'You''re in: ' || v_game.title
         else 'Request declined: ' || v_game.title end,
    case when p_response = 'approved' then private.game_when(v_game.starts_at) else '' end,
    v_game.id, null, p_request_id, jsonb_strip_nulls(jsonb_build_object('team', p_team)));
  return p_response;
end $$;

-- ---------- submit_results: per-sport metrics ----------
-- p_performances: [{ "player_id": "...", "metrics": { "goals": 2, "assists": 1 } }, ...]
-- Legacy flat fields (goals / assists / points) are still accepted and mapped when the sport defines them.
create or replace function public.submit_results(
  p_game_id uuid, p_team_a_score smallint, p_team_b_score smallint, p_performances jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
  v_perf jsonb := coalesce(p_performances, '[]'::jsonb);
  v_p    uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status = 'cancelled' then raise exception 'GAME_UNAVAILABLE'; end if;
  if (v_game.starts_at at time zone 'America/New_York')::date > (now() at time zone 'America/New_York')::date then
    raise exception 'RESULTS_TOO_EARLY';
  end if;
  if p_team_a_score is null or p_team_b_score is null
     or p_team_a_score not between 0 and 999 or p_team_b_score not between 0 and 999 then
    raise exception 'VALIDATION';
  end if;
  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.team is null)
     or (select count(distinct gp.team) from public.game_players gp where gp.game_id = p_game_id) < 2 then
    raise exception 'TEAMS_INCOMPLETE';
  end if;

  -- shape: a list of objects for roster players, each at most once
  if jsonb_typeof(v_perf) <> 'array'
     or exists (select 1 from jsonb_array_elements(v_perf) e
                where jsonb_typeof(e) <> 'object'
                   or not exists (select 1 from public.game_players gp
                                  where gp.game_id = p_game_id and gp.player_id::text = e ->> 'player_id')
                   or (e ? 'metrics' and jsonb_typeof(e -> 'metrics') <> 'object')
                   or (e ? 'goals'   and coalesce(e ->> 'goals', '')   !~ '^[0-9]{1,5}$')
                   or (e ? 'assists' and coalesce(e ->> 'assists', '') !~ '^[0-9]{1,5}$')
                   or (e ? 'points'  and coalesce(e ->> 'points', '')  !~ '^[0-9]{1,5}$'))
     or (select count(distinct e ->> 'player_id') from jsonb_array_elements(v_perf) e) <> jsonb_array_length(v_perf) then
    raise exception 'VALIDATION';
  end if;

  -- every submitted metric value: nested ones + applicable legacy flat ones
  drop table if exists _m;
  create temp table _m on commit drop as
  select (e ->> 'player_id')::uuid as player_id, m.key as stat_key, m.value #>> '{}' as raw, 'metrics' as src
  from jsonb_array_elements(v_perf) e
  cross join lateral jsonb_each(coalesce(e -> 'metrics', '{}'::jsonb)) m
  union all
  select (e ->> 'player_id')::uuid, k, e ->> k, 'flat'
  from jsonb_array_elements(v_perf) e
  cross join unnest(array['goals', 'assists', 'points']) k
  where e ? k
    and exists (select 1 from public.sport_stat_definitions d where d.sport_slug = v_game.sport_slug and d.stat_key = k);

  if exists (select 1 from _m
             left join public.sport_stat_definitions d on d.sport_slug = v_game.sport_slug and d.stat_key = _m.stat_key
             where d.stat_key is null                              -- undefined metric for this sport
                or coalesce(_m.raw, '') !~ '^[0-9]{1,5}$'          -- not a non-negative integer
                or _m.raw::int > d.max_value)                      -- over the limit
     or exists (select 1 from _m group by player_id, stat_key having count(*) > 1) then   -- conflicting values
    raise exception 'VALIDATION';
  end if;

  insert into public.game_results (game_id, team_a_score, team_b_score, status, submitted_by)
  values (p_game_id, p_team_a_score, p_team_b_score, 'pending', v_uid)
  on conflict (game_id) do update
    set team_a_score = excluded.team_a_score, team_b_score = excluded.team_b_score, status = 'pending',
        submitted_by = excluded.submitted_by, submitted_at = now(), confirmed_by = null, confirmed_at = null,
        dispute_reason = null, revision = public.game_results.revision + 1;

  -- replace (never add to) the previous revision's rows; values cascade
  delete from public.player_game_stats pgs where pgs.game_id = p_game_id;

  insert into public.player_game_stats (game_id, player_id, team, outcome, goals, assists, points)
  select p_game_id, gp.player_id, gp.team,
         case when p_team_a_score = p_team_b_score then 'draw'
              when (gp.team = 'A') = (p_team_a_score > p_team_b_score) then 'win'
              else 'loss' end,
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'goals'), 0),
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'assists'), 0),
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'points'), 0)
  from public.game_players gp
  where gp.game_id = p_game_id;

  -- one value per defined metric per roster player; omitted = 0
  insert into public.player_game_stat_values (game_id, player_id, sport_slug, stat_key, value)
  select p_game_id, gp.player_id, d.sport_slug, d.stat_key,
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = d.stat_key), 0)
  from public.game_players gp
  cross join public.sport_stat_definitions d
  where gp.game_id = p_game_id and d.sport_slug = v_game.sport_slug;

  update public.games g set status = 'completed' where g.id = p_game_id;
  update public.invitations i set status = 'expired', responded_at = now()
  where i.game_id = p_game_id and i.status = 'pending';
  update public.join_requests jr set status = 'cancelled', responded_at = now()
  where jr.game_id = p_game_id and jr.status = 'pending';

  perform private.notify(gp.player_id, 'results_submitted', 'Confirm the result: ' || v_game.title,
    format('Team A %s – %s Team B. Confirm or dispute it.', p_team_a_score, p_team_b_score), p_game_id)
  from public.game_players gp where gp.game_id = p_game_id and gp.player_id <> v_uid;

  -- a reopened result no longer counts; refresh levels (verified levels stay locked)
  for v_p in select gp.player_id from public.game_players gp where gp.game_id = p_game_id loop
    perform private.recalc_level(v_p, v_game.sport_slug);
  end loop;
  return 'pending';
end $$;

-- ---------- Level calculation: metric definitions + final-only ratings ----------
create or replace function private.recalc_level(p_player uuid, p_sport text) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_us          public.user_sports;
  v_ss          private.skill_scores;
  v_start       numeric;
  v_r           numeric;  v_s numeric;  v_w numeric;
  v_raters      int;
  v_rated_games int;
  v_n           int;
  v_wins        numeric;
  v_wr numeric; v_ws numeric; v_ww numeric;
  v_p           numeric;
  v_score       numeric;
  v_verified    boolean;
  v_new         text;
begin
  select * into v_us from public.user_sports us where us.user_id = p_player and us.sport_slug = p_sport;
  if not found then return; end if;
  select * into v_ss from private.skill_scores ss where ss.player_id = p_player and ss.sport_slug = p_sport;
  v_start := coalesce(v_ss.start_score, private.level_start_score(v_us.skill_level));

  -- R: each rater's latest skill rating, from games whose result is currently final
  with latest as (
    select distinct on (r.reviewer_id) r.skill_rating
    from public.reviews r
    join public.game_results gr on gr.game_id = r.game_id and gr.status = 'final'
    where r.reviewee_id = p_player and r.sport_slug = p_sport and r.skill_rating is not null
    order by r.reviewer_id, r.created_at desc, r.id
  ), ranked as (
    select skill_rating,
           row_number() over (order by skill_rating)      as lo,
           row_number() over (order by skill_rating desc) as hi,
           count(*) over ()                              as n
    from latest
  )
  select avg(skill_rating) filter (where n < 5 or (lo > 1 and hi > 1)), coalesce(max(n), 0)
    into v_r, v_raters
  from ranked;

  select count(distinct r.game_id) into v_rated_games
  from public.reviews r
  join public.game_results gr on gr.game_id = r.game_id and gr.status = 'final'
  where r.reviewee_id = p_player and r.sport_slug = p_sport and r.skill_rating is not null;

  -- S: contribution = sum(metric value × level_weight), ranked within each final game
  with my_games as (
    select s.game_id
    from public.player_game_stats s
    join public.game_results gr on gr.game_id = s.game_id and gr.status = 'final'
    join public.games g         on g.id = s.game_id and g.sport_slug = p_sport
    where s.player_id = p_player
  ), contrib as (
    select v.game_id, v.player_id, sum(v.value * d.level_weight) as c
    from public.player_game_stat_values v
    join public.sport_stat_definitions d on d.sport_slug = v.sport_slug and d.stat_key = v.stat_key
    where v.game_id in (select game_id from my_games)
    group by v.game_id, v.player_id
  ), valid as (
    select game_id from contrib group by game_id having max(c) > 0 and count(*) >= 2
  ), pos as (
    select game_id, player_id,
           ((rank() over w_asc - 1) + (count(*) over (partition by game_id) - rank() over w_desc))::numeric / 2 as avg_pos,
           count(*) over (partition by game_id) as n
    from contrib
    where game_id in (select game_id from valid)
    window w_asc  as (partition by game_id order by c),
           w_desc as (partition by game_id order by c desc)
  )
  select avg(1 + 4 * avg_pos / (n - 1)) into v_s from pos where player_id = p_player;

  -- W: win share with 2 pretend wins + 2 pretend losses
  select count(*), coalesce(sum(case s.outcome when 'win' then 1 when 'draw' then 0.5 else 0 end), 0)
    into v_n, v_wins
  from public.player_game_stats s
  join public.game_results gr on gr.game_id = s.game_id and gr.status = 'final'
  join public.games g         on g.id = s.game_id and g.sport_slug = p_sport
  where s.player_id = p_player;
  v_w := case when v_n > 0 then 1 + 4 * (v_wins + 2) / (v_n + 4) end;

  -- Sports with stat definitions: 50/30/20. Sports without (pickleball, custom): 60/40 ratings/wins.
  if exists (select 1 from public.sport_stat_definitions d where d.sport_slug = p_sport) then
    v_wr := 0.5; v_ws := 0.3; v_ww := 0.2;
  else
    v_wr := 0.6; v_ws := 0;   v_ww := 0.4;
  end if;
  if v_r is null then v_wr := 0; end if;
  if v_s is null then v_ws := 0; end if;
  if v_w is null then v_ww := 0; end if;
  if v_wr + v_ws + v_ww > 0 then
    v_p := (v_wr * coalesce(v_r, 0) + v_ws * coalesce(v_s, 0) + v_ww * coalesce(v_w, 0)) / (v_wr + v_ws + v_ww);
  end if;

  v_score := case when v_p is null or v_n = 0 then v_start
                  else (3 * v_start + v_n * v_p) / (3 + v_n) end;
  v_score := greatest(1, least(5, round(v_score, 2)));

  v_verified := coalesce(v_ss.verified, false) or (v_raters >= 3 and v_rated_games >= 2);

  v_new := v_us.skill_level;
  if v_verified then
    if v_score >= 3.92 then v_new := 'advanced';
    elsif v_score <= 2.08 then v_new := 'beginner';
    elsif v_new = 'beginner' and v_score >= 2.58 then v_new := 'intermediate';
    elsif v_new = 'advanced' and v_score <= 3.42 then v_new := 'intermediate';
    end if;
  end if;

  insert into private.skill_scores (player_id, sport_slug, start_score, score, level, verified, rating_count, updated_at)
  values (p_player, p_sport, v_start, v_score, v_new, v_verified, v_raters, now())
  on conflict (player_id, sport_slug) do update
    set score = excluded.score, level = excluded.level, verified = excluded.verified,
        rating_count = excluded.rating_count, updated_at = now();

  update public.user_sports us
  set skill_level  = v_new,
      level_source = case when v_verified then 'verified' else 'self' end,
      rating_count = v_raters
  where us.user_id = p_player and us.sport_slug = p_sport;

  if v_new <> v_us.skill_level then
    perform private.notify(p_player, 'level_changed',
      'Your ' || (select s.name from public.sports s where s.slug = p_sport) || ' level is now ' || initcap(v_new),
      'Based on ratings from ' || v_raters || ' players, your stats, and your results.',
      null, null, null, jsonb_build_object('sport_slug', p_sport, 'level', v_new));
  end if;
end $$;

-- ---------- Refresh every stored level with the v4 rules ----------
do $$
declare r record;
begin
  for r in select us.user_id, us.sport_slug from public.user_sports us loop
    perform private.recalc_level(r.user_id, r.sport_slug);
  end loop;
end $$;

-- ---------- Permissions ----------
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_game_organizer(uuid), private.is_game_player(uuid),
                         private.has_pending_invitation(uuid), private.can_view_game(uuid),
                         private.distance_miles(float8, float8, float8, float8)
  to authenticated;
