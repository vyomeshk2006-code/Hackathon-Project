-- =====================================================================
-- Pickup Sports Tampa — 003: RPC functions (all writes go through these)
--
-- Call from the frontend:  supabase.rpc('function_name', { p_arg: value })
-- Errors are stable codes in error.message:
--   FORBIDDEN, PROFILE_REQUIRED, VALIDATION, GAME_FULL, GAME_UNAVAILABLE,
--   INVITATION_CLOSED, RESULTS_TOO_EARLY, TEAMS_INCOMPLETE,
--   RESULT_NOT_PENDING, NOT_ELIGIBLE, ALREADY_REVIEWED
--
-- Rules every function follows:
--   * the actor is auth.uid(), never an argument
--   * security definer with an empty search_path; every name is schema-qualified
--   * anything touching roster, invitations, teams, results, reviews or game
--     status locks the game row FIRST (same lock order everywhere)
-- =====================================================================

-- ---------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------
create function public.save_profile(
  p_display_name text, p_neighborhood text, p_travel_radius_miles smallint, p_bio text, p_sports jsonb
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := btrim(coalesce(p_display_name, ''));
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;

  if char_length(v_name) not between 1 and 60
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or p_travel_radius_miles is null or p_travel_radius_miles not between 1 and 50
     or char_length(coalesce(p_bio, '')) > 300
     or p_sports is null or jsonb_typeof(p_sports) <> 'array' or jsonb_array_length(p_sports) = 0 then
    raise exception 'VALIDATION';
  end if;

  -- every entry: known sport, valid skill; no duplicate sports
  if exists (select 1 from jsonb_array_elements(p_sports) e
             where jsonb_typeof(e) <> 'object'
                or not exists (select 1 from public.sports s where s.slug = e ->> 'sport_slug')
                or coalesce(e ->> 'skill_level', '') not in ('beginner', 'intermediate', 'advanced'))
     or (select count(distinct e ->> 'sport_slug') from jsonb_array_elements(p_sports) e) <> jsonb_array_length(p_sports) then
    raise exception 'VALIDATION';
  end if;

  insert into public.profiles (id, display_name, neighborhood, travel_radius_miles, bio)
  values (v_uid, v_name, p_neighborhood, p_travel_radius_miles, coalesce(p_bio, ''))
  on conflict (id) do update
    set display_name        = excluded.display_name,
        neighborhood        = excluded.neighborhood,
        travel_radius_miles = excluded.travel_radius_miles,
        bio                 = excluded.bio;

  delete from public.user_sports us where us.user_id = v_uid;
  insert into public.user_sports (user_id, sport_slug, skill_level)
  select v_uid, e ->> 'sport_slug', e ->> 'skill_level' from jsonb_array_elements(p_sports) e;

  return v_uid;
end $$;

-- ---------------------------------------------------------------------
-- Games
-- ---------------------------------------------------------------------
create function public.create_game(
  p_sport_slug text, p_title text, p_venue text, p_neighborhood text, p_starts_at timestamptz, p_max_players smallint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from public.profiles p where p.id = v_uid) then raise exception 'PROFILE_REQUIRED'; end if;

  if not exists (select 1 from public.sports s where s.slug = p_sport_slug)
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or char_length(btrim(coalesce(p_title, ''))) not between 1 and 80
     or char_length(btrim(coalesce(p_venue, ''))) not between 1 and 100
     or p_max_players is null or p_max_players not between 2 and 50
     or p_starts_at is null or p_starts_at <= now() then
    raise exception 'VALIDATION';
  end if;

  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players)
  values (v_uid, p_sport_slug, btrim(p_title), btrim(p_venue), p_neighborhood, p_starts_at, p_max_players)
  returning id into v_id;

  insert into public.game_players (game_id, player_id) values (v_id, v_uid);   -- organizer plays
  return v_id;
end $$;

create function public.cancel_game(p_game_id uuid) returns text
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
  update public.invitations i set status = 'cancelled', responded_at = now()
  where i.game_id = p_game_id and i.status = 'pending';
  return 'cancelled';
end $$;

