# Pickup Sports Tampa database contract — v3

**Status: APPROVED and implemented** (`supabase/migrations/005`–`007`). Extends v2 (`database-contract-v2.md`).

v3 almost entirely **adds** to v2. New RPC arguments are optional with defaults that reproduce v2 behavior. There is **one breaking change**: to keep reviews anonymous, the frontend must read reviews from the new `public_reviews` view instead of selecting `reviews` (and its `reviewer_id`) directly. Nothing here is implemented on the backend yet, so the frontend should build these features against its mock adapter first.

## Summary of additions

| # | Feature | What's new |
| --- | --- | --- |
| 1 | Game types | `games.join_mode` (`open` / `invite_only`) and `games.skill_levels` (one, several, or all levels). Open games can be browsed and joined. Invite-only games are visible to players of the chosen levels, who can request to join. |
| 2 | Team size | `games.team_size`. The organizer picks e.g. 5 for 5v5, and `max_players` = 2 × `team_size`. Teams can't exceed it. |
| 3 | Invite to a team | `invitations.team`. The organizer can invite a player straight onto Team A or B. |
| 4 | Join requests | `join_requests` table. Players can ask to join an invite-only game, and the organizer approves or declines. |
| 5 | Withdraw | `withdraw_from_game`. The organizer is always notified. |
| 6 | Emergency replacement | A withdrawal within 60 minutes of kickoff alerts eligible nearby players. Only alerted players can claim the spot, and the first claim wins. |
| 7 | New-game alerts | Opted-in players get notified about new games they're eligible for near them. |
| 8 | Notifications | `notifications` table, created **only** by backend functions. Live updates via Realtime. |
| 9 | Game chat | `game_messages` table, roster only, plus a simple "new messages" dot. |
| 10 | Alert settings | Two profile checkboxes: replacement alerts (default **on**) and new-game alerts (default **off**). |
| 11 | Peer-rated skill levels | Players pick a starting level per sport. After games, every other participant (teammate or opponent) anonymously rates their **skill** and **sportsmanship** (1–5) with an optional comment. The level then moves based on **skill ratings (50%), game stats (30%), and win rate (20%)**; pickleball uses 60% ratings and 40% win rate. |
| 12 | Bulk and squad invites | The organizer can invite several players at once, or a whole saved **squad**, onto a team. Each player still accepts individually. |
| 13 | Daily creation limit | Each user can create at most **2 games per day**. |
| 14 | No substitutes | Every roster spot is a playing spot: no bench, no waitlist. |

## Decisions (agreed by the backend owner)

