-- =====================================================================
-- Pickup Sports Tampa — 006: v3 grants + Row Level Security
-- Same model as 002: clients only READ; every write is an RPC in 007.
-- =====================================================================

-- ---------- Who can see a game (replaces the v2 helper) ----------
-- v2 members (organizer, roster, pending invitee)
-- + everyone for open games
-- + level-matched players for invite-only games with skill_levels
-- + players alerted for an emergency replacement in this game
create or replace function private.can_view_game(p_game uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.games g
    where g.id = p_game
      and (g.organizer_id = auth.uid()
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

-- valid_skill_levels is only used by a constraint.
revoke execute on function private.valid_skill_levels(text[]) from public, anon, authenticated;

-- ---------- Grants (read-only) ----------
-- Supabase auto-grants ALL on new public tables/views to anon + authenticated.
-- Remove that first, then grant only reads.
revoke all on public.squads, public.squad_members, public.join_requests, public.game_withdrawals,
              public.replacement_alerts, public.replacement_alert_recipients, public.notifications,
              public.game_messages, public.game_chat_reads,
              public.public_reviews, public.my_game_chat_status, public.my_squads, public.my_game_quota
  from anon, authenticated;

grant select on public.join_requests, public.notifications, public.game_messages,
                public.game_chat_reads, public.squad_members to authenticated;
-- squads: every column except join_code (members get it from my_squads)
grant select (id, name, sport_slug, captain_id, created_at) on public.squads to authenticated;
grant select on public.public_reviews, public.my_game_chat_status, public.my_squads, public.my_game_quota to authenticated;
-- game_withdrawals, replacement_alerts, replacement_alert_recipients: internal, no grants.

-- ---------- RLS ----------
alter table public.squads                       enable row level security;
alter table public.squad_members                enable row level security;
alter table public.join_requests                enable row level security;
alter table public.game_withdrawals             enable row level security;
alter table public.replacement_alerts           enable row level security;
alter table public.replacement_alert_recipients enable row level security;
alter table public.notifications                enable row level security;
alter table public.game_messages                enable row level security;
alter table public.game_chat_reads              enable row level security;
alter table private.skill_scores                enable row level security;

create policy "squads: authenticated read"        on public.squads        for select to authenticated using (true);
create policy "squad_members: authenticated read" on public.squad_members for select to authenticated using (true);

create policy "join_requests: requester or organizer" on public.join_requests for select to authenticated
  using (player_id = (select auth.uid()) or private.is_game_organizer(game_id));

create policy "notifications: owner" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- Current roster only: a withdrawn player loses read access too.
create policy "game_messages: roster" on public.game_messages for select to authenticated
  using (private.is_game_player(game_id));

create policy "game_chat_reads: owner" on public.game_chat_reads for select to authenticated
  using (player_id = (select auth.uid()));

-- Reviews are anonymous: the base table only shows reviews you WROTE.
-- Everyone reads public_reviews instead (breaking change from v2).
drop policy "reviews: authenticated read" on public.reviews;
create policy "reviews: own written" on public.reviews for select to authenticated
  using (reviewer_id = (select auth.uid()));

-- ---------- Realtime ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.notifications, public.game_messages;
  end if;
end $$;
