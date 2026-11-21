-- =====================================================================
-- Pickup Sports Tampa — 002: grants + Row Level Security
--
-- * Tables are READ-ONLY to clients. Every write goes through the RPC
--   functions in 003, which check auth.uid() themselves.
-- * RLS decides which rows each user can read.
-- * Membership helpers live in the `private` schema, which the Supabase API
--   does not expose. They are security definer so policies never recurse.
-- =====================================================================

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;   -- needed so RLS policies can call the helpers

create function private.is_game_organizer(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.games g where g.id = p_game and g.organizer_id = auth.uid())
$$;

create function private.is_game_player(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.game_players gp where gp.game_id = p_game and gp.player_id = auth.uid())
$$;

create function private.has_pending_invitation(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.invitations i
                 where i.game_id = p_game and i.recipient_id = auth.uid() and i.status = 'pending')
$$;

create function private.can_view_game(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_game_organizer(p_game) or private.is_game_player(p_game) or private.has_pending_invitation(p_game)
$$;

-- Great-circle distance in miles (used by search_players).
create function private.distance_miles(lat1 float8, lng1 float8, lat2 float8, lng2 float8)
returns float8 language sql immutable set search_path = '' as $$
  select 3958.8 * 2 * asin(sqrt(
    power(sin(radians(lat2 - lat1) / 2), 2) +
    cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)
  ))
$$;

revoke execute on all functions in schema private from public, anon;
grant  execute on all functions in schema private to authenticated;

-- ---------- Grants: read-only tables ----------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

grant select on public.neighborhoods, public.sports to anon, authenticated;
grant select on public.profiles, public.user_sports, public.games, public.game_players,
                public.invitations, public.game_results, public.player_game_stats, public.reviews
  to authenticated;
grant select on public.player_sport_stats, public.player_stats, public.player_ratings to authenticated;

-- ---------- RLS ----------
alter table public.neighborhoods     enable row level security;
alter table public.sports            enable row level security;
alter table public.profiles          enable row level security;
alter table public.user_sports       enable row level security;
alter table public.games             enable row level security;
alter table public.game_players      enable row level security;
alter table public.invitations       enable row level security;
alter table public.game_results      enable row level security;
alter table public.player_game_stats enable row level security;
alter table public.reviews           enable row level security;

create policy "reference: neighborhoods" on public.neighborhoods for select to anon, authenticated using (true);
create policy "reference: sports"        on public.sports        for select to anon, authenticated using (true);

-- Public profile columns (no email or address is stored here).
create policy "profiles: authenticated read"    on public.profiles    for select to authenticated using (true);
create policy "user_sports: authenticated read" on public.user_sports for select to authenticated using (true);

-- Organizer, roster players, and recipients of pending invitations.
create policy "games: members read" on public.games for select to authenticated
  using (private.can_view_game(id));
create policy "game_players: members read" on public.game_players for select to authenticated
  using (private.can_view_game(game_id));

-- Organizer and recipient.
create policy "invitations: organizer or recipient" on public.invitations for select to authenticated
  using (recipient_id = (select auth.uid()) or sender_id = (select auth.uid()) or private.is_game_organizer(game_id));

-- Roster players (the organizer is always on the roster).
create policy "game_results: roster read" on public.game_results for select to authenticated
  using (private.is_game_player(game_id));
create policy "player_game_stats: roster read" on public.player_game_stats for select to authenticated
  using (private.is_game_player(game_id));

-- Reviews are public on profiles.
create policy "reviews: authenticated read" on public.reviews for select to authenticated using (true);