-- ---------------------------------------------------------------------
-- Invitations
-- ---------------------------------------------------------------------
create function public.send_invitation(p_game_id uuid, p_recipient_id uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid   uuid := auth.uid();
  v_game  public.games;
  v_id    uuid;
  v_count int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;

  -- idempotent: same recipient already has a pending invite
  select i.id into v_id from public.invitations i
  where i.game_id = p_game_id and i.recipient_id = p_recipient_id and i.status = 'pending';
  if found then return v_id; end if;

  -- declined stays declined (cancelled/expired may be re-invited)
  if exists (select 1 from public.invitations i
             where i.game_id = p_game_id and i.recipient_id = p_recipient_id and i.status = 'declined') then
    raise exception 'INVITATION_CLOSED';
  end if;

  if p_recipient_id is null or p_recipient_id = v_uid
     or not exists (select 1 from public.user_sports us
                    where us.user_id = p_recipient_id and us.sport_slug = v_game.sport_slug)
     or exists (select 1 from public.game_players gp
                where gp.game_id = p_game_id and gp.player_id = p_recipient_id) then
    raise exception 'VALIDATION';
  end if;

  select count(*) into v_count from public.game_players gp where gp.game_id = p_game_id;
  if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;

  insert into public.invitations (game_id, sender_id, recipient_id)
  values (p_game_id, v_uid, p_recipient_id)
  returning id into v_id;
  return v_id;
end $$;

create function public.respond_to_invitation(p_invitation_id uuid, p_response text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid     uuid := auth.uid();
  v_game_id uuid;
  v_game    public.games;
  v_inv     public.invitations;
  v_count   int;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_response is null or p_response not in ('accepted', 'declined') then raise exception 'VALIDATION'; end if;

  -- look up the game, lock it FIRST, then lock and re-check the invitation
  select i.game_id into v_game_id from public.invitations i where i.id = p_invitation_id;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = v_game_id for update;
  select * into v_inv  from public.invitations i where i.id = p_invitation_id for update;

  if v_inv.recipient_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_inv.status = p_response then return p_response; end if;          -- identical retry
  if v_inv.status <> 'pending' then raise exception 'INVITATION_CLOSED'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;

  if p_response = 'accepted' then
    select count(*) into v_count from public.game_players gp where gp.game_id = v_game.id;
    if v_count >= v_game.max_players then raise exception 'GAME_FULL'; end if;   -- invite stays pending
    insert into public.game_players (game_id, player_id) values (v_game.id, v_uid);
  end if;

  update public.invitations i set status = p_response, responded_at = now() where i.id = p_invitation_id;
  return p_response;
end $$;

create function public.cancel_invitation(p_invitation_id uuid) returns text
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
  return 'cancelled';
end $$;

-- ---------------------------------------------------------------------
-- Teams
-- ---------------------------------------------------------------------
create function public.set_team(p_game_id uuid, p_player_id uuid, p_team text) returns text
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

  update public.game_players gp set team = p_team
  where gp.game_id = p_game_id and gp.player_id = p_player_id;
  if not found then raise exception 'VALIDATION'; end if;
  return p_team;
end $$;

-- Balanced teams: rank by skill in this sport, then win rate, then snake draft (A B B A A B B A ...).
create function public.auto_assign_teams(p_game_id uuid)
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
             order by case us.skill_level when 'advanced' then 3 when 'intermediate' then 2 when 'beginner' then 1 else 2 end desc,
                      coalesce(st.wins::float8 / nullif(st.games_played, 0), 0.5) desc,
                      random()) as rn
    from public.game_players gp
    left join public.user_sports us        on us.user_id = gp.player_id and us.sport_slug = v_game.sport_slug
    left join public.player_sport_stats st on st.player_id = gp.player_id and st.sport_slug = v_game.sport_slug
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

-- ---------------------------------------------------------------------
-- Results & stats
-- Organizer submits ('pending') -> a different roster player confirms
-- ('final') or disputes ('disputed'). Only 'final' feeds the stats views.
-- ---------------------------------------------------------------------

-- p_performances: [{ "player_id": "...", "goals": 2, "assists": 1, "points": 0 }, ...]
create function public.submit_results(
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

  -- performances: list of objects, roster players only, no duplicates, whole numbers 0-999
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
    set team_a_score   = excluded.team_a_score,
        team_b_score   = excluded.team_b_score,
        status         = 'pending',
        submitted_by   = excluded.submitted_by,
        submitted_at   = now(),
        confirmed_by   = null,
        confirmed_at   = null,
        dispute_reason = null,
        revision       = public.game_results.revision + 1;

  -- replace, never add to, the previous stat rows
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

  return 'pending';
end $$;

create function public.confirm_results(p_game_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_res public.game_results;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  perform 1 from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_res from public.game_results r where r.game_id = p_game_id for update;
  if not found then raise exception 'RESULT_NOT_PENDING'; end if;

  if v_res.submitted_by = v_uid
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  if v_res.status = 'final' then return 'final'; end if;              -- identical retry
  if v_res.status <> 'pending' then raise exception 'RESULT_NOT_PENDING'; end if;

  update public.game_results r set status = 'final', confirmed_by = v_uid, confirmed_at = now()
  where r.game_id = p_game_id;
  return 'final';
end $$;

create function public.dispute_results(p_game_id uuid, p_reason text) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_res public.game_results;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if char_length(btrim(coalesce(p_reason, ''))) not between 1 and 300 then raise exception 'VALIDATION'; end if;
  perform 1 from public.games g where g.id = p_game_id for update;
  if not found then raise exception 'FORBIDDEN'; end if;
  select * into v_res from public.game_results r where r.game_id = p_game_id for update;
  if not found then raise exception 'RESULT_NOT_PENDING'; end if;

  if v_res.submitted_by = v_uid
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;
  if v_res.status <> 'pending' then raise exception 'RESULT_NOT_PENDING'; end if;

  update public.game_results r set status = 'disputed', dispute_reason = btrim(p_reason)
  where r.game_id = p_game_id;
  return 'disputed';
end $$;

-- ---------------------------------------------------------------------
-- Reviews
-- ---------------------------------------------------------------------
create function public.submit_review(
  p_game_id uuid, p_reviewee_id uuid, p_rating smallint, p_comment text
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_rating is null or p_rating not between 1 and 5 or char_length(coalesce(p_comment, '')) > 500 then
    raise exception 'VALIDATION';
  end if;

  perform 1 from public.games g where g.id = p_game_id for update;
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

  insert into public.reviews (game_id, reviewer_id, reviewee_id, rating, comment)
  values (p_game_id, v_uid, p_reviewee_id, p_rating, coalesce(p_comment, ''))
  returning id into v_id;
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Search (read-only; runs with the caller's permissions)
-- Players whose travel radius reaches the target neighborhood.
-- ---------------------------------------------------------------------
create function public.search_players(
  p_sport_slug text, p_neighborhood text, p_skill_level text default null, p_game_id uuid default null
) returns table (
  id uuid, display_name text, neighborhood text, travel_radius_miles smallint, bio text,
  skill_level text, distance_miles numeric, avg_rating numeric, review_count int
)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  if not exists (select 1 from public.sports s where s.slug = p_sport_slug)
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or (p_skill_level is not null and p_skill_level not in ('beginner', 'intermediate', 'advanced')) then
    raise exception 'VALIDATION';
  end if;

  return query
  select p.id, p.display_name, p.neighborhood, p.travel_radius_miles, p.bio, us.skill_level,
         round(private.distance_miles(pn.lat, pn.lng, t.lat, t.lng)::numeric, 1) as dist,
         r.avg_rating, coalesce(r.review_count, 0)
  from public.profiles p
  join public.user_sports us   on us.user_id = p.id and us.sport_slug = p_sport_slug
  join public.neighborhoods pn on pn.slug = p.neighborhood
  join public.neighborhoods t  on t.slug = p_neighborhood
  left join public.player_ratings r on r.player_id = p.id
  where p.id <> auth.uid()
    and (p_skill_level is null or us.skill_level = p_skill_level)
    and private.distance_miles(pn.lat, pn.lng, t.lat, t.lng) <= p.travel_radius_miles
    and (p_game_id is null or (
          not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = p.id)
      and not exists (select 1 from public.invitations i
                      where i.game_id = p_game_id and i.recipient_id = p.id and i.status = 'pending')))
  order by dist, r.avg_rating desc nulls last, p.display_name, p.id;
end $$;

-- ---------- Only logged-in users may call these ----------
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
