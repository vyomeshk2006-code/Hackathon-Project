# Pickup Sports Tampa MVP database contract — v2

v2 keeps everything from v1 (names, statuses, locking, error codes, RPC style) and fixes the issues below. Frontend code written against v1 keeps working except where marked **breaking**.

## Changes from v1

| # | Change | Why | Breaking? |
| --- | --- | --- | --- |
| 1 | Added results, stats, and reviews (tables, views, RPCs) | Demo steps 7–9 had no contract | No (additions) |
| 2 | Invitations: unique only while `pending`, instead of unique `(game_id, recipient_id)` forever | v1 blocked re-inviting after a cancelled or expired invite. "Declined stays declined" is still enforced, by `send_invitation` | No |
| 3 | Profiles are created only by `save_profile` (no sign-up trigger) | Onboarding is gated on "profile exists". This makes that explicit for both sides | No |
| 4 | `neighborhoods` table with approximate center points; `games.neighborhood`; `search_players` RPC with travel-radius matching | v1 matched only the exact neighborhood, so a Seminole Heights player never saw a Downtown game | No (the v1 exact-filter query still works) |
| 5 | `game_players.team` (nullable `A`/`B`) plus team RPCs | Results need teams | No |
| 6 | Added `cancel_game` and `cancel_invitation` | v1 had `cancelled` statuses but no way to set them | No |
| 7 | Extra error codes | New RPCs | No |
| 8 | Email confirmation **off** for the hackathon project | Demo accounts need no real inbox. Turn it on after the event | Config only |

## Minimum tables

Columns are required unless marked nullable. UUIDs default to `gen_random_uuid()`. Creation timestamps default to `now()`.

| Table | Columns and relationships |
| --- | --- |
| `neighborhoods` **(new)** | `slug text primary key`, `name text unique`, `lat double precision`, `lng double precision`. Seed `downtown`, `seminole-heights`, `south-tampa`, `usf`, `west-tampa`, `other-tampa`. Approximate center points only, never addresses. |
| `profiles` | `id uuid primary key references auth.users(id) on delete cascade`, `display_name text` (1–60 trimmed), `neighborhood text references neighborhoods(slug)`, `travel_radius_miles smallint` (1–50), `bio text` (0–300, default empty), `created_at timestamptz` |
| `sports` | `slug text primary key`, `name text unique`, `stat_fields text[]` **(new)**. Seed `soccer {goals,assists}`, `basketball {points,assists}`, `volleyball {points}`, `pickleball {}`. |
| `user_sports` | `user_id uuid references profiles(id) on delete cascade`, `sport_slug text references sports(slug)`, `skill_level text`. Primary key `(user_id, sport_slug)`. |
| `games` | `id uuid primary key`, `organizer_id uuid references profiles(id)`, `sport_slug text references sports(slug)`, `title text` (1–80), `venue text` (1–100), `neighborhood text references neighborhoods(slug)` **(new)**, `starts_at timestamptz`, `max_players smallint` (2–50), `status text` (default `scheduled`), `created_at timestamptz` |
| `game_players` | `game_id uuid references games(id) on delete cascade`, `player_id uuid references profiles(id)`, `team text` (nullable, `A` or `B`) **(new)**, `joined_at timestamptz`. Primary key `(game_id, player_id)`. |
| `invitations` | `id uuid primary key`, `game_id uuid references games(id) on delete cascade`, `sender_id uuid references profiles(id)`, `recipient_id uuid references profiles(id)`, `status text` (default `pending`), `created_at timestamptz`, `responded_at timestamptz` (nullable). **Changed:** partial unique index on `(game_id, recipient_id) where status = 'pending'`. |
| `game_results` **(new)** | `game_id uuid primary key references games(id) on delete cascade`, `team_a_score smallint` (0–999), `team_b_score smallint` (0–999), `status text` (`pending`, `final`, `disputed`; default `pending`), `submitted_by uuid references profiles(id)`, `submitted_at timestamptz`, `confirmed_by uuid` (nullable), `confirmed_at timestamptz` (nullable), `dispute_reason text` (nullable), `revision smallint` (default 1) |
| `player_game_stats` **(new)** | `game_id uuid references game_results(game_id) on delete cascade`, `player_id uuid references profiles(id)`, `team text` (`A`/`B`), `outcome text` (`win`, `loss`, `draw`), `goals smallint`, `assists smallint`, `points smallint` (all default 0, ≥ 0). Primary key `(game_id, player_id)`. |
| `reviews` **(new)** | `id uuid primary key`, `game_id uuid references games(id) on delete cascade`, `reviewer_id uuid references profiles(id)`, `reviewee_id uuid references profiles(id)`, `rating smallint` (1–5), `comment text` (0–500, default empty), `created_at timestamptz`. Unique `(game_id, reviewer_id, reviewee_id)`; check `reviewer_id <> reviewee_id`. |

