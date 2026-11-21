-- =====================================================================
-- Pickup Sports Tampa — DEMO DATA (optional; run after ALL migrations 001–007)
--
-- Demo accounts all use emails ending in @demo.pickuptampa.test and the
-- password  demo1234.  Remove everything demo with:
--   delete from auth.users where email like '%@demo.pickuptampa.test';
-- (profiles, games, results and reviews cascade from there)
-- =====================================================================

-- ---------- Demo accounts + profiles ----------
do $$
declare
  r     record;
  v_uid uuid;
begin
  for r in
    select * from (values
      ('marcus', 'Marcus Rivera',  'south-tampa',      12, 'Runs Saturday soccer. Box-to-box midfielder.'),
      ('aisha',  'Aisha Thompson', 'seminole-heights', 10, 'Fast winger, beach volleyball on weekends.'),
      ('daniel', 'Daniel Nguyen',  'usf',              15, 'USF grad student. Center back.'),
      ('sofia',  'Sofia Martinez', 'west-tampa',       10, 'Keeper. Will dive on any surface.'),
      ('jordan', 'Jordan Brooks',  'downtown',          8, 'Point guard. Runs Sunday hoops downtown.'),
      ('priya',  'Priya Patel',    'usf',              20, 'Pickleball regular, learning volleyball.'),
      ('tyler',  'Tyler Johnson',  'seminole-heights', 12, 'Hoops and volleyball, always down for a game.'),
      ('camila', 'Camila Torres',  'downtown',         10, 'Striker. Played club soccer in Colombia.'),
      ('kevin',  'Kevin O''Brien', 'south-tampa',       8, 'Weekend defender, weekday dad.'),
      ('lena',   'Lena Fischer',   'other-tampa',      15, 'Setter. Organizes beach volleyball.'),
      ('andre',  'Andre Williams', 'west-tampa',       20, 'Big man in the paint, solid in midfield too.'),
      ('mei',    'Mei Chen',       'other-tampa',      15, 'Pickleball, any level welcome.')
    ) as t(handle, display_name, hood, radius, bio)
  loop
    v_uid := gen_random_uuid();
    insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                            raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                            confirmation_token, recovery_token, email_change_token_new, email_change)
    values ('00000000-0000-0000-0000-000000000000', v_uid, 'authenticated', 'authenticated',
            r.handle || '@demo.pickuptampa.test', crypt('demo1234', gen_salt('bf')), now(),
            '{"provider":"email","providers":["email"]}', '{}', now(), now(), '', '', '', '');
    insert into auth.identities (id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), v_uid::text, v_uid,
            jsonb_build_object('sub', v_uid::text, 'email', r.handle || '@demo.pickuptampa.test', 'email_verified', true),
            'email', now(), now(), now());

    insert into public.profiles (id, display_name, neighborhood, travel_radius_miles, bio)
    values (v_uid, r.display_name, r.hood, r.radius, r.bio);
  end loop;
end $$;

create temp table demo (handle text primary key, id uuid);
insert into demo
select split_part(u.email, '@', 1), u.id from auth.users u where u.email like '%@demo.pickuptampa.test';

insert into public.user_sports (user_id, sport_slug, skill_level)
select d.id, s.sport, s.lvl
from (values
  ('marcus','soccer','advanced'),      ('marcus','basketball','intermediate'),
  ('aisha','soccer','intermediate'),   ('aisha','volleyball','advanced'),
  ('daniel','soccer','advanced'),      ('daniel','basketball','beginner'),
  ('sofia','soccer','intermediate'),   ('sofia','pickleball','intermediate'),
  ('jordan','basketball','advanced'),  ('jordan','soccer','beginner'),
  ('priya','pickleball','advanced'),   ('priya','volleyball','beginner'),
  ('tyler','basketball','intermediate'),('tyler','volleyball','intermediate'),
  ('camila','soccer','advanced'),      ('camila','volleyball','intermediate'),
  ('kevin','soccer','intermediate'),   ('kevin','basketball','beginner'),
  ('lena','volleyball','advanced'),    ('lena','pickleball','beginner'),
  ('andre','basketball','advanced'),   ('andre','soccer','intermediate'),
  ('mei','pickleball','advanced'),     ('mei','volleyball','intermediate')
) as s(handle, sport, lvl)
join demo d on d.handle = s.handle;

