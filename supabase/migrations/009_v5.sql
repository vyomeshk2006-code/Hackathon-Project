-- =====================================================================
-- Pickup Sports Tampa — 009: v5 (docs/database-contract-v5-proposal.md)
--   1. Usernames (unique, case-insensitive, set once) + area note
--   2. Private phone numbers + get_game_contacts (roster only, until the game ends)
--   3. Username search
--   4. Remove game chat
--   5. Venue address, game end time (duration), automatic expiration from Browse
--   6. browse_games without location; my_game_history
--   7. Results: winner required, scores + stats optional; results_needed reminders
-- Run after 001–008.
-- =====================================================================

-- =====================================================================
-- Neighborhoods: 10 more Tampa areas (centers only used for alerts / player search)
-- =====================================================================
update public.neighborhoods set name = 'USF Area' where slug = 'usf';
insert into public.neighborhoods (slug, name, lat, lng) values
  ('ybor-city',      'Ybor City',         27.9600, -82.4370),
  ('hyde-park',      'Hyde Park',         27.9380, -82.4790),
  ('westshore',      'Westshore',         27.9550, -82.5250),
  ('carrollwood',    'Carrollwood',       28.0500, -82.4920),
  ('new-tampa',      'New Tampa',         28.1290, -82.3540),
  ('temple-terrace', 'Temple Terrace',    28.0350, -82.3890),
  ('brandon',        'Brandon',           27.9378, -82.2859),
  ('westchase',      'Westchase',         28.0680, -82.6100),
  ('town-n-country', 'Town ''n'' Country', 28.0100, -82.5780),
  ('riverview',      'Riverview',         27.8660, -82.3260)
on conflict (slug) do nothing;

-- =====================================================================
-- Profiles: username + area note; phone numbers in a private table
-- =====================================================================
alter table public.profiles
  add column username  text check (username ~ '^[a-z0-9_]{3,20}$'),          -- stored lowercase, no '@'
  add column area_note text not null default '' check (char_length(area_note) <= 80);
create unique index profiles_username_key on public.profiles (username);   -- values are lowercase, so case-insensitive

create table public.private_contacts (
  user_id    uuid primary key references public.profiles (id) on delete cascade,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  updated_at timestamptz not null default now()
);