1. **The organizer picks the allowed levels:** any one (e.g. intermediate only), any combination (e.g. intermediate + advanced), or all three. A player matches if their `user_sports.skill_level` for the game's sport is **in** `games.skill_levels`. Levels are matched exactly: picking only "intermediate" excludes advanced players.
2. **Invite-only visibility:** a game is visible to the organizer, roster, pending invitees, and replacement-alert recipients (as in v2), **plus** players whose level in that sport is in `games.skill_levels`. Picking all three levels makes it visible to everyone who plays the sport. If `skill_levels` is null (only possible from a v2-style `create_game` call), only the v2 members can see it.
3. **Open games** are visible to every authenticated user. Only players whose level is in `skill_levels` can **join** (null or all three = anyone who plays the sport), but everyone can still see the game.
4. **The organizer may invite anyone** who plays the sport, including players outside the chosen levels. The levels only limit self-service joining and requests.
5. **Rosters are visible** to everyone who can see the game: name, team, skill level, and stats (via the existing public profile/stats views).
6. **Team on invitation** is allowed for all invitations and is optional.
7. **No substitutes, ever.** Every roster spot is a playing spot and there is no bench or waitlist. `max_players` is the number of people who play. When `team_size` is set, `max_players` must equal `2 × team_size`. A replacement only happens through withdraw and claim, which frees and refills a spot.
8. **Daily creation limit:** each user can create at most **2 games per day**, counted by when the game was **created** (not when it's played), using the America/New_York calendar day. Cancelled games still count, so creating and cancelling can't get around the limit. A third attempt raises `DAILY_LIMIT_REACHED`.
9. **Chat** is roster only. Withdrawn players lose both read and send access. Chat messages do **not** create notifications; the "new messages" dot covers that.
10. **Not included:** exact unread counts, a full notification-settings page, push or email notifications, squad-vs-squad challenges through a captain.
11. **Two ratings per review.** Skill (drives level) and sportsmanship (shown as reputation) are separate, so a friendly beginner isn't promoted and a skilled but rude player isn't demoted. Sportsmanship never affects level. Level combines skill ratings, game stats, and win rate, with win rate weighted lowest in team sports because it depends on teammates (see "How levels are calculated").
12. **Reviews are anonymous.** The reviewer is stored (needed for eligibility and duplicate checks) but never readable by other users, and reviews are shown without game or date. In very small games (e.g. 1v1 pickleball) the reviewer can still be guessed; this is an accepted limit.
13. **Levels lock once verified.** A player can change their level for a sport freely until it's verified by ratings; after that only ratings change it. A newly added sport starts self-rated again.
14. **Squads** are per sport, joined only with the captain's join code (nobody is added without consent), up to 25 members. Inviting a squad creates one normal invitation per eligible member.
15. **Bulk and squad invites send what they can.** Invalid recipients are skipped and reported back; they don't block the rest.

## Table changes

| Table | Change |
| --- | --- |
| `profiles` | Add `replacement_alerts boolean not null default true`, `new_game_alerts boolean not null default false` |
| `games` | Add `join_mode text not null default 'invite_only'` (`open`, `invite_only`), `skill_levels text[]` (nullable; a non-empty set of `beginner`/`intermediate`/`advanced` with no duplicates; see decisions 1–3 for null), `team_size smallint` (nullable, 1–25; if set, `max_players = 2 * team_size`) |
| `invitations` | Add `team text` (nullable, `A`/`B`), `squad_id uuid` (nullable; set when sent through `invite_squad`) |
| `user_sports` | Add `level_source text not null default 'self'` (`self`, `verified`), `rating_count smallint not null default 0`. `skill_level` keeps its meaning: the player's **current** level. |
| `reviews` | `rating` now means the **sportsmanship** rating (so v2 `player_ratings` keeps working). Add `skill_rating smallint` (1–5; required for new reviews) and `sport_slug text` (the game's sport, set by the backend). **Breaking:** other users can no longer select `reviews` directly or see `reviewer_id`; read the `public_reviews` view instead. |

## New tables

| Table | Columns and rules |
| --- | --- |
| `join_requests` | `id uuid pk`, `game_id uuid → games on delete cascade`, `player_id uuid → profiles`, `status text default 'pending'` (`pending`, `approved`, `declined`, `cancelled`), `created_at`, `responded_at` (nullable). Partial unique `(game_id, player_id) where status = 'pending'`. |
| `game_withdrawals` | `id uuid pk`, `game_id uuid → games on delete cascade`, `player_id uuid → profiles`, `team text` (the team they left, nullable), `withdrawn_at timestamptz default now()`, `last_minute boolean` (true if within 60 minutes of kickoff) |
| `replacement_alerts` | `id uuid pk`, `game_id`, `withdrawal_id uuid → game_withdrawals unique` (one alert per withdrawal), `open_team text` (nullable), `created_at` |
| `replacement_alert_recipients` | `alert_id uuid → replacement_alerts`, `game_id uuid`, `player_id uuid`. Unique `(game_id, player_id)`, so a player is alerted at most once per game. |
| `notifications` | `id uuid pk`, `user_id uuid → profiles on delete cascade`, `type text`, `title text`, `body text default ''`, `game_id uuid` (nullable), `invitation_id uuid` (nullable), `join_request_id uuid` (nullable), `data jsonb default '{}'`, `read_at timestamptz` (nullable), `created_at`. Index `(user_id, created_at desc)`. |
| `game_messages` | `id uuid pk`, `game_id uuid → games on delete cascade`, `sender_id uuid → profiles`, `body text` (1–1000 trimmed), `created_at`. Index `(game_id, created_at)`. |
| `game_chat_reads` | `game_id`, `player_id`, `last_read_at timestamptz`. Primary key `(game_id, player_id)`. |
| `squads` | `id uuid pk`, `name text` (1–40 trimmed), `sport_slug text → sports`, `captain_id uuid → profiles`, `join_code text unique` (8 characters, generated by the backend), `created_at` |
| `squad_members` | `squad_id uuid → squads on delete cascade`, `player_id uuid → profiles on delete cascade`, `joined_at`. Primary key `(squad_id, player_id)`. The captain is always a member. |
| `private.skill_scores` | **Internal, not exposed:** `player_id`, `sport_slug`, `score numeric(3,2)` (1.00–5.00), `updated_at`. The hidden number behind each level. |

### How levels are calculated

Each player has a hidden **score from 1.00 to 5.00 per sport**, built from three parts. Everything is per sport and uses **final** results only.

**1. Starting score** (from the self-chosen level, the middle of each band)

| Chosen level | Starting score |
| --- | --- |
| Beginner | 1.5 |
| Intermediate | 3.0 |
| Advanced | 4.5 |

**2. Three part-scores, each on a 1–5 scale**

| Part | How it's calculated |
| --- | --- |
| ⭐ **Ratings (R)** | Average of the skill ratings received in this sport. Only each rater's **latest** rating counts, so one person can't dominate. With 5 or more raters, the single highest and lowest are dropped. |
| 📊 **Stats (S)** | For each game, the player's **contribution** is ranked against everyone else in **that same game**. Top = 5, bottom = 1, evenly spaced in between, ties share the average. S is the average across games. Games where every contribution is 0 (e.g. no stats entered) are skipped. Not used for pickleball. |
| 🏆 **Win rate (W)** | win share = (wins + 0.5 × draws + 2) ÷ (games + 4); W = 1 + 4 × win share. The "+2 / +4" acts like 2 pretend wins and 2 pretend losses, so a lucky early streak doesn't count as 100%. |

**Contribution per sport** (used for S):

| Sport | Contribution | Why |
| --- | --- | --- |
| ⚽ Soccer | goals + 0.75 × assists | Goals matter most, assists still count |
| 🏀 Basketball | points + 1.5 × assists | Assists are worth fewer points, so they're weighted up |
| 🏐 Volleyball | points | The only stat tracked |
| 🏓 Pickleball | (none) | Points are won by the side, not an individual, so pickleball uses win rate instead |

**3. Weights**

| Sport | Ratings | Stats | Win rate |
| --- | --- | --- | --- |
| Soccer, basketball, volleyball | **50%** | **30%** | **20%** |
| Pickleball | **60%** | — | **40%** |

Ratings lead because they capture what stats miss (defending, goalkeeping, setting, positioning). Stats are an objective check against friends inflating each other. Win rate counts least in team sports because it depends on teammates; in pickleball (1–2 per side) it mostly reflects the player. If a part has no data yet (e.g. no ratings), its weight is shared proportionally among the other parts.

**performance P** = weighted average of R, S, W

**final score** = (3 × starting score + n × P) ÷ (3 + n), where n = number of final games played in this sport. The self-chosen level counts like 3 games; after 10 games, real performance dominates.

**4. Score → level**

| Final score | Level |
| --- | --- |
| 1.00 – 2.32 | 🟢 Beginner |
| 2.33 – 3.66 | 🟡 Intermediate |
| 3.67 – 5.00 | 🔴 Advanced |

To stop levels flip-flopping, a change needs a **0.25 margin** past the boundary:

| Change | Happens at |
| --- | --- |
| Beginner → Intermediate | score ≥ 2.58 |
| Intermediate → Beginner | score ≤ 2.08 |
| Intermediate → Advanced | score ≥ 3.92 |
| Advanced → Intermediate | score ≤ 3.42 |

**5. Verification.** A level only changes automatically once the player has skill ratings from at least **3 different raters across at least 2 games** (`level_source` becomes `verified`). Before that, the score is still tracked, but the self-chosen level stays and can be edited.

**6. When it's recalculated.** For the reviewee in `submit_review`, and for every roster player when `confirm_results` makes a result final. If the level changes, the player gets a `level_changed` notification ("Your soccer level is now Advanced").

**Example:** Sam starts intermediate (3.0) and plays 6 soccer games. Ratings average R = 4.2, stats S = 3.8, and 5 wins of 6 gives W = 1 + 4 × (7 ÷ 10) = 3.8.
- P = 0.5 × 4.2 + 0.3 × 3.8 + 0.2 × 3.8 = **4.00**
- Final = (3 × 3.0 + 6 × 4.00) ÷ 9 = **3.67**

That's inside the buffer (below 3.92), so Sam stays intermediate. A couple more strong games move him to advanced.

**7. Rating guide shown on the review form** (so everyone rates skill the same way)

| Stars | Meaning |
| --- | --- |
| ⭐ 1 | Still learning the basics |
| ⭐⭐ 2 | Knows the basics, makes frequent mistakes |
| ⭐⭐⭐ 3 | Solid, consistent player |
| ⭐⭐⭐⭐ 4 | Strong player, makes a real difference |
| ⭐⭐⭐⭐⭐ 5 | Stands out, among the best in the game |

## Reads and access (RLS)

| Read | Who |
| --- | --- |
| `games`, `game_players` | v2 members **plus**: everyone for `open` games; level-matched players for `invite_only` games with `skill_levels`; replacement-alert recipients for that game |
| `join_requests` | The requesting player and the game's organizer |
| `notifications` | Owner only. Clients can't insert; marking as read goes through an RPC. |
| `game_messages` | Current roster only (organizer included) |
| `game_chat_reads` | Owner only |
| `game_withdrawals`, `replacement_alerts`, `replacement_alert_recipients` | Not readable by clients (internal) |
| `reviews` (base table) | Only reviews the caller **wrote** (so the UI knows who it has already reviewed). Everyone else uses `public_reviews`. |
| `squads`, `squad_members` | Any authenticated user can read names, sport, captain, and members. `join_code` is readable only by squad members (via `my_squads`). |

New view **`my_game_chat_status`** (caller's games only): `game_id`, `last_message_at`, `last_read_at`, `has_new` (boolean). This drives the "new messages" dot.

New view **`public_reviews`**: `id`, `reviewee_id`, `sport_slug`, `rating` (sportsmanship), `skill_rating`, `comment`. **No** reviewer, game, or date, which keeps reviews anonymous.

New view **`my_squads`** (caller's squads only): `id`, `name`, `sport_slug`, `captain_id`, `join_code`, `member_count`, `is_captain`.

New view **`my_game_quota`** (one row for the caller): `games_created_today`, `games_left_today` (0–2), `resets_at` (next midnight America/New_York).

`player_ratings` keeps its v2 shape (`avg_rating` = average sportsmanship).

## RPC changes (all optional, so v2 calls still work)

| Function | Change |
| --- | --- |
| `save_profile(..., p_replacement_alerts boolean default null, p_new_game_alerts boolean default null)` | Null means keep the current value (defaults on first save: `true` / `false`). |
| `create_game(..., p_join_mode text default 'invite_only', p_skill_levels text[] default null, p_team_size smallint default null)` | `p_skill_levels` must be a non-empty set of valid levels with no duplicates, or null (`VALIDATION`). v3 clients always send it, e.g. `['intermediate','advanced']`, or all three for "All levels". If `p_team_size` is set, `p_max_players` must equal `2 × p_team_size`, otherwise `VALIDATION`. Enforces the **daily creation limit** (below). After creating the game, sends **new-game alerts** (see below). |
| `send_invitation(p_game_id, p_recipient_id, p_team text default null)` | Stores the team on the invitation. If a pending invite already exists, it returns that ID unchanged. Skill level is **not** enforced on invites. |
| `respond_to_invitation` | On accept with a team: if that team already has `team_size` players, raise `TEAM_FULL` and the invite stays pending. Otherwise the player joins on that team. |
| `set_team` | Raises `TEAM_FULL` if the target team is at `team_size`. |
| `auto_assign_teams` | Never puts more than `team_size` on a team. Balances using each player's hidden level **score** for the sport (more precise than the 3 levels), instead of v2's skill-level + win-rate ordering. |
| `confirm_results` | After a result becomes final, recalculates the level score of every roster player for the game's sport (stats and win rate just changed). |
| `save_profile` (levels) | A sport whose `level_source` is `verified` can't have its `skill_level` changed: raise `LEVEL_LOCKED`. Removing and re-adding a sport doesn't reset it; the verified level is kept. A brand-new sport starts `self`. |
| `submit_review(p_game_id, p_reviewee_id, p_rating, p_comment, p_skill_rating smallint default null)` | `p_rating` is sportsmanship. `p_skill_rating` (1–5) is required for v3 clients; if null (a v2 client), the review only counts toward sportsmanship. After inserting, recalculates the reviewee's level for the game's sport. |

## New RPCs

All are `authenticated` only, take the actor from `auth.uid()`, lock the game row first, and use the v2 error codes plus `TEAM_FULL`.

| Function and arguments | Return and rules |
| --- | --- |
| `browse_games(p_sport_slug text default null, p_neighborhood text default null, p_from date default null, p_to date default null, p_only_open_spots boolean default true)` | Scheduled future games the caller can see under the rules above. Returns `id, title, sport_slug, venue, neighborhood, starts_at, max_players, team_size, join_mode, skill_levels, organizer_id, organizer_name, player_count, spots_left, distance_miles` (from the caller's neighborhood), `is_member, can_join, can_request, has_pending_request`. Ordered by `starts_at`. |
| `join_game(p_game_id uuid)` | **Open games only** (`invite_only` → `FORBIDDEN`). Scheduled and future (else `GAME_UNAVAILABLE`). The caller plays the sport and their level is in `skill_levels` when set (else `NOT_ELIGIBLE`), and the game isn't full (else `GAME_FULL`). Joins with no team. If the caller had a pending invitation, it's marked `accepted`. Idempotent: returns `joined` if already on the roster. Notifies the organizer (`player_joined`). |
| `request_to_join(p_game_id uuid)` | **Invite-only games** the caller can see by level (else `FORBIDDEN`). The caller isn't on the roster, the game is scheduled, future, and not full. Returns the request UUID, or the existing pending request's ID. Notifies the organizer (`join_request_received`). |
| `cancel_join_request(p_request_id uuid)` | Requester only, pending only. Returns `cancelled`. |
| `respond_to_join_request(p_request_id uuid, p_response text, p_team text default null)` | Organizer only. `p_response` is `approved` or `declined`. Approving checks capacity (`GAME_FULL`) and team size (`TEAM_FULL`), then adds the player to the roster on `p_team`. Identical retry returns the same status. Notifies the player. |
| `withdraw_from_game(p_game_id uuid)` | Roster player, **not the organizer** (organizer → `FORBIDDEN`, use `cancel_game`). Scheduled game that hasn't started (else `GAME_UNAVAILABLE`). Removes the roster row, records a `game_withdrawals` row, and notifies the organizer (`player_withdrew`). If kickoff is **within 60 minutes**, it also creates a replacement alert (below). Returns `withdrawn`. Calling again when no longer on the roster returns `withdrawn` with no new events. |
| `claim_replacement_spot(p_game_id uuid)` | Caller must be a recipient of a replacement alert for this game (else `NOT_ELIGIBLE`). Scheduled game that hasn't started (`GAME_UNAVAILABLE`), and not full (`GAME_FULL`; with two simultaneous claims, exactly one wins). Joins on the alert's `open_team` if that team has room, otherwise with no team. Idempotent if already on the roster. Notifies the organizer (`replacement_joined`). Returns `joined`. |
| `send_game_message(p_game_id uuid, p_body text)` | Roster only (else `FORBIDDEN`), game not cancelled (`GAME_UNAVAILABLE`), body 1–1000 trimmed (`VALIDATION`). Returns the message UUID. |
| `mark_chat_read(p_game_id uuid)` | Roster only. Sets `last_read_at = now()` and returns it. |
| `mark_notifications_read(p_ids uuid[] default null)` | Marks the caller's notifications as read (all of them if null). Returns the count updated. |
| `send_invitations(p_game_id uuid, p_recipient_ids uuid[], p_team text default null)` | **Bulk invite.** Same rules as `send_invitation` for each recipient. Organizer, game, and team-size checks happen once, and an invalid game or caller fails the whole call. Returns `[{ recipient_id, invitation_id, error }]`: `invitation_id` is set if sent (or already pending), and `error` holds the code if that recipient was skipped (e.g. `VALIDATION`, `INVITATION_CLOSED`). Up to 25 recipients. |
| `create_squad(p_name text, p_sport_slug text)` | Caller must play the sport. Returns `{ id, join_code }`, and the caller becomes captain and first member. |
| `join_squad(p_join_code text)` | Caller must play the squad's sport, and the squad must have fewer than 25 members (`VALIDATION` otherwise; `FORBIDDEN` for an unknown code). Idempotent. Returns the squad UUID and notifies the captain (`squad_member_joined`). |
| `leave_squad(p_squad_id uuid)` | Member, not the captain (the captain uses `delete_squad`). Returns `left`. |
| `remove_squad_member(p_squad_id uuid, p_player_id uuid)` | Captain only. Returns `removed`. |
| `delete_squad(p_squad_id uuid)` | Captain only. Returns `deleted`. Invitations already sent stay valid. |
| `invite_squad(p_game_id uuid, p_squad_id uuid, p_team text default null)` | Organizer of the game (any game type). The squad's sport must match the game (`VALIDATION`). Calls the bulk-invite logic for every member except the organizer and players already on the roster, storing `squad_id` on each invitation. Same return shape as `send_invitations`. |

### Emergency replacement rules

Triggered only by `withdraw_from_game` when `now() >= starts_at - 60 minutes` and `now() < starts_at`.

The alert goes to players who meet **all** of these:
- play the game's sport
- have `replacement_alerts = true`
- the game's neighborhood is within their travel radius
- have a level in the game's `skill_levels`, if set
- aren't the organizer, aren't on the roster, and aren't the withdrawing player
- haven't already been alerted for this game

Each gets a `replacement_needed` notification linking to the game. The alert doesn't reserve a spot; `claim_replacement_spot` does, and the game lock makes sure only one claimer gets the last spot. The organizer's **Find Replacement** button uses v2 `search_players` (with `p_game_id`) plus `send_invitation`, so it needs no new RPC.

### New-game alerts

Sent by `create_game` only for games that are visible beyond their members: `open` games, or `invite_only` games with `skill_levels`.

The alert goes to players who meet **all** of these:
- have `new_game_alerts = true`
- play the sport
- the game's neighborhood is within their travel radius
- are allowed to see the game (level-matched for invite-only)
- aren't the organizer

Each gets one `new_game_nearby` notification.

## Notification types

| Type | Sent to | Created by |
| --- | --- | --- |
| `invitation_received` | Recipient | `send_invitation` |
| `invitation_accepted` / `invitation_declined` | Organizer | `respond_to_invitation` |
| `invitation_cancelled` | Recipient | `cancel_invitation` |
| `join_request_received` | Organizer | `request_to_join` |
| `join_request_approved` / `join_request_declined` | Player | `respond_to_join_request` |
| `player_joined` | Organizer | `join_game` |
| `player_withdrew` | Organizer | `withdraw_from_game` |
| `replacement_needed` | Eligible nearby players | `withdraw_from_game` (last 60 min) |
| `replacement_joined` | Organizer | `claim_replacement_spot` |
| `new_game_nearby` | Opted-in eligible players | `create_game` |
| `game_cancelled` | Roster (except organizer) and pending invitees | `cancel_game` |
| `results_submitted` | Roster (except submitter) | `submit_results` |
| `results_confirmed` | Roster | `confirm_results` |
| `results_disputed` | Organizer | `dispute_results` |
| `level_changed` | The player | `submit_review` or `confirm_results` (when a recalculation changes their level) |
| `squad_member_joined` | Squad captain | `join_squad` |

Invitations sent through `invite_squad` use the normal `invitation_received` type, with the squad name in `data.squad_name`.

Every notification has `title`, `body`, and `game_id`, plus `invitation_id` or `join_request_id` where relevant, so the UI can link straight to the right screen.

## Realtime

Supabase Realtime is enabled on `notifications` (filter `user_id=eq.<me>`) and `game_messages` (filter `game_id=eq.<game>`). RLS still applies, so users only receive rows they're allowed to read.

## New error codes

| Code | Meaning |
| --- | --- |
| `TEAM_FULL` | The chosen team already has `team_size` players |
| `LEVEL_LOCKED` | Tried to change a level that has been verified by ratings |
| `DAILY_LIMIT_REACHED` | The user already created 2 games today (America/New_York) |

`NOT_ELIGIBLE` is reused for joining or requesting without the right sport or level, and for claiming a spot without a replacement alert.

## What the frontend should add (for Codex)

1. **Create game form:** game type (Open / Invite-only); allowed levels as checkboxes (Beginner / Intermediate / Advanced, plus an "All levels" shortcut that ticks all three; at least one must be ticked); team size (optional; when set, show max players as 2 × team size, read-only). Show how many games the user has left to create today, and handle `DAILY_LIMIT_REACHED`.
2. **Browse games page:** uses `browse_games`, with filters for sport, neighborhood, date, and open spots. Each card shows a Join, Request to join, or Joined button based on `can_join` / `can_request` / `is_member`.
3. **Game details:** roster grouped by team with each player's level and stats. Organizer controls: invite (with a team picker), approve or decline join requests, set teams, auto-assign, Find Replacement, cancel game.
4. **Withdraw button** for roster players (not the organizer), with a confirmation dialog. If kickoff is under 60 minutes away, the dialog says nearby players will be alerted.
5. **Replacement alert:** the notification opens the game, which shows a **Claim spot** button. Handle `GAME_FULL` ("Someone else got the spot").
6. **Notification center:** bell with an unread count (`read_at is null`), a list, mark as read, and tapping a notification navigates via `game_id` / `invitation_id` / `join_request_id`. Subscribe with Realtime.
7. **Game chat** in game details (roster only): message list, input, Realtime subscription, `mark_chat_read` on open, and a dot from `my_game_chat_status.has_new`.
8. **Profile settings:** two checkboxes, "Emergency replacement alerts" (on) and "New games near me" (off).
9. **Error mapping:** add `TEAM_FULL`, `LEVEL_LOCKED`, and `DAILY_LIMIT_REACHED`.
10. **Review form** (after a result is final): for each other participant, teammates and opponents alike, a **Skill** 1–5 rating (show the star guide from "How levels are calculated"), a **Sportsmanship** 1–5 rating, and an optional comment. Say clearly that reviews are anonymous. Read the caller's own `reviews` rows to show who's already been reviewed.
11. **Profile levels:** next to each sport, show the level plus a **"Self-rated"** or **"Verified by N players"** badge (`level_source`, `rating_count`). Disable the level picker for verified sports. Show reviews from `public_reviews` with no names or dates, plus avg sportsmanship from `player_ratings`.
12. **Multi-select invite:** in search results, check several players → choose a team → "Invite selected" (`send_invitations`). Show who was skipped and why.
13. **Squads page:** create a squad, show its join code to members, join with a code, list members, leave, remove a member (captain), delete (captain).
14. **Invite a squad:** in game details, the organizer picks a squad for the game's sport plus a team → `invite_squad`, then shows sent/skipped.

## Milestone 3 (integration check)

Two real accounts:
- The organizer creates an open 2v2 game starting in 45 minutes.
- The player joins, then withdraws.
- The organizer gets `player_withdrew`, and a third account (eligible, opted in) gets `replacement_needed`, claims the spot, and lands on the withdrawn player's team.
- A fourth claimer gets `GAME_FULL`.
- Chat is readable by the roster and blocked for the withdrawn player.
- An invite-only intermediate game is visible to an intermediate player, who requests to join and is approved, and hidden from a beginner.
- A captain creates a soccer squad, two players join with the code, and the organizer invites the squad to Team B. Each member gets an invitation, and an accepting member lands on Team B.
- A self-rated **beginner** soccer player plays 2 games, wins both, is the top scorer in each, and gets skill 5 from 3 different raters. R = 5, S = 5, W = 1 + 4 × (4 ÷ 6) = 3.67, so P = 4.73 and final = (3 × 1.5 + 2 × 4.73) ÷ 5 = 2.79 ≥ 2.58. Their level becomes **intermediate** and shows "Verified", they get `level_changed`, and they can no longer change that level themselves. Nobody can see who rated them.
- An open game set to intermediate + advanced: intermediate and advanced players can join, and a beginner gets `NOT_ELIGIBLE`. An invite-only game set to advanced only is hidden from intermediate players.
- A user creates 2 games and cancels one; a third `create_game` the same day fails with `DAILY_LIMIT_REACHED`, and `my_game_quota` shows 0 left.
