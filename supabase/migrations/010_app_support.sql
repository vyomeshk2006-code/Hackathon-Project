-- =====================================================================
-- Pickup Sports Tampa — 010: functions the frontend app needs
--   username_available, set_notification_preferences, edit_game,
--   find_players (directory without radius), game_participation
-- Run after 001–009. Nothing here changes existing tables.
-- =====================================================================

-- Is this username free? (format-checked; your own counts as free)
create function public.username_available(p_username text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_name text := lower(ltrim(btrim(coalesce(p_username, '')), '@'));
begin
  if v_name !~ '^[a-z0-9_]{3,20}$' then raise exception 'VALIDATION'; end if;
  return not exists (select 1 from public.profiles p
                     where p.username = v_name and p.id is distinct from auth.uid());
end $$;

create function public.set_notification_preferences(p_replacement_alerts boolean, p_new_game_alerts boolean)
returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_replacement_alerts is null or p_new_game_alerts is null then raise exception 'VALIDATION'; end if;
  update public.profiles p set replacement_alerts = p_replacement_alerts, new_game_alerts = p_new_game_alerts
  where p.id = v_uid;
  if not found then raise exception 'PROFILE_REQUIRED'; end if;
end $$;

-- Organizer edits title / venue / address / time / description before kickoff.
create function public.edit_game(
  p_game_id uuid, p_title text, p_venue text, p_venue_address text,
  p_starts_at timestamptz, p_ends_at timestamptz, p_description text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status <> 'scheduled' or v_game.starts_at <= now() then raise exception 'GAME_UNAVAILABLE'; end if;
  if char_length(btrim(coalesce(p_title, ''))) not between 1 and 80
     or char_length(btrim(coalesce(p_venue, ''))) not between 1 and 100
     or char_length(btrim(coalesce(p_venue_address, ''))) > 200
     or char_length(btrim(coalesce(p_description, ''))) > 500
     or p_starts_at is null or p_ends_at is null or p_starts_at <= now()
     or p_ends_at - p_starts_at not between interval '30 minutes' and interval '8 hours' then
    raise exception 'VALIDATION';
  end if;

  update public.games g
  set title = btrim(p_title), venue = btrim(p_venue),
      venue_address = nullif(btrim(coalesce(p_venue_address, '')), ''),
      description = nullif(btrim(coalesce(p_description, '')), ''),
      starts_at = p_starts_at, ends_at = p_ends_at
  where g.id = p_game_id;
end $$;

-- Player directory (no distance). Filters: sport, skill, name / username.
-- With p_game_id (organizer only): hides the roster and pending invitees,
-- and with p_replacement also players who withdrew from that game.
create function public.find_players(
  p_sport text default null, p_skill text default null, p_game_id uuid default null,
  p_name text default null, p_replacement boolean default false
) returns table (
  id uuid, username text, display_name text, neighborhood text, neighborhood_name text, area_note text, bio text,
  sports jsonb, avg_rating numeric, review_count int
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_name text := nullif(lower(ltrim(btrim(coalesce(p_name, '')), '@')), '');
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if (p_sport is not null and not exists (select 1 from public.sports s where s.slug = p_sport))
     or (p_skill is not null and p_skill not in ('beginner', 'intermediate', 'advanced')) then
    raise exception 'VALIDATION';
  end if;
  if p_game_id is not null and not exists (select 1 from public.games g where g.id = p_game_id and g.organizer_id = v_uid) then
    raise exception 'FORBIDDEN';
  end if;

  return query
  select p.id, p.username, p.display_name, p.neighborhood, n.name, p.area_note, p.bio,
         coalesce((select jsonb_agg(jsonb_build_object('sport_slug', us.sport_slug, 'skill_level', us.skill_level,
                                                       'level_source', us.level_source, 'rating_count', us.rating_count)
                                    order by us.sport_slug)
                   from public.user_sports us where us.user_id = p.id), '[]'::jsonb),
         r.avg_rating, coalesce(r.review_count, 0)
  from public.profiles p
  join public.neighborhoods n on n.slug = p.neighborhood
  left join public.player_ratings r on r.player_id = p.id
  where p.id <> v_uid
    and ((p_sport is null and p_skill is null) or exists (
          select 1 from public.user_sports us where us.user_id = p.id
            and (p_sport is null or us.sport_slug = p_sport) and (p_skill is null or us.skill_level = p_skill)))
    and (v_name is null or position(v_name in lower(p.display_name)) > 0
         or position(v_name in coalesce(p.username, '')) > 0)
    and (p_game_id is null or (
          not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = p.id)
      and not exists (select 1 from public.invitations i
                      where i.game_id = p_game_id and i.recipient_id = p.id and i.status = 'pending')
      and not (coalesce(p_replacement, false) and exists (
                 select 1 from public.game_withdrawals w where w.game_id = p_game_id and w.player_id = p.id))))
  order by p.display_name, p.id
  limit 200;
end $$;

-- What can the caller do with this game? (also says why not)
create function public.game_participation(p_game_id uuid)
returns table (
  is_member boolean, can_join boolean, can_request boolean, can_claim boolean,
  request_id uuid, invitation_id uuid, ineligible_reason text
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid       uuid := auth.uid();
  v_game      public.games;
  v_member    boolean;
  v_available boolean;
  v_level     text;
  v_reason    text;
  v_request   uuid;
  v_invite    uuid;
  v_eligible  boolean;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id;
  if not found or not private.can_view_game(p_game_id) then return; end if;

  v_member := exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid);
  v_available := v_game.status = 'scheduled' and v_game.starts_at > now() and v_game.ends_at > now() and not v_member
    and (select count(*) from public.game_players gp where gp.game_id = p_game_id) < v_game.max_players;
  select us.skill_level into v_level from public.user_sports us where us.user_id = v_uid and us.sport_slug = v_game.sport_slug;

  if v_level is null then
    v_reason := 'Add this sport to your profile to play in this game.';
  elsif v_game.skill_levels is not null and not (v_level = any (v_game.skill_levels)) then
    v_reason := 'This game is for ' || array_to_string(v_game.skill_levels, ' or ') || ' players.';
  elsif not exists (select 1 from public.private_contacts c where c.user_id = v_uid) then
    v_reason := 'Add a contact phone number in Settings before joining.';
  end if;
  v_eligible := v_available and v_reason is null;

  select jr.id into v_request from public.join_requests jr
  where jr.game_id = p_game_id and jr.player_id = v_uid and jr.status = 'pending';
  select i.id into v_invite from public.invitations i
  where i.game_id = p_game_id and i.recipient_id = v_uid and i.status = 'pending';

  return query select
    v_member,
    v_eligible and v_game.join_mode = 'open',
    v_eligible and v_game.join_mode = 'invite_only' and v_request is null,
    v_eligible and exists (select 1 from public.replacement_alert_recipients rr
                           where rr.game_id = p_game_id and rr.player_id = v_uid),
    v_request, v_invite, v_reason;
end $$;

-- ---------- Permissions ----------
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
grant  execute on function public.username_available(text) to anon;   -- checked during sign-up