Skill values are `beginner`, `intermediate`, `advanced`. Game statuses are `scheduled`, `cancelled`, `completed`. Invitation statuses are `pending`, `accepted`, `declined`, `cancelled`, `expired`. Result statuses are `pending`, `final`, `disputed`. Game scheduling and display use America/New_York. Exchange timestamps as ISO 8601 with an offset and store them as `timestamptz`.

### Read-only views (new)

Stats are computed from `final` results only, never stored as running totals. A corrected result can therefore never be double-counted.

| View | Columns |
| --- | --- |
| `player_sport_stats` | `player_id`, `sport_slug`, `games_played`, `wins`, `losses`, `draws`, `goals`, `assists`, `points` |
| `player_stats` | `player_id`, `games_played`, `wins`, `losses`, `draws`, `goals`, `assists`, `points` (all sports) |
| `player_ratings` | `player_id`, `avg_rating` (2 decimals), `review_count` |

No row means zero games or no reviews. The UI shows 0 or "No reviews yet".

## Authentication and reads

Configure the client with `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY`. Supabase Auth handles email signup, sign-in, and session restoration. **Email confirmation is off for the hackathon project.** Gate onboarding and app routes on the session and on whether a `profiles` row exists for `auth.uid()`. A profile row exists only after `save_profile` succeeds. Every exposed table uses RLS and explicit grants. Emails and residential addresses stay out of discovery.

| Read | Access and shape |
| --- | --- |
| Player directory / profile | Authenticated access to public profile columns and associated `user_sports`, plus `player_stats`, `player_sport_stats`, `player_ratings`, and `reviews` for that player. Exclude the current user from directory results. |
| My Games | Rows where the caller is organizer or has a `game_players` row. Upcoming means scheduled with a future start. Completed games include `game_results`. |
| Game detail / roster | Organizer, roster players, and recipients of pending invitations may read the game and roster, including `team`. Roster players may also read `game_results` and `player_game_stats`. |
| Invitations | Organizer and recipient may read their invitation rows. Inbox filters on `recipient_id` and `status = pending` and hides games that have started. |
| Reviews | Any authenticated user may read reviews (public on profiles). |

```ts
// v1 exact-neighborhood discovery still works unchanged.
// New: radius-aware search. Returns players whose travel radius reaches the given neighborhood.
const { data } = await supabase.rpc('search_players', {
  p_sport_slug: 'soccer',
  p_neighborhood: 'downtown',      // usually the game's neighborhood
  p_skill_level: null,             // optional filter
  p_game_id: gameId,               // optional: excludes players already on the roster or with a pending invite
})
// → [{ id, display_name, neighborhood, travel_radius_miles, bio, skill_level, distance_miles, avg_rating, review_count }]
// ordered by distance_miles, then avg_rating desc; current user excluded; distance rounded to 0.1 mi.

const stats   = supabase.from('player_stats').select('*').eq('player_id', id).maybeSingle()
const ratings = supabase.from('player_ratings').select('*').eq('player_id', id).maybeSingle()
const reviews = supabase.from('reviews').select('rating,comment,created_at,reviewer:profiles!reviewer_id(display_name)').eq('reviewee_id', id)
```

Support indexes from v1, plus `player_game_stats(player_id)`, `reviews(reviewee_id)`, and `games(neighborhood, starts_at)`. Avoid recursive RLS policy joins. Membership helpers live in a non-exposed schema (e.g. `private`).

## Writes

Functions are executable only by `authenticated` (revoke from `public` and `anon`). Derive the actor from `auth.uid()` and check authorization inside each function. Table mutation grants are revoked, so all writes go through functions. Security-definer functions set an empty search path and schema-qualify every reference.

### Profiles, games, invitations (v1, with changes marked)

| Function and arguments | Return and rules |
| --- | --- |
| `save_profile(p_display_name text, p_neighborhood text, p_travel_radius_miles smallint, p_bio text, p_sports jsonb)` | Unchanged. Returns the caller's UUID. Upserts the profile and replaces sports from `[{ sport_slug, skill_level }]`. At least one sport, no duplicates. **This is the only way a profile row is created.** |
| `create_game(p_sport_slug text, p_title text, p_venue text, p_neighborhood text, p_starts_at timestamptz, p_max_players smallint)` | **Breaking: adds `p_neighborhood`.** Returns the game UUID. Requires a profile and a future start. Inserts the organizer as the first roster player in the same transaction. |
| `send_invitation(p_game_id uuid, p_recipient_id uuid)` | As v1. Returns the existing ID if a pending invite exists. If the latest invite for that recipient was `declined`, reject with `INVITATION_CLOSED` (declined stays declined). After `cancelled` or `expired`, a new invite is allowed. |
| `respond_to_invitation(p_invitation_id uuid, p_response text)` | Unchanged from v1. |
| `cancel_invitation(p_invitation_id uuid)` **(new)** | Organizer only, pending only. Returns `cancelled`. Identical retry returns `cancelled`. |
| `cancel_game(p_game_id uuid)` **(new)** | Organizer only, scheduled only. Sets `cancelled` and cancels all pending invitations. Returns `cancelled`. |