-- ---------- Past games with FINAL results (gives profiles real stats) ----------
do $$
declare
  v_game    uuid;
  v_org     uuid;
  v_players uuid[];
  v_sport   text; v_title text; v_venue text; v_hood text;
  v_a int; v_b int;
  i int;
begin
  perform setseed(0.42);
  for i in 1..11 loop
    if i <= 8 then
      v_sport := 'soccer'; v_title := 'Saturday Morning Soccer'; v_venue := 'Al Lopez Park'; v_hood := 'west-tampa';
      select id into v_org from demo where handle = 'marcus';
      select array_agg(id) into v_players from demo where handle in ('aisha','daniel','sofia','jordan','camila','kevin','andre');
    else
      v_sport := 'basketball'; v_title := 'Sunday Hoops'; v_venue := 'Julian B. Lane Riverfront Park'; v_hood := 'downtown';
      select id into v_org from demo where handle = 'jordan';
      select array_agg(id) into v_players from demo where handle in ('marcus','tyler','kevin','andre','daniel');
    end if;

    insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players, status, created_at)
    values (v_org, v_sport, v_title, v_venue, v_hood,
            now() - make_interval(days => 7 * (case when i <= 8 then i else i - 8 end)) - interval '2 hours',
            10, 'completed',
            now() - make_interval(days => 7 * (case when i <= 8 then i else i - 8 end) + 3))   -- created days earlier
    returning id into v_game;

    insert into public.game_players (game_id, player_id) values (v_game, v_org);
    insert into public.game_players (game_id, player_id) select v_game, unnest(v_players);

    update public.game_players gp set team = case when t.rn % 2 = 0 then 'A' else 'B' end
    from (select player_id, row_number() over (order by random()) rn from public.game_players where game_id = v_game) t
    where gp.game_id = v_game and gp.player_id = t.player_id;

    insert into public.game_results (game_id, team_a_score, team_b_score, status, submitted_by, confirmed_by, confirmed_at)
    values (v_game, 0, 0, 'final', v_org, v_players[1], now());

    -- per-player stats; the team score is the sum of its players' goals/points
    insert into public.player_game_stats (game_id, player_id, team, outcome, goals, assists, points)
    select v_game, gp.player_id, gp.team, 'draw',
           case when v_sport = 'soccer'     then floor(random() * 3)::int  else 0 end,
           floor(random() * 2)::int,
           case when v_sport = 'basketball' then floor(random() * 15)::int else 0 end
    from public.game_players gp where gp.game_id = v_game;

    select coalesce(sum(goals + points) filter (where team = 'A'), 0),
           coalesce(sum(goals + points) filter (where team = 'B'), 0)
      into v_a, v_b
    from public.player_game_stats where game_id = v_game;

    update public.game_results set team_a_score = v_a, team_b_score = v_b where game_id = v_game;
    update public.player_game_stats set outcome =
      case when v_a = v_b then 'draw' when (team = 'A') = (v_a > v_b) then 'win' else 'loss' end
    where game_id = v_game;
  end loop;
end $$;