-- (813) 555-0142 → +18135550142 ; +44 20 7946 0958 → +442079460958 ; invalid → null
create function private.normalize_phone(p_raw text) returns text
language sql immutable set search_path = '' as $$
  select case
    when x.digits = '' then null
    when x.plus and ('+' || x.digits) ~ '^\+[1-9][0-9]{7,14}$' then '+' || x.digits
    when not x.plus and length(x.digits) = 10 and x.digits ~ '^[2-9]' then '+1' || x.digits
    when not x.plus and length(x.digits) = 11 and x.digits ~ '^1[2-9]' then '+' || x.digits
    else null end
  from (select btrim(coalesce(p_raw, '')) like '+%' as plus,
               regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') as digits) x
$$;

-- Demo accounts (if present) get their handle as username and a fictional 555 number.
update public.profiles p set username = split_part(u.email, '@', 1)
from auth.users u
where u.id = p.id and u.email like '%@demo.pickuptampa.test' and p.username is null
  and split_part(u.email, '@', 1) ~ '^[a-z0-9_]{3,20}$';
insert into public.private_contacts (user_id, phone_e164)
select p.id, '+1813555' || lpad((100 + row_number() over (order by p.username))::text, 4, '0')
from public.profiles p
join auth.users u on u.id = p.id
where u.email like '%@demo.pickuptampa.test'
on conflict (user_id) do nothing;

-- =====================================================================
-- Remove game chat
-- =====================================================================
do $$
begin
  if exists (select 1 from pg_publication_tables
             where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'game_messages') then
    alter publication supabase_realtime drop table public.game_messages;
  end if;
end $$;
drop function public.send_game_message(uuid, text);
drop function public.mark_chat_read(uuid);
drop view public.my_game_chat_status;
drop table public.game_chat_reads;
drop table public.game_messages;

-- =====================================================================
-- Games: venue address, end time, results reminder marker
-- =====================================================================
alter table public.games
  add column venue_address text check (char_length(venue_address) <= 200),
  add column ends_at timestamptz,
  add column results_reminder_sent_at timestamptz;
update public.games set ends_at = starts_at + interval '2 hours';
alter table public.games alter column ends_at set not null;
alter table public.games add constraint games_ends_after_start check (ends_at > starts_at);
create index games_active_idx on public.games (status, ends_at);

-- Default end = start + 2 h; moving the start keeps the duration.
create function private.games_default_end() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.ends_at is null then new.ends_at := new.starts_at + interval '2 hours'; end if;
  elsif new.starts_at is distinct from old.starts_at and new.ends_at = old.ends_at then
    new.ends_at := new.starts_at + (old.ends_at - old.starts_at);
  end if;
  return new;
end $$;
create trigger games_default_end before insert or update on public.games
  for each row execute function private.games_default_end();

-- =====================================================================
-- Results: winner required, scores optional
-- =====================================================================
alter table public.game_results
  add column winner text check (winner in ('A', 'B', 'draw')),
  alter column team_a_score drop not null,
  alter column team_b_score drop not null;
update public.game_results
set winner = case when team_a_score = team_b_score then 'draw' when team_a_score > team_b_score then 'A' else 'B' end;
alter table public.game_results alter column winner set not null;

-- =====================================================================
-- Security
-- =====================================================================
revoke all on public.private_contacts from anon, authenticated;
grant select on public.private_contacts to authenticated;
alter table public.private_contacts enable row level security;
create policy "private_contacts: own row only" on public.private_contacts for select to authenticated
  using (user_id = (select auth.uid()));

-- Discovery: scheduled games stay visible to everyone until they END (ongoing games included).
create or replace function private.can_view_game(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and ((g.status = 'scheduled' and g.ends_at > now())
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
-- save_profile: username (set once), phone, area note
-- =====================================================================
drop function public.save_profile(text, text, smallint, text, jsonb, boolean, boolean);

create function public.save_profile(
  p_display_name text, p_neighborhood text, p_travel_radius_miles smallint, p_bio text, p_sports jsonb,
  p_replacement_alerts boolean default null, p_new_game_alerts boolean default null,
  p_username text default null, p_phone text default null, p_area_note text default null
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_uid      uuid := auth.uid();
  v_name     text := btrim(coalesce(p_display_name, ''));
  v_existing public.profiles;
  v_user     text;
  v_phone    text;
  v_e        jsonb;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_existing from public.profiles p where p.id = v_uid;

  if char_length(v_name) not between 1 and 60
     or not exists (select 1 from public.neighborhoods n where n.slug = p_neighborhood)
     or p_travel_radius_miles is null or p_travel_radius_miles not between 1 and 50
     or char_length(coalesce(p_bio, '')) > 300
     or char_length(btrim(coalesce(p_area_note, ''))) > 80
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

  -- username: lowercase, no '@'; required for a new profile; can't be changed once set
  if p_username is not null then
    v_user := lower(ltrim(btrim(p_username), '@'));
    if v_user !~ '^[a-z0-9_]{3,20}$' then raise exception 'VALIDATION'; end if;
    if v_existing.username is not null and v_existing.username <> v_user then raise exception 'USERNAME_LOCKED'; end if;
    if exists (select 1 from public.profiles p where p.username = v_user and p.id <> v_uid) then
      raise exception 'USERNAME_TAKEN';
    end if;
  end if;
  -- phone: required for a new profile
  if p_phone is not null then
    v_phone := private.normalize_phone(p_phone);
    if v_phone is null then raise exception 'VALIDATION'; end if;
  end if;
  if v_existing.id is null and (v_user is null or v_phone is null) then raise exception 'VALIDATION'; end if;

  if exists (select 1 from jsonb_array_elements(p_sports) e
             join private.skill_scores ss on ss.player_id = v_uid and ss.sport_slug = e ->> 'sport_slug'
             where ss.verified and ss.level <> e ->> 'skill_level') then
    raise exception 'LEVEL_LOCKED';
  end if;

  begin
    insert into public.profiles (id, display_name, neighborhood, travel_radius_miles, bio,
                                 replacement_alerts, new_game_alerts, username, area_note)
    values (v_uid, v_name, p_neighborhood, p_travel_radius_miles, coalesce(p_bio, ''),
            coalesce(p_replacement_alerts, true), coalesce(p_new_game_alerts, false),
            v_user, btrim(coalesce(p_area_note, '')))
    on conflict (id) do update
      set display_name        = excluded.display_name,
          neighborhood        = excluded.neighborhood,
          travel_radius_miles = excluded.travel_radius_miles,
          bio                 = excluded.bio,
          replacement_alerts  = coalesce(p_replacement_alerts, public.profiles.replacement_alerts),
          new_game_alerts     = coalesce(p_new_game_alerts,    public.profiles.new_game_alerts),
          username            = coalesce(public.profiles.username, excluded.username),
          area_note           = case when p_area_note is null then public.profiles.area_note
                                     else excluded.area_note end;
  exception when unique_violation then
    raise exception 'USERNAME_TAKEN';     -- two people claimed the same name at the same moment
  end;

  if v_phone is not null then
    insert into public.private_contacts (user_id, phone_e164) values (v_uid, v_phone)
    on conflict (user_id) do update set phone_e164 = excluded.phone_e164, updated_at = now();
  end if;

  delete from public.user_sports us where us.user_id = v_uid;
  insert into public.user_sports (user_id, sport_slug, skill_level, level_source, rating_count)
  select v_uid, e ->> 'sport_slug',
         case when ss.verified then ss.level else e ->> 'skill_level' end,
         case when ss.verified then 'verified' else 'self' end,
         coalesce(ss.rating_count, 0)
  from jsonb_array_elements(p_sports) e
  left join private.skill_scores ss on ss.player_id = v_uid and ss.sport_slug = e ->> 'sport_slug';

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
-- Username search (no phone numbers, ever)
-- =====================================================================
create function public.search_players_by_username(p_query text, p_limit int default 20)
returns table (
  id uuid, username text, display_name text, neighborhood text, neighborhood_name text, area_note text,
  sports jsonb, avg_rating numeric, review_count int
)
language plpgsql stable set search_path = '' as $$
#variable_conflict use_column
declare
  v_q text := lower(ltrim(btrim(coalesce(p_query, '')), '@'));
begin
  if auth.uid() is null then raise exception 'FORBIDDEN'; end if;
  if v_q !~ '^[a-z0-9_]{2,20}$' or p_limit is null or p_limit not between 1 and 50 then raise exception 'VALIDATION'; end if;

  return query
  select p.id, p.username, p.display_name, p.neighborhood, n.name, p.area_note,
         coalesce((select jsonb_agg(jsonb_build_object('sport_slug', us.sport_slug, 'skill_level', us.skill_level,
                                                       'level_source', us.level_source) order by us.sport_slug)
                   from public.user_sports us where us.user_id = p.id), '[]'::jsonb),
         r.avg_rating, coalesce(r.review_count, 0)
  from public.profiles p
  join public.neighborhoods n on n.slug = p.neighborhood
  left join public.player_ratings r on r.player_id = p.id
  where p.username is not null and starts_with(p.username, v_q)
  order by (p.username = v_q) desc, p.username
  limit p_limit;
end $$;

-- =====================================================================
-- Game contacts: organizer + confirmed roster, only until the game ends
-- =====================================================================
create function public.get_game_contacts(p_game_id uuid)
returns table (player_id uuid, display_name text, username text, phone_e164 text, is_organizer boolean)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid  uuid := auth.uid();
  v_game public.games;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id;
  if not found
     or not exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.player_id = v_uid) then
    raise exception 'FORBIDDEN';           -- browsing, pending, declined, withdrawn, removed, invited-not-accepted
  end if;
  if v_game.status <> 'scheduled' or now() >= v_game.ends_at then raise exception 'CONTACTS_CLOSED'; end if;

  return query
  select gp.player_id, p.display_name, p.username, c.phone_e164, gp.player_id = v_game.organizer_id
  from public.game_players gp
  join public.profiles p          on p.id = gp.player_id
  join public.private_contacts c  on c.user_id = gp.player_id
  where gp.game_id = p_game_id
  order by (gp.player_id = v_game.organizer_id) desc, p.display_name;
end $$;

-- =====================================================================
-- create_game: + venue address + duration
-- =====================================================================
drop function public.create_game(text, text, text, text, timestamptz, smallint, text, text[], smallint, text);

create function public.create_game(
  p_sport_slug text, p_title text, p_venue text, p_neighborhood text, p_starts_at timestamptz, p_max_players smallint,
  p_join_mode text default 'invite_only', p_skill_levels text[] default null, p_team_size smallint default null,
  p_description text default null, p_venue_address text default null, p_duration_minutes smallint default 120
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
     or char_length(btrim(coalesce(p_venue_address, ''))) > 200
     or char_length(btrim(coalesce(p_description, ''))) > 500
     or p_duration_minutes is null or p_duration_minutes not between 30 and 480
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

  insert into public.games (organizer_id, sport_slug, title, description, venue, venue_address, neighborhood,
                            starts_at, ends_at, max_players, join_mode, skill_levels, team_size)
  values (v_uid, p_sport_slug, btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), btrim(p_venue),
          nullif(btrim(coalesce(p_venue_address, '')), ''), p_neighborhood,
          p_starts_at, p_starts_at + make_interval(mins => p_duration_minutes),
          p_max_players, p_join_mode, p_skill_levels, p_team_size)
  returning id into v_id;

  insert into public.game_players (game_id, player_id) values (v_id, v_uid);

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

-- =====================================================================
-- browse_games: no location; active until ends_at; filters + pagination
-- =====================================================================
drop function public.browse_games(text, text, date, date, boolean);

create function public.browse_games(
  p_sport_query text default null, p_from date default null, p_to date default null,
  p_join_mode text default null, p_only_open_spots boolean default false,
  p_limit int default 50, p_offset int default 0
) returns table (
  id uuid, title text, description text, sport_slug text, sport_name text, venue text, venue_address text,
  starts_at timestamptz, ends_at timestamptz, is_ongoing boolean,
  max_players smallint, team_size smallint, join_mode text, skill_levels text[],
  organizer_id uuid, organizer_name text, organizer_username text, player_count int, spots_left int,
  is_member boolean, can_join boolean, can_request boolean, has_pending_request boolean
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_q   text := nullif(lower(btrim(coalesce(p_sport_query, ''))), '');
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if (p_join_mode is not null and p_join_mode not in ('open', 'invite_only'))
     or p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then
    raise exception 'VALIDATION';
  end if;

  return query
  with base as (
    select g.id as gid, g.title as gtitle, g.description as gdesc, g.sport_slug as gsport, s.name as gsportname,
           g.venue as gvenue, g.venue_address as gaddr, g.starts_at as gstart, g.ends_at as gend,
           g.max_players as gmax, g.team_size as gteam, g.join_mode as gmode, g.skill_levels as glevels,
           g.organizer_id as gorg,
           (select count(*) from public.game_players gp where gp.game_id = g.id)::int as pc,
           exists (select 1 from public.game_players gp where gp.game_id = g.id and gp.player_id = v_uid) as mem,
           (select us.skill_level from public.user_sports us where us.user_id = v_uid and us.sport_slug = g.sport_slug) as my_level,
           exists (select 1 from public.join_requests jr
                   where jr.game_id = g.id and jr.player_id = v_uid and jr.status = 'pending') as req
    from public.games g
    join public.sports s on s.slug = g.sport_slug
    where g.status = 'scheduled' and g.ends_at > now()
      and (v_q is null or position(v_q in s.slug) > 0 or position(v_q in s.normalized_name) > 0)
      and (p_join_mode is null or g.join_mode = p_join_mode)
      and (p_from is null or (g.starts_at at time zone 'America/New_York')::date >= p_from)
      and (p_to   is null or (g.starts_at at time zone 'America/New_York')::date <= p_to)
  )
  select b.gid, b.gtitle, b.gdesc, b.gsport, b.gsportname, b.gvenue, b.gaddr, b.gstart, b.gend,
         b.gstart <= now(),
         b.gmax, b.gteam, b.gmode, b.glevels, b.gorg, p.display_name, p.username, b.pc, (b.gmax - b.pc)::int,
         b.mem,
         coalesce(b.gstart > now() and b.gmode = 'open' and not b.mem and b.gmax > b.pc and b.my_level is not null
                  and (b.glevels is null or b.my_level = any (b.glevels)), false),
         coalesce(b.gstart > now() and b.gmode = 'invite_only' and not b.mem and b.gmax > b.pc and not b.req
                  and b.my_level is not null and (b.glevels is null or b.my_level = any (b.glevels)), false),
         b.req
  from base b
  join public.profiles p on p.id = b.gorg
  where (not coalesce(p_only_open_spots, false) or b.gmax > b.pc)
  order by b.gstart, b.gid
  limit p_limit offset p_offset;
end $$;

-- =====================================================================
-- Results reminders + game history
-- =====================================================================
-- One results_needed notification per ended game without a result (optionally for one organizer).
create function private.send_results_reminders(p_organizer uuid default null) returns int
language plpgsql security definer set search_path = '' as $$
declare
  v_count int;
begin
  with due as (
    update public.games g set results_reminder_sent_at = now()
    where g.status = 'scheduled' and g.ends_at <= now() and g.results_reminder_sent_at is null
      and not exists (select 1 from public.game_results r where r.game_id = g.id)
      and (p_organizer is null or g.organizer_id = p_organizer)
    returning g.id, g.organizer_id, g.title
  )
  insert into public.notifications (user_id, type, title, body, game_id)
  select d.organizer_id, 'results_needed', 'Add the result: ' || d.title,
         'Who won? Team A, Team B or a draw. Scores and stats are optional.', d.id
  from due d;
  get diagnostics v_count = row_count;
  return v_count;
end $$;

create function public.my_game_history(p_limit int default 50, p_offset int default 0)
returns table (
  id uuid, title text, sport_slug text, venue text, venue_address text, starts_at timestamptz, ends_at timestamptz,
  status text, is_organizer boolean, my_team text, winner text, team_a_score smallint, team_b_score smallint,
  result_status text, needs_result boolean
)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  if p_limit is null or p_limit not between 1 and 100 or p_offset is null or p_offset < 0 then raise exception 'VALIDATION'; end if;
  perform private.send_results_reminders(v_uid);    -- fallback for projects without pg_cron

  return query
  select g.id, g.title, g.sport_slug, g.venue, g.venue_address, g.starts_at, g.ends_at, g.status,
         g.organizer_id = v_uid, gp.team, r.winner, r.team_a_score, r.team_b_score, r.status,
         (g.organizer_id = v_uid and g.status <> 'cancelled' and g.ends_at <= now() and r.game_id is null)
  from public.game_players gp
  join public.games g on g.id = gp.game_id
  left join public.game_results r on r.game_id = g.id
  where gp.player_id = v_uid
    and (g.status in ('completed', 'cancelled') or g.ends_at <= now())
  order by g.starts_at desc, g.id
  limit p_limit offset p_offset;
end $$;

-- Run the reminders every 10 minutes where pg_cron is available (Supabase). Optional.
do $$
begin
  create extension if not exists pg_cron;
  perform cron.schedule('pickup-results-reminders', '*/10 * * * *', 'select private.send_results_reminders()');
exception when others then
  raise notice 'pg_cron not available (%). results_needed reminders will be sent when organizers open their history.', sqlerrm;
end $$;

-- =====================================================================
-- submit_results: winner required (A / B / draw); scores + stats optional
-- =====================================================================
drop function public.submit_results(uuid, smallint, smallint, jsonb);

create function public.submit_results(
  p_game_id uuid, p_team_a_score smallint default null, p_team_b_score smallint default null,
  p_performances jsonb default '[]', p_winner text default null
) returns text
language plpgsql security definer set search_path = '' as $$
declare
  v_uid    uuid := auth.uid();
  v_game   public.games;
  v_perf   jsonb := coalesce(p_performances, '[]'::jsonb);
  v_winner text;
  v_p      uuid;
begin
  if v_uid is null then raise exception 'FORBIDDEN'; end if;
  select * into v_game from public.games g where g.id = p_game_id for update;
  if not found or v_game.organizer_id <> v_uid then raise exception 'FORBIDDEN'; end if;
  if v_game.status = 'cancelled' then raise exception 'GAME_UNAVAILABLE'; end if;
  if (v_game.starts_at at time zone 'America/New_York')::date > (now() at time zone 'America/New_York')::date then
    raise exception 'RESULTS_TOO_EARLY';
  end if;

  -- winner: given, or derived from both scores; must agree when both are given
  if (p_winner is not null and p_winner not in ('A', 'B', 'draw'))
     or ((p_team_a_score is null) <> (p_team_b_score is null))
     or (p_team_a_score is not null and (p_team_a_score not between 0 and 999 or p_team_b_score not between 0 and 999)) then
    raise exception 'VALIDATION';
  end if;
  if p_team_a_score is not null then
    v_winner := case when p_team_a_score = p_team_b_score then 'draw'
                     when p_team_a_score > p_team_b_score then 'A' else 'B' end;
    if p_winner is not null and p_winner <> v_winner then raise exception 'VALIDATION'; end if;
  else
    v_winner := p_winner;
  end if;
  if v_winner is null then raise exception 'VALIDATION'; end if;

  if exists (select 1 from public.game_players gp where gp.game_id = p_game_id and gp.team is null)
     or (select count(distinct gp.team) from public.game_players gp where gp.game_id = p_game_id) < 2 then
    raise exception 'TEAMS_INCOMPLETE';
  end if;

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
             where d.stat_key is null
                or coalesce(_m.raw, '') !~ '^[0-9]{1,5}$'
                or _m.raw::int > d.max_value)
     or exists (select 1 from _m group by player_id, stat_key having count(*) > 1) then
    raise exception 'VALIDATION';
  end if;

  insert into public.game_results (game_id, team_a_score, team_b_score, winner, status, submitted_by)
  values (p_game_id, p_team_a_score, p_team_b_score, v_winner, 'pending', v_uid)
  on conflict (game_id) do update
    set team_a_score = excluded.team_a_score, team_b_score = excluded.team_b_score, winner = excluded.winner,
        status = 'pending', submitted_by = excluded.submitted_by, submitted_at = now(),
        confirmed_by = null, confirmed_at = null, dispute_reason = null,
        revision = public.game_results.revision + 1;

  delete from public.player_game_stats pgs where pgs.game_id = p_game_id;

  insert into public.player_game_stats (game_id, player_id, team, outcome, goals, assists, points)
  select p_game_id, gp.player_id, gp.team,
         case when v_winner = 'draw' then 'draw' when gp.team = v_winner then 'win' else 'loss' end,
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'goals'), 0),
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'assists'), 0),
         coalesce((select m.raw::int from _m m where m.player_id = gp.player_id and m.stat_key = 'points'), 0)
  from public.game_players gp
  where gp.game_id = p_game_id;

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
    case when p_team_a_score is not null
         then format('Team A %s – %s Team B. Confirm or dispute it.', p_team_a_score, p_team_b_score)
         when v_winner = 'draw' then 'Recorded as a draw. Confirm or dispute it.'
         else 'Team ' || v_winner || ' won. Confirm or dispute it.' end,
    p_game_id)
  from public.game_players gp where gp.game_id = p_game_id and gp.player_id <> v_uid;

  for v_p in select gp.player_id from public.game_players gp where gp.game_id = p_game_id loop
    perform private.recalc_level(v_p, v_game.sport_slug);
  end loop;
  return 'pending';
end $$;

-- ---------- Permissions ----------
revoke execute on all functions in schema public from public, anon;
grant  execute on all functions in schema public to authenticated;
revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_game_organizer(uuid), private.is_game_player(uuid),
                         private.has_pending_invitation(uuid), private.can_view_game(uuid),
                         private.distance_miles(float8, float8, float8, float8)
  to authenticated;