### Teams (new)

| Function and arguments | Return and rules |
| --- | --- |
| `set_team(p_game_id uuid, p_player_id uuid, p_team text)` | Organizer only, scheduled game, player on the roster, `p_team` is `A`, `B`, or null. Returns `p_team`. |
| `auto_assign_teams(p_game_id uuid)` | Organizer only, scheduled game. Balances by skill level in the game's sport, then win rate, using a snake draft (A B B A …). Returns `{ player_id, team }[]`. |

### Results and stats (new)

Flow: the organizer submits (`pending`), then a **different** roster player confirms (`final`) or disputes (`disputed`). Only `final` results feed the stats views. Re-submitting replaces the previous result and stat rows, sets `pending`, and increments `revision`, so corrections never double-count.

| Function and arguments | Return and rules |
| --- | --- |
| `submit_results(p_game_id uuid, p_team_a_score smallint, p_team_b_score smallint, p_performances jsonb)` | Organizer only. Game is `scheduled` or `completed` (not `cancelled`), and its start date in America/New_York is today or earlier. Every roster player has a team, and both teams are non-empty. `p_performances` is `[{ player_id, goals?, assists?, points? }]`: roster players only, no duplicates, values ≥ 0, and stats the sport doesn't track are stored as 0. Omitted players get zeros. Outcome is derived from the scores. Sets the game to `completed`, expires pending invitations, returns `pending`. |
| `confirm_results(p_game_id uuid)` | Roster player other than the submitter, result `pending`. Returns `final`. Identical retry returns `final`. |
| `dispute_results(p_game_id uuid, p_reason text)` | Roster player other than the submitter, result `pending`. Reason 1–300 characters. Returns `disputed`. The organizer then re-submits. |

### Reviews (new)

| Function and arguments | Return and rules |
| --- | --- |
| `submit_review(p_game_id uuid, p_reviewee_id uuid, p_rating smallint, p_comment text)` | Caller and reviewee were both on the roster, the game's result is `final`, no self-review, rating 1–5, comment 0–500. One review per reviewer, reviewee, and game; a second attempt reports `ALREADY_REVIEWED`. Returns the review UUID. |

```ts
await supabase.rpc('auto_assign_teams', { p_game_id: gameId })
await supabase.rpc('submit_results', {
  p_game_id: gameId, p_team_a_score: 3, p_team_b_score: 1,
  p_performances: [{ player_id: samId, goals: 2 }, { player_id: marcusId, goals: 1, assists: 2 }],
})
await supabase.rpc('confirm_results', { p_game_id: gameId })   // signed in as a different player
await supabase.rpc('submit_review', { p_game_id: gameId, p_reviewee_id: marcusId, p_rating: 5, p_comment: 'Great organizer' })
```

### Locking and errors

As v1: lock the game row first in every function that changes capacity, roster, invitation, team, result, or game status. Results and reviews also lock the game row before reading the roster.

Stable error messages for UI mapping:

| Code | Meaning |
| --- | --- |
| `FORBIDDEN` | Caller isn't allowed (not organizer, not a participant, not the recipient) |
| `PROFILE_REQUIRED` | Caller has no profile yet |
| `VALIDATION` | Bad input (length, range, unknown slug, duplicate sport or player) |
| `GAME_FULL` | No open spot |
| `GAME_UNAVAILABLE` | Game cancelled, completed, or already started |
| `INVITATION_CLOSED` | Invitation not pending, or recipient previously declined |
| `RESULTS_TOO_EARLY` | Submitting before game day |
| `TEAMS_INCOMPLETE` | A roster player has no team, or a team is empty |
| `RESULT_NOT_PENDING` | Confirm or dispute on a result that isn't pending |
| `NOT_ELIGIBLE` | Review rules not met (not teammates, result not final, self-review) |
| `ALREADY_REVIEWED` | Duplicate review |

## Milestones

1. **Invitation flow (v1 scope, unchanged):** two real accounts complete signup → onboarding → create game → search → invite → accept, and the organizer sees the player and updated capacity. Also verify rejection, repeated acceptance, concurrent last-spot acceptance, unauthorized reads and responses, and accepting after start or cancel.
2. **Results and reviews (new):** organizer sets teams and submits results; the second account confirms; both profiles show updated games, wins, and goals; each player reviews the other once. Also verify a non-organizer submit, the organizer confirming their own result, a correction not double-counting, a duplicate review, and reviewing someone who wasn't in the game.

**Demo tip:** results open on game day, so create the demo game for later the same day.

References [Supabase Auth](https://supabase.com/docs/guides/auth), [Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security), [JavaScript RPC](https://supabase.com/docs/reference/javascript/rpc).
