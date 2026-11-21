-- =====================================================================
-- Pickup Sports Tampa — 007: v3 functions
--
-- Same rules as 003: actor = auth.uid(); security definer with an empty
-- search_path; anything touching roster/invitations/teams/results/requests
-- locks the game row FIRST; errors are stable codes in error.message.
-- New codes: TEAM_FULL, LEVEL_LOCKED, DAILY_LIMIT_REACHED.
-- =====================================================================

-- =====================================================================
-- Internal helpers (private schema, not callable by clients)
-- =====================================================================

create function private.notify(
  p_user uuid, p_type text, p_title text, p_body text, p_game uuid,
  p_invitation uuid default null, p_join_request uuid default null, p_data jsonb default '{}'
) returns void
language sql security definer set search_path = '' as $$
  insert into public.notifications (user_id, type, title, body, game_id, invitation_id, join_request_id, data)
  values (p_user, p_type, p_title, coalesce(p_body, ''), p_game, p_invitation, p_join_request, coalesce(p_data, '{}'::jsonb));
$$;

create function private.display_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select p.display_name from public.profiles p where p.id = p_user), 'A player')
$$;

create function private.level_start_score(p_level text) returns numeric
language sql immutable set search_path = '' as $$
  select case p_level when 'beginner' then 1.5 when 'intermediate' then 3.0 when 'advanced' then 4.5 end
$$;

-- Plays the sport, and (if the game restricts levels) is at an allowed level.
create function private.level_allowed(p_levels text[], p_player uuid, p_sport text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.user_sports us
                 where us.user_id = p_player and us.sport_slug = p_sport
                   and (p_levels is null or us.skill_level = any (p_levels)))
$$;

create function private.team_count(p_game uuid, p_team text) returns int
language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.game_players gp where gp.game_id = p_game and gp.team = p_team
$$;

create function private.game_when(p_starts_at timestamptz) returns text
language sql stable set search_path = '' as $$
  select to_char(p_starts_at at time zone 'America/New_York', 'Dy Mon FMDD, FMHH12:MI AM')
$$;