-- A few reviews from the most recent soccer game (rating = sportsmanship, skill_rating = skill)
insert into public.reviews (game_id, reviewer_id, reviewee_id, rating, skill_rating, comment, sport_slug)
select g.id, rv.id, re.id, x.rating, x.skill, x.comment, 'soccer'
from (values
  ('aisha','marcus',5,4,'Great organizer, games always start on time.'),
  ('daniel','camila',5,5,'Clinical finisher.'),
  ('sofia','daniel',4,4,'Solid at the back, good communication.'),
  ('camila','aisha',5,4,'So fast on the wing!'),
  ('kevin','sofia',4,3,'Made some huge saves.'),
  ('andre','marcus',5,4,'Keeps the game fair and fun.')
) as x(reviewer, reviewee, rating, skill, comment)
join demo rv on rv.handle = x.reviewer
join demo re on re.handle = x.reviewee
join lateral (select id from public.games where sport_slug = 'soccer' and status = 'completed'
              and organizer_id = (select id from demo where handle = 'marcus')
              order by starts_at desc limit 1) g on true;

-- ---------- Upcoming games ----------
do $$
declare
  v_sat  timestamptz;
  v_game uuid;
begin
  -- next Saturday 9:00 AM Tampa time, at least a day away
  v_sat := ((date_trunc('week', (now() at time zone 'America/New_York') + interval '2 days') + interval '5 days 9 hours')
            at time zone 'America/New_York');
  if v_sat < now() + interval '1 day' then v_sat := v_sat + interval '7 days'; end if;

  -- All created 2 days ago, so they don't use up anyone's 2-games-per-day limit for the live demo.

  -- The classic problem: 6 players, needs 10. Open 5v5 for intermediate + advanced.
  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size, created_at)
  values ((select id from demo where handle = 'marcus'), 'soccer', 'Saturday Morning Soccer',
          'Al Lopez Park', 'west-tampa', v_sat, 10,
          'open', array['intermediate','advanced'], 5, now() - interval '2 days')
  returning id into v_game;
  insert into public.game_players (game_id, player_id)
  select v_game, id from demo where handle in ('marcus','aisha','daniel','sofia','camila','kevin');

  -- Invite-only 5v5, visible to intermediate + advanced basketball players.
  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size, created_at)
  values ((select id from demo where handle = 'jordan'), 'basketball', 'Sunday Hoops at Riverfront',
          'Julian B. Lane Riverfront Park', 'downtown', v_sat + interval '1 day 9 hours', 10,
          'invite_only', array['intermediate','advanced'], 5, now() - interval '2 days')
  returning id into v_game;
  insert into public.game_players (game_id, player_id)
  select v_game, id from demo where handle in ('jordan','tyler','andre');

  -- Open 4v4, all levels.
  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size, created_at)
  values ((select id from demo where handle = 'lena'), 'volleyball', 'Sunset Beach Volleyball',
          'Ben T. Davis Beach', 'west-tampa', v_sat + interval '7 hours', 8,
          'open', null, 4, now() - interval '2 days')
  returning id into v_game;
  insert into public.game_players (game_id, player_id)
  select v_game, id from demo where handle in ('lena','aisha','camila');

  -- Invite-only doubles for advanced players.
  insert into public.games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players,
                            join_mode, skill_levels, team_size, created_at)
  values ((select id from demo where handle = 'mei'), 'pickleball', 'Pickleball Doubles',
          'USF Recreation Center', 'usf', v_sat + interval '4 days 10 hours', 4,
          'invite_only', array['advanced'], 2, now() - interval '2 days')
  returning id into v_game;
  insert into public.game_players (game_id, player_id)
  select v_game, id from demo where handle in ('mei','priya');
end $$;

-- A demo squad (join code shown to members in my_squads)
do $$
declare v_squad uuid;
begin
  insert into public.squads (name, sport_slug, captain_id, join_code)
  values ('Ybor FC', 'soccer', (select id from demo where handle = 'camila'), 'YBORFC26')
  returning id into v_squad;
  insert into public.squad_members (squad_id, player_id)
  select v_squad, id from demo where handle in ('camila', 'andre', 'jordan');
end $$;

-- Compute hidden level scores for every demo player from the data above
do $$
declare r record;
begin
  for r in select us.user_id, us.sport_slug from public.user_sports us join demo d on d.id = us.user_id loop
    perform private.recalc_level(r.user_id, r.sport_slug);
  end loop;
end $$;

drop table demo;