-- ---------------------------------------------------------------------
-- Level calculation (see "How levels are calculated" in the contract)
-- ---------------------------------------------------------------------
create function private.recalc_level(p_player uuid, p_sport text) returns void
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

  -- R: each rater's latest skill rating; with 5+ raters drop the single highest and lowest
  with latest as (
    select distinct on (r.reviewer_id) r.skill_rating
    from public.reviews r
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
  where r.reviewee_id = p_player and r.sport_slug = p_sport and r.skill_rating is not null;

  -- S: rank each final game's contribution against everyone in that game (top 5, bottom 1, ties averaged)
  with my_games as (
    select s.game_id
    from public.player_game_stats s
    join public.game_results gr on gr.game_id = s.game_id and gr.status = 'final'
    join public.games g         on g.id = s.game_id and g.sport_slug = p_sport
    where s.player_id = p_player
  ), contrib as (
    select s.game_id, s.player_id,
           case p_sport when 'soccer'     then s.goals + 0.75 * s.assists
                        when 'basketball' then s.points + 1.5 * s.assists
                        when 'volleyball' then s.points::numeric
           end as c
    from public.player_game_stats s
    where s.game_id in (select game_id from my_games)
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

  -- Weights; a part with no data gives its weight to the others
  if p_sport = 'pickleball' then v_wr := 0.6; v_ws := 0;   v_ww := 0.4;
  else                           v_wr := 0.5; v_ws := 0.3; v_ww := 0.2;
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

  -- Verified: 3+ raters across 2+ games (stays verified once reached)
  v_verified := coalesce(v_ss.verified, false) or (v_raters >= 3 and v_rated_games >= 2);

  -- Level bands with a 0.25 buffer; only moves once verified
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

-- ---------------------------------------------------------------------
-- One invitation (shared by send_invitation, send_invitations, invite_squad).
-- Caller has already locked the game and checked organizer + game state.
-- ---------------------------------------------------------------------
create function private.invite_one(p_game public.games, p_recipient uuid, p_team text, p_squad uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id         uuid;
  v_count      int;
  v_squad_name text;
begin
  select i.id into v_id from public.invitations i
  where i.game_id = p_game.id and i.recipient_id = p_recipient and i.status = 'pending';
  if found then return v_id; end if;

  if exists (select 1 from public.invitations i
             where i.game_id = p_game.id and i.recipient_id = p_recipient and i.status = 'declined') then
    raise exception 'INVITATION_CLOSED';
  end if;

  if p_recipient is null or p_recipient = p_game.organizer_id
     or not exists (select 1 from public.user_sports us where us.user_id = p_recipient and us.sport_slug = p_game.sport_slug)
     or exists (select 1 from public.game_players gp where gp.game_id = p_game.id and gp.player_id = p_recipient) then
    raise exception 'VALIDATION';
  end if;

  select count(*) into v_count from public.game_players gp where gp.game_id = p_game.id;
  if v_count >= p_game.max_players then raise exception 'GAME_FULL'; end if;

  insert into public.invitations (game_id, sender_id, recipient_id, team, squad_id)
  values (p_game.id, p_game.organizer_id, p_recipient, p_team, p_squad)
  returning id into v_id;

  select s.name into v_squad_name from public.squads s where s.id = p_squad;
  perform private.notify(p_recipient, 'invitation_received',
    private.display_name(p_game.organizer_id) || ' invited you to ' || p_game.title,
    private.game_when(p_game.starts_at) || coalesce(' · with squad ' || v_squad_name, ''),
    p_game.id, v_id, null,
    jsonb_strip_nulls(jsonb_build_object('team', p_team, 'squad_name', v_squad_name)));
  return v_id;
end $$;

-- =====================================================================
-- Profiles (adds alert settings + level lock)
-- =====================================================================
drop function public.save_profile(text, text, smallint, text, jsonb);

create function public.save_profile(
  p_display_name text, p_neighborhood text, p_travel_radius_miles smallint, p_bio text, p_sports jsonb,
  p_replacement_alerts boolean default null, p_new_game_alerts boolean default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
  v_e    jsonb;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;

  if char_length(v_name) not between 1 and 60
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or p_travel_radius_miles is null or p_travel_radius_miles not between 1 and 50
     or char_length(coalesce(p_bio, '')) > 300
     or p_sports is null or jsonb_typeof(p_sports) <> 'array' or jsonb_array_length(p_sports) = 0 then
    raise exception 'VALIDATION';
  end if;
  if exists (select 1 from jsonb_array_elements(p_sports) e
             where jsonb_typeof(e) <> 'object'
                or not exists (select 1 from public.sports s where s.slug = e ->> 'sport_slug')
                or coalesce(e ->> 'skill_level', '') not in ('beginner', 'intermediate', 'advanced'))
     or (select count(distinct e ->> 'sport_slug') from jsonb_array_elements(p_sports) e) <> jsonb_array_length(p_sports) then
    raise exception 'VALIDATION';
  end if;

  -- A verified level can only be changed by ratings
  if exists (select 1 from jsonb_array_elements(p_sports) e
             join private.skill_scores ss on ss.player_id = v_uid and ss.sport_slug = e ->> 'sport_slug'
             where ss.verified and ss.level <> e ->> 'skill_level') then
    raise exception 'LEVEL_LOCKED';
  end if;

  insert into public.profiles (id, display_name, neighborhood, travel_radius_miles, bio, replacement_alerts, new_game_alerts)
  values (v_uid, v_name, p_neighborhood, p_travel_radius_miles, coalesce(p_bio, ''),
          coalesce(p_replacement_alerts, true), coalesce(p_new_game_alerts, false))
  on conflict (id) do update
    set display_name        = excluded.display_name,
        neighborhood        = excluded.neighborhood,
        travel_radius_miles = excluded.travel_radius_miles,
        bio                 = excluded.bio,
        replacement_alerts  = coalesce(p_replacement_alerts, public.profiles.replacement_alerts),
        new_game_alerts     = coalesce(p_new_game_alerts,    public.profiles.new_game_alerts);

  delete from public.user_sports us where us.user_id = v_uid;
  insert into public.user_sports (user_id, sport_slug, skill_level, level_source, rating_count)
  select v_uid, e ->> 'sport_slug',
         case when ss.verified then ss.level else e ->> 'skill_level' end,
         case when ss.verified then 'verified' else 'self' end,
         coalesce(ss.rating_count, 0)
  from jsonb_array_elements(p_sports) e
  left join private.skill_scores ss on ss.player_id = v_uid and ss.sport_slug = e ->> 'sport_slug';

  -- Self-rated sports: the chosen level is the new starting point
  insert into private.skill_scores (player_id, sport_slug, start_score, score, level)
  select v_uid, e ->> 'sport_slug', private.level_start_score(e ->> 'skill_level'),
         private.level_start_score(e ->> 'skill_level'), e ->> 'skill_level'
  from jsonb_array_elements(p_sports) e
  on conflict (player_id, sport_slug) do update
    set start_score = excluded.start_score, level = excluded.level, updated_at = now()
    where not private.skill_scores.verified;

  for v_e in select * from jsonb_array_elements(p_sports) loop
    perform private.recalc_level(v_uid, v_e ->> 'sport_slug');
  end loop;

  return v_uid;
end $$;

-- =====================================================================
-- Games
-- =====================================================================
drop function public.create_game(text, text, text, text, timestamptz, smallint);

create function public.create_game(
  p_sport_slug text, p_title text, p_venue text, p_neighborhood text, p_starts_at timestamptz, p_max_players smallint,
  p_join_mode text default 'invite_only', p_skill_levels text[] default null, p_team_size smallint default null
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
     or p_max_players is null or p_max_players not between 2 and 50
     or p_starts_at is null or p_starts_at <= now()
     or p_join_mode is null or p_join_mode not in ('open', 'invite_only')
     or not private.valid_skill_levels(p_skill_levels)
     or (p_team_size is not null and (p_team_size not between 1 and 25 or p_max_players <> 2 * p_team_size)) then
    raise exception 'VALIDATION';
  end if;

  -- 2 games per America/New_York day, cancelled games included; serialize per user
  perform pg_advisory_xact_lock(hashtext('create_game:' || v_uid::text));
  select count(*) into v_today from public.games g
  where g.organizer_id = v_uid
    and (g.created_at at time zone 'America/New_York')::date = (now() at time zone 'America/New_York')::date;
  if v_today >= 2 then raise exception 'DAILY_LIMIT_REACHED'; end if;

  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size)
  values (v_uid, p_sport_slug, btrim(p_title), btrim(p_venue), p_neighborhood, p_starts_at, p_max_players,
          p_join_mode, p_skill_levels, p_team_size)
  returning id into v_id;

  insert into public.game_players (game_id, player_id) values (v_id, v_uid);

  -- New-game alerts: only for games visible beyond their members
  if p_join_mode = 'open' or p_skill_levels is not null then
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
  end if;

  return v_id;
end $$;

create or replace function public.cancel_game(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status = 'cancelled' then return 'cancelled'; end if;
  if v_game.status <> 'scheduled' then raise exception 'GAME_UNAVAILABLE'; end if;

  update public.games g set status = 'cancelled' where g.id = p_game_id;

  -- notify roster (except organizer) and everyone with a pending invite
  perform private.notify(x.uid, 'game_cancelled', v_game.title || ' was cancelled',
                         'The organizer cancelled this game.', p_game_id)
  from (select gp.player_id as uid from public.game_players gp where gp.game_id = p_game_id and gp.player_id <> v_uid
        union
        select i.recipient_id from public.invitations i where i.game_id = p_game_id and i.status = 'pending') x;

  update public.invitations i set status = 'cancelled', responded_at = now()
  where i.game_id = p_game_id and i.status = 'pending';
  update public.join_requests jr set status = 'cancelled', responded_at = now()
  where jr.game_id = p_game_id and jr.status = 'pending';
  return 'cancelled';
end $$;

-- Browse games the caller can see (open games + level-matched invite-only games + their own).
create function public.browse_games(
  p_sport_slug text default null, p_neighborhood text default null,
  p_from date default null, p_to date default null, p_only_open_spots boolean default true
) returns table (
  id uuid, title text, sport_slug text, venue text, neighborhood text, starts_at timestamptz,
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
    select g.id as gid, g.title as gtitle, g.sport_slug as gsport, g.venue as gvenue, g.neighborhood as ghood,
           g.starts_at as gstart, g.max_players as gmax, g.team_size as gteam, g.join_mode as gmode,
           g.skill_levels as glevels, g.organizer_id as gorg,
           (select count(*) from public.game_players gp where gp.game_id = g.id)::int as pc,
           exists (select 1 from public.game_players gp where gp.game_id = g.id and gp.player_id = v_uid) as mem,
           (select us.skill_level from public.user_sports us where us.user_id = v_uid and us.sport_slug = g.sport_slug) as my_level,
           exists (select 1 from public.join_requests jr
                   where jr.game_id = g.id and jr.player_id = v_uid and jr.status = 'pending') as req
    from public.games g
    where g.status = 'scheduled' and g.starts_at > now()
      and private.can_view_game(g.id)
      and (p_sport_slug   is null or g.sport_slug = p_sport_slug)
      and (p_neighborhood is null or g.neighborhood = p_neighborhood)
      and (p_from is null or (g.starts_at at time zone 'America/New_York')::date >= p_from)
      and (p_to   is null or (g.starts_at at time zone 'America/New_York')::date <= p_to)
  )
  select b.gid, b.gtitle, b.gsport, b.gvenue, b.ghood, b.gstart, b.gmax, b.gteam, b.gmode, b.glevels,
         b.gorg, p.display_name, b.pc, (b.gmax - b.pc)::int,
         round(private.distance_miles(me.lat, me.lng, gn.lat, gn.lng)::numeric, 1),
         b.mem,
         coalesce(b.gmode = 'open' and not b.mem and b.gmax > b.pc and b.my_level is not null
                  and (b.glevels is null or b.my_level = any (b.glevels)), false),
         coalesce(b.gmode = 'invite_only' and not b.mem and b.gmax > b.pc and not b.req
                  and b.glevels is not null and b.my_level = any (b.glevels), false),
         b.req
  from base b
  join public.profiles p       on p.id = b.gorg
  join public.neighborhoods gn on gn.slug = b.ghood
  left join (select n.lat, n.lng from public.profiles pr
             join public.neighborhoods n on n.slug = pr.neighborhood
             where pr.id = v_uid) me on true
  where (not coalesce(p_only_open_spots, true) or b.gmax > b.pc)
  order by b.gstart, b.gid;
end $$;

-- Join an OPEN game directly.
create function public.join_game(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.join_mode <> 'open' then raise exception 'FORBIDDEN'; end if;
  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    return 'joined';
  end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  if not private.level_allowed(v_game.skill_levels, v_uid, v_game.sport_slug) then raise exception 'NOT_ELIGIBLE'; end if;
  select count(*) into v_count from public.game_players gp where gp.game_id = p_game_id;
  if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;

  insert into public.game_players (game_id, player_id) values (p_game_id, v_uid);
  update public.invitations i set status = 'accepted', responded_at = now()
  where i.game_id = p_game_id and i.recipient_id = v_uid and i.status = 'pending';

  perform private.notify(v_game.organizer_id, 'player_joined',
    private.display_name(v_uid) || ' joined ' || v_game.title, '', p_game_id);
  return 'joined';
end $$;

-- =====================================================================
-- Join requests (invite-only games)
-- =====================================================================
create function public.request_to_join(p_game_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_id    uuid;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.join_mode <> 'invite_only' or v_game.skill_levels is null
     or not private.level_allowed(v_game.skill_levels, v_uid, v_game.sport_slug) then
    raise exception 'FORBIDDEN';
  end if;
  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'VALIDATION';
  end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;

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

create function public.cancel_join_request(p_request_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game_id uuid;
  v_req     public.join_requests;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select jr.game_id into v_game_id from public.join_requests jr where jr.id = p_request_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  perform 1 from public.games g where g.id = v_game_id for update;
  select * into v_req from public.join_requests jr where jr.id = p_request_id for update;
  if v_req.player_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_req.status = 'cancelled' then return 'cancelled'; end if;
  if v_req.status <> 'pending' then raise exception 'INVITATION_CLOSED'; end if;
  update public.join_requests jr set status = 'cancelled', responded_at = now() where jr.id = p_request_id;
  return 'cancelled';
end $$;

create function public.respond_to_join_request(p_request_id uuid, p_response text, p_team text default null) returns text
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

-- =====================================================================
-- Invitations (team on invite, bulk, squads, notifications)
-- =====================================================================
drop function public.send_invitation(uuid, uuid);

create function public.send_invitation(p_game_id uuid, p_recipient_id uuid, p_team text default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  if p_team is not null and p_team not in ('A', 'B') then raise exception 'VALIDATION'; end if;
  return private.invite_one(v_game, p_recipient_id, p_team, null);
end $$;

create function public.send_invitations(p_game_id uuid, p_recipient_ids uuid[], p_team text default null)
returns table (recipient_id uuid, invitation_id uuid, error text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
  v_r    uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  if (p_team is not null and p_team not in ('A', 'B'))
     or p_recipient_ids is null or cardinality(p_recipient_ids) not between 1 and 25 then
    raise exception 'VALIDATION';
  end if;

  for v_r in select distinct x from unnest(p_recipient_ids) x loop
    begin
      invitation_id := private.invite_one(v_game, v_r, p_team, null);
      recipient_id := v_r; error := null;
    exception when others then
      recipient_id := v_r; invitation_id := null; error := sqlerrm;
    end;
    return next;
  end loop;
end $$;

create or replace function public.respond_to_invitation(p_invitation_id uuid, p_response text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game_id uuid;
  v_game    public.games;
  v_inv     public.invitations;
  v_count   int;
  v_name    text;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_response is null or p_response not in ('accepted', 'declined') then raise exception 'VALIDATION'; end if;

  select i.game_id into v_game_id from public.invitations i where i.id = p_invitation_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_inv  from public.invitations i where i.id = p_invitation_id for update;

  if v_inv.recipient_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_inv.status = p_response then return p_response; end if;
  if v_inv.status <> 'pending' then raise exception 'INVITATION_CLOSED'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;

  if p_response = 'accepted' then
    select count(*) into v_count from public.game_players gp where gp.game_id = v_game.id;
    if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;
    if v_inv.team is not null and v_game.team_size is not null
       and private.team_count(v_game.id, v_inv.team) >= v_game.team_size then
      raise exception 'TEAM_FULL';
    end if;
    insert into public.game_players (game_id, player_id, team) values (v_game.id, v_uid, v_inv.team);
  end if;

  update public.invitations i set status = p_response, responded_at = now() where i.id = p_invitation_id;

  v_name := private.display_name(v_uid);
  perform private.notify(v_game.organizer_id,
    case when p_response = 'accepted' then 'invitation_accepted' else 'invitation_declined' end,
    case when p_response = 'accepted' then v_name || ' is in for ' || v_game.title
         else v_name || ' can''t make ' || v_game.title end,
    '', v_game.id, p_invitation_id);
  return p_response;
end $$;

create or replace function public.cancel_invitation(p_invitation_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game_id uuid;
  v_game    public.games;
  v_inv     public.invitations;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select i.game_id into v_game_id from public.invitations i where i.id = p_invitation_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_inv  from public.invitations i where i.id = p_invitation_id for update;

  if v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_inv.status = 'cancelled' then return 'cancelled'; end if;
  if v_inv.status <> 'pending' then raise exception 'INVITATION_CLOSED'; end if;

  update public.invitations i set status = 'cancelled', responded_at = now() where i.id = p_invitation_id;
  perform private.notify(v_inv.recipient_id, 'invitation_cancelled',
    'Invitation cancelled: ' || v_game.title, 'The organizer withdrew this invitation.', v_game.id, p_invitation_id);
  return 'cancelled';
end $$;

-- =====================================================================
-- Squads
-- =====================================================================
create function public.create_squad(p_name text, p_sport_slug text)
returns table (id uuid, join_code text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_id   uuid;
  v_code text;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if char_length(btrim(coalesce(p_name, ''))) not between 1 and 40
     or not exists (select 1 from public.user_sports us where us.user_id = v_uid and us.sport_slug = p_sport_slug) then
    raise exception 'VALIDATION';
  end if;
  loop
    v_code := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    exit when not exists (select 1 from public.squads s where s.join_code = v_code);
  end loop;

  insert into public.squads (name, sport_slug, captain_id, join_code)
  values (btrim(p_name), p_sport_slug, v_uid, v_code) returning squads.id into v_id;
  insert into public.squad_members (squad_id, player_id) values (v_id, v_uid);

  return query select v_id, v_code;
end $$;

create function public.join_squad(p_join_code text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_squad public.squads;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_squad from public.squads s where s.join_code = upper(btrim(coalesce(p_join_code, ''))) for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  if exists (select 1 from public.squad_members m where m.squad_id = v_squad.id and m.player_id = v_uid) then
    return v_squad.id;
  end if;
  if not exists (select 1 from public.user_sports us where us.user_id = v_uid and us.sport_slug = v_squad.sport_slug) then
    raise exception 'VALIDATION';
  end if;
  select count(*) into v_count from public.squad_members m where m.squad_id = v_squad.id;
  if v_count >= 25 then raise exception 'VALIDATION'; end if;

  insert into public.squad_members (squad_id, player_id) values (v_squad.id, v_uid);
  perform private.notify(v_squad.captain_id, 'squad_member_joined',
    private.display_name(v_uid) || ' joined ' || v_squad.name, '', null, null, null,
    jsonb_build_object('squad_id', v_squad.id));
  return v_squad.id;
end $$;

create function public.leave_squad(p_squad_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_squad public.squads;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_squad from public.squads s where s.id = p_squad_id for update;
  if not found or v_squad.captain_id = v_uid then raise exception 'FORBIDDEN'; end if;
  delete from public.squad_members m where m.squad_id = p_squad_id and m.player_id = v_uid;
  return 'left';
end $$;

create function public.remove_squad_member(p_squad_id uuid, p_player_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_squad public.squads;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_squad from public.squads s where s.id = p_squad_id for update;
  if not found or v_squad.captain_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if p_player_id = v_uid then raise exception 'VALIDATION'; end if;
  delete from public.squad_members m where m.squad_id = p_squad_id and m.player_id = p_player_id;
  if not found then raise exception 'VALIDATION'; end if;
  return 'removed';
end $$;

create function public.delete_squad(p_squad_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  delete from public.squads s where s.id = p_squad_id and s.captain_id = v_uid;
  if not found then raise exception 'FORBIDDEN'; end if;
  return 'deleted';
end $$;

create function public.invite_squad(p_game_id uuid, p_squad_id uuid, p_team text default null)
returns table (recipient_id uuid, invitation_id uuid, error text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_squad public.squads;
  v_r     uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  select * into v_squad from public.squads s where s.id = p_squad_id;
  if not found or v_squad.sport_slug <> v_game.sport_slug
     or (p_team is not null and p_team not in ('A', 'B')) then
    raise exception 'VALIDATION';
  end if;

  for v_r in
    select m.player_id from public.squad_members m
    where m.squad_id = p_squad_id and m.player_id <> v_uid
      and not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = m.player_id)
    order by m.joined_at
  loop
    begin
      invitation_id := private.invite_one(v_game, v_r, p_team, p_squad_id);
      recipient_id := v_r; error := null;
    exception when others then
      recipient_id := v_r; invitation_id := null; error := sqlerrm;
    end;
    return next;
  end loop;
end $$;

-- =====================================================================
-- Teams (team_size limits)
-- =====================================================================
create or replace function public.set_team(p_game_id uuid, p_player_id uuid, p_team text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' then raise exception 'GAME_UNAVAILABLE'; end if;
  if p_team is not null and p_team not in ('A', 'B') then raise exception 'VALIDATION'; end if;
  if not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = p_player_id) then
    raise exception 'VALIDATION';
  end if;
  if p_team is not null and v_game.team_size is not null
     and (select count(*) from public.game_players gp
          where gp.game_id = p_game_id and gp.team = p_team and gp.player_id <> p_player_id) >= v_game.team_size then
    raise exception 'TEAM_FULL';
  end if;

  update public.game_players gp set team = p_team where gp.game_id = p_game_id and gp.player_id = p_player_id;
  return p_team;
end $$;

-- Balanced by each player's hidden level score, snake draft (A B B A ...).
create or replace function public.auto_assign_teams(p_game_id uuid)
returns table (player_id uuid, team text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' then raise exception 'GAME_UNAVAILABLE'; end if;

  with ranked as (
    select gp.player_id as pid,
           row_number() over (
             order by coalesce(ss.score, private.level_start_score(us.skill_level), 3.0) desc, random()) as rn
    from public.game_players gp
    left join public.user_sports us   on us.user_id = gp.player_id and us.sport_slug = v_game.sport_slug
    left join private.skill_scores ss on ss.player_id = gp.player_id and ss.sport_slug = v_game.sport_slug
    where gp.game_id = p_game_id
  )
  update public.game_players gp
  set team = case when (r.rn - 1) % 4 in (0, 3) then 'A' else 'B' end
  from ranked r
  where gp.game_id = p_game_id and gp.player_id = r.pid;

  return query
    select gp.player_id, gp.team from public.game_players gp
    where gp.game_id = p_game_id order by gp.team, gp.joined_at;
end $$;

-- =====================================================================
-- Withdraw + emergency replacement
-- =====================================================================
create function public.withdraw_from_game(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid        uuid := auth.uid();
  v_game       public.games;
  v_team       text;
  v_last       boolean;
  v_withdrawal uuid;
  v_alert      uuid;
  v_name       text;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id = v_uid then raise exception 'FORBIDDEN'; end if;

  select gp.team into v_team from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid;
  if not found then
    -- repeat call: no new events
    if exists (select 1 from public.game_withdrawals w where w.game_id = p_game_id and w.player_id = v_uid) then
      return 'withdrawn';
    end if;
    raise exception 'FORBIDDEN';
  end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;

  v_last := now() >= v_game.starts_at - interval '60 minutes';
  delete from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid;
  insert into public.game_withdrawals (game_id, player_id, team, last_minute)
  values (p_game_id, v_uid, v_team, v_last) returning id into v_withdrawal;

  v_name := private.display_name(v_uid);
  perform private.notify(v_game.organizer_id, 'player_withdrew',
    v_name || ' withdrew from ' || v_game.title, 'One spot is now available.', p_game_id, null, null,
    jsonb_strip_nulls(jsonb_build_object('player_id', v_uid, 'team', v_team, 'last_minute', v_last)));

  if v_last then
    insert into public.replacement_alerts (game_id, withdrawal_id, open_team)
    values (p_game_id, v_withdrawal, v_team) returning id into v_alert;

    insert into public.replacement_alert_recipients (alert_id, game_id, player_id)
    select v_alert, p_game_id, p.id
    from public.profiles p
    join public.user_sports us   on us.user_id = p.id and us.sport_slug = v_game.sport_slug
    join public.neighborhoods pn on pn.slug = p.neighborhood
    join public.neighborhoods gn on gn.slug = v_game.neighborhood
    where p.replacement_alerts
      and p.id <> v_game.organizer_id
      and p.id <> v_uid
      and not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = p.id)
      and (v_game.skill_levels is null or us.skill_level = any (v_game.skill_levels))
      and private.distance_miles(pn.lat, pn.lng, gn.lat, gn.lng) <= p.travel_radius_miles
    on conflict (game_id, player_id) do nothing;

    perform private.notify(rr.player_id, 'replacement_needed',
      'Urgent: a spot opened in ' || v_game.title,
      sp.name || ' near ' || gn.name || ' starting ' || private.game_when(v_game.starts_at) || '. Claim it now!',
      p_game_id)
    from public.replacement_alert_recipients rr
    join public.sports sp        on sp.slug = v_game.sport_slug
    join public.neighborhoods gn on gn.slug = v_game.neighborhood
    where rr.alert_id = v_alert;
  end if;

  return 'withdrawn';
end $$;

create function public.claim_replacement_spot(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_team  text;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'NOT_ELIGIBLE'; end if;

  select ra.open_team into v_team
  from public.replacement_alert_recipients rr
  join public.replacement_alerts ra on ra.id = rr.alert_id
  where rr.game_id = p_game_id and rr.player_id = v_uid;
  if not found then raise exception 'NOT_ELIGIBLE'; end if;

  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    return 'joined';
  end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  select count(*) into v_count from public.game_players gp where gp.game_id = p_game_id;
  if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;

  if v_team is not null and v_game.team_size is not null
     and private.team_count(p_game_id, v_team) >= v_game.team_size then
    v_team := null;
  end if;

  insert into public.game_players (game_id, player_id, team) values (p_game_id, v_uid, v_team);
  perform private.notify(v_game.organizer_id, 'replacement_joined',
    private.display_name(v_uid) || ' took the open spot in ' || v_game.title, '', p_game_id, null, null,
    jsonb_strip_nulls(jsonb_build_object('player_id', v_uid, 'team', v_team)));
  return 'joined';
end $$;

-- =====================================================================
-- Results: notifications + level recalculation
-- =====================================================================
create or replace function public.submit_results(
  p_game_id uuid, p_team_a_score smallint, p_team_b_score smallint, p_performances jsonb
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_game   public.games;
  v_perf   jsonb := coalesce(p_performances, '[]'::jsonb);
  v_fields text[];
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
  if jsonb_typeof(v_perf) <> 'array'
     or exists (select 1 from jsonb_array_elements(v_perf) e
                where jsonb_typeof(e) <> 'object'
                   or not exists (select 1 from public.game_players gp
                                  where gp.game_id = p_game_id and gp.player_id::text = e ->> 'player_id')
                   or (e ? 'goals'   and coalesce(e ->> 'goals', '')   !~ '^[0-9]{1,3}$')
                   or (e ? 'assists' and coalesce(e ->> 'assists', '') !~ '^[0-9]{1,3}$')
                   or (e ? 'points'  and coalesce(e ->> 'points', '')  !~ '^[0-9]{1,3}$'))
     or (select count(distinct e ->> 'player_id') from jsonb_array_elements(v_perf) e) <> jsonb_array_length(v_perf) then
    raise exception 'VALIDATION';
  end if;

  select s.stat_fields into v_fields from public.sports s where s.slug = v_game.sport_slug;

  insert into public.game_results (game_id, team_a_score, team_b_score, status, submitted_by)
  values (p_game_id, p_team_a_score, p_team_b_score, 'pending', v_uid)
  on conflict (game_id) do update
    set team_a_score = excluded.team_a_score, team_b_score = excluded.team_b_score, status = 'pending',
        submitted_by = excluded.submitted_by, submitted_at = now(), confirmed_by = null, confirmed_at = null,
        dispute_reason = null, revision = public.game_results.revision + 1;

  delete from public.player_game_stats pgs where pgs.game_id = p_game_id;
  insert into public.player_game_stats (game_id, player_id, team, outcome, goals, assists, points)
  select p_game_id, gp.player_id, gp.team,
         case when p_team_a_score = p_team_b_score then 'draw'
              when (gp.team = 'A') = (p_team_a_score > p_team_b_score) then 'win'
              else 'loss' end,
         case when 'goals'   = any (v_fields) then coalesce((e ->> 'goals')::smallint, 0)   else 0 end,
         case when 'assists' = any (v_fields) then coalesce((e ->> 'assists')::smallint, 0) else 0 end,
         case when 'points'  = any (v_fields) then coalesce((e ->> 'points')::smallint, 0)  else 0 end
  from public.game_players gp
  left join jsonb_array_elements(v_perf) e on e ->> 'player_id' = gp.player_id::text
  where gp.game_id = p_game_id;

  update public.games g set status = 'completed' where g.id = p_game_id;
  update public.invitations i set status = 'expired', responded_at = now()
  where i.game_id = p_game_id and i.status = 'pending';
  update public.join_requests jr set status = 'cancelled', responded_at = now()
  where jr.game_id = p_game_id and jr.status = 'pending';

  perform private.notify(gp.player_id, 'results_submitted', 'Confirm the result: ' || v_game.title,
    format('Team A %s – %s Team B. Confirm or dispute it.', p_team_a_score, p_team_b_score), p_game_id)
  from public.game_players gp where gp.game_id = p_game_id and gp.player_id <> v_uid;
  return 'pending';
end $$;

create or replace function public.confirm_results(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_res   public.game_results;
  v_game  public.games;
  v_p     uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_res from public.game_results r where r.game_id = p_game_id for update;
  if not found then raise exception 'RESULT_NOT_PENDING'; end if;
  if v_res.submitted_by = v_uid
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  if v_res.status = 'final' then return 'final'; end if;
  if v_res.status <> 'pending' then raise exception 'RESULT_NOT_PENDING'; end if;

  update public.game_results r set status = 'final', confirmed_by = v_uid, confirmed_at = now()
  where r.game_id = p_game_id;

  perform private.notify(gp.player_id, 'results_confirmed', 'Results are final: ' || v_game.title,
    'Stats updated. You can now review the other players.', p_game_id)
  from public.game_players gp where gp.game_id = p_game_id;

  for v_p in select gp.player_id from public.game_players gp where gp.game_id = p_game_id loop
    perform private.recalc_level(v_p, v_game.sport_slug);
  end loop;
  return 'final';
end $$;

create or replace function public.dispute_results(p_game_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_res  public.game_results;
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 300 then raise exception 'VALIDATION'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_res from public.game_results r where r.game_id = p_game_id for update;
  if not found then raise exception 'RESULT_NOT_PENDING'; end if;
  if v_res.submitted_by = v_uid
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  if v_res.status <> 'pending' then raise exception 'RESULT_NOT_PENDING'; end if;

  update public.game_results r set status = 'disputed', dispute_reason = btrim(p_reason) where r.game_id = p_game_id;
  perform private.notify(v_res.submitted_by, 'results_disputed', 'Result disputed: ' || v_game.title,
    btrim(p_reason), p_game_id);
  return 'disputed';
end $$;

-- =====================================================================
-- Reviews: skill + sportsmanship, anonymous, drives levels
-- =====================================================================
drop function public.submit_review(uuid, uuid, smallint, text);

create function public.submit_review(
  p_game_id uuid, p_reviewee_id uuid, p_rating smallint, p_comment text, p_skill_rating smallint default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
  v_id   uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_rating is null or p_rating not between 1 and 5
     or (p_skill_rating is not null and p_skill_rating not between 1 and 5)
     or char_length(coalesce(p_comment, '')) > 500 then
    raise exception 'VALIDATION';
  end if;

  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'NOT_ELIGIBLE'; end if;
  if p_reviewee_id is null or p_reviewee_id = v_uid
     or not exists (select 1 from public.game_results r where r.game_id = p_game_id and r.status = 'final')
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid)
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = p_reviewee_id) then
    raise exception 'NOT_ELIGIBLE';
  end if;
  if exists (select 1 from public.reviews rv
             where rv.game_id = p_game_id and rv.reviewer_id = v_uid and rv.reviewee_id = p_reviewee_id) then
    raise exception 'ALREADY_REVIEWED';
  end if;

  insert into public.reviews (game_id, reviewer_id, reviewee_id, rating, skill_rating, comment, sport_slug)
  values (p_game_id, v_uid, p_reviewee_id, p_rating, p_skill_rating, coalesce(p_comment, ''), v_game.sport_slug)
  returning id into v_id;

  if p_skill_rating is not null then
    perform private.recalc_level(p_reviewee_id, v_game.sport_slug);
  end if;
  return v_id;
end $$;

-- =====================================================================
-- Chat + notifications
-- =====================================================================
create function public.send_game_message(p_game_id uuid, p_body text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
  v_id   uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id;
  if not found or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  if v_game.status = 'cancelled' then raise exception 'GAME_UNAVAILABLE'; end if;
  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000 then raise exception 'VALIDATION'; end if;

  insert into public.game_messages (game_id, sender_id, body) values (p_game_id, v_uid, btrim(p_body))
  returning id into v_id;
  -- your own message shouldn't light up your "new" dot
  insert into public.game_chat_reads (game_id, player_id, last_read_at) values (p_game_id, v_uid, now())
  on conflict (game_id, player_id) do update set last_read_at = excluded.last_read_at;
  return v_id;
end $$;

create function public.mark_chat_read(p_game_id uuid) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  insert into public.game_chat_reads (game_id, player_id, last_read_at) values (p_game_id, v_uid, now())
  on conflict (game_id, player_id) do update set last_read_at = excluded.last_read_at;
  return now();
end $$;

create function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  update public.notifications n set read_at = now()
  where n.user_id = v_uid and n.read_at is null and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- =====================================================================
-- Permissions
-- =====================================================================
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;

-- private: only the helpers that RLS policies / invoker functions need
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_game_organizer(uuid), private.is_game_player(uuid),
                         private.has_pending_invitation(uuid), private.can_view_game(uuid),
                         private.distance_miles(float8, float8, float8, float8)
  to authenticated;
