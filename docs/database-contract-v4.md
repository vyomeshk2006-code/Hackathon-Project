# Pickup Sports Tampa database contract — v4

**Status: APPROVED and implemented** (`supabase/migrations/008_v4.sql`). This is the backend owner's answer to `database-contract-v4-addendum-proposal.md`: every request in the addendum is accepted. This doc fixes the shapes the addendum left to the backend owner.

It extends the **approved v3** ([`database-contract-v3-proposal.md`](database-contract-v3-proposal.md) on the `backend-supabase` branch). ⚠️ The frontend's copy of v3 is an older draft. The live backend follows the approved v3:

| Approved v3 (live) | Older draft (frontend) |
| --- | --- |
| `games.skill_levels text[]` (one, several, or all levels; null = all) | `games.skill_level text` |
| `create_game(..., p_skill_levels text[])` | `p_skill_level text` |
| 2 games per user per day → `DAILY_LIMIT_REACHED` | not present |
| Levels: skill ratings 50%, stats 30%, win rate 20% (no-metric sports: 60/40) | ratings only |
| Reviews read from `public_reviews`; `submit_review(..., p_skill_rating)` | not present |

## Changes from v3

| # | Change | Breaking? |
| --- | --- | --- |
| 1 | Every signed-in user can see **all upcoming scheduled games** and their rosters, whatever the join mode or skill levels | No (more visible) |
| 2 | `browse_games` returns every upcoming game. `p_only_open_spots` now **defaults to false** (full games shown). New `description` column. | **Yes:** default, plus one new column |
| 3 | `request_to_join` works on any invite-only game (null levels = all levels). An ineligible player gets `NOT_ELIGIBLE` (was `FORBIDDEN`). Approval re-checks eligibility. | **Yes:** error code |
| 4 | New-game alerts go out for every new game, not only open or level-restricted ones | No |
| 5 | Sports catalog: 13 seeded sports, `sports.normalized_name`, `create_sport(p_name)` | No |
| 6 | Per-sport metrics: `sport_stat_definitions`, `player_game_stat_values`, `player_sport_metric_totals` | No |
| 7 | `submit_results` accepts `{ player_id, metrics: { key: value } }`; legacy flat fields still work | No |
| 8 | `win_pct` added to `player_sport_stats` and `player_stats` | No (new column) |
| 9 | `create_game(..., p_description text default null)`, up to 500 characters | No |

## Discovery

- **Upcoming** = `status = 'scheduled' and starts_at > now()`. Upcoming games and their `game_players` rows are readable by every authenticated user, along with public profile fields, levels, and stats.
- Past, cancelled, and completed games keep the v3 rules: members, plus open games, plus level-matched players, plus alert recipients.
- Still private: chat (roster only), invitations (recipient and organizer), join requests (requester and organizer), notifications (owner), `game_results` and per-game stats (roster only), raw reviews (the writer only).
- `browse_games` flags, all computed for the caller:
  - `can_join`: open game, not a member, has space, the caller plays the sport, and their level is allowed
  - `can_request`: the same, for invite-only games, with no pending request
  - `has_pending_request`: only ever true for the requester
  - A missing profile or sport, a level mismatch, or a full roster makes both `can_join` and `can_request` false. `distance_miles` is null without a profile.

## Sports catalog

| Column | Notes |
| --- | --- |
| `sports.slug` | Immutable primary key |
| `sports.name` | First accepted display name |
| `sports.normalized_name` | Unique; NFKC, trimmed, whitespace collapsed, lowercased |
| `sports.stat_fields` | v2 column, kept in sync for seeded sports; `{}` for custom sports |

**Seeded:** Soccer, Basketball, Volleyball, Pickleball, Cricket, Tennis, Badminton, American Football, Baseball, Table Tennis, Futsal, Handball, Ultimate Frisbee.

`create_sport(p_name text)` returns `{ slug, name, created }`:
- **Name rules:** 2–40 characters after cleanup; must start with a letter or number; no control characters or `< > @ # $ % ^ * = ~ \` | \ { } [ ] ; : " ? _`. Otherwise `VALIDATION`.
- **Same normalized name** (in any case or spacing) returns the existing sport with `created = false`, including when two requests arrive at the same time.
- **Slug:** accents removed, then runs of anything other than a–z and 0–9 become `-` (e.g. `Foot Volley` → `foot-volley`). A different name with the same slug gets a number: `Foot-Volley` → `foot-volley-2`. Non-Latin names fall back to `sport`, `sport-2`, and so on.
- Custom sports have no metrics, so they track wins, losses, and draws only.

**Reading the catalog:** with supabase-js, `from('sports').select('slug, name, sport_stat_definitions(stat_key, display_name, sort_order, max_value)')`. It's readable without signing in.

## Metrics

| Table / view | Columns |
| --- | --- |
| `sport_stat_definitions` | `sport_slug, stat_key, display_name, sort_order, max_value` (≤ 32767), `level_weight` (backend-maintained, read-only) |
| `player_game_stat_values` | `game_id, player_id, sport_slug, stat_key, value`. One row per defined metric per roster player in the current revision. Readable by the roster only. |
| `player_sport_metric_totals` | `player_id, sport_slug, stat_key, display_name, sort_order, total`. Final results only, grouped by sport, public. No row means 0. |

**Defaults** (with the `level_weight` used in levels):

| Sport | Metrics |
| --- | --- |
| Soccer | goals (1), assists (0.75) |
| Basketball | points (1), rebounds (1), assists (1.5) |
| Cricket | runs (1), wickets (20) |
| Volleyball | points (1), aces (1), blocks (1) |
| Tennis | sets_won (1) |
| Badminton | sets_won (1) |

## submit_results

```json
[{ "player_id": "…", "metrics": { "points": 10, "rebounds": 5 } }]
```

- **Omitted metrics count as 0.**
- `VALIDATION` for:
  - a non-integer, negative, or over-limit value
  - a metric key the sport doesn't define
  - a player who isn't on the roster
  - the same player listed twice
  - `metrics` that isn't an object
  - the same metric given both as a flat field and inside `metrics`
- **Legacy flat fields** `goals`, `assists`, `points` are still accepted. They're mapped when the sport defines them and ignored otherwise.
- **Revisions:**
  - Re-submitting replaces the current revision and sets the result back to `pending`; it's excluded from all totals until it's confirmed again.
  - An identical retry of `confirm_results` returns `final` and changes nothing.
  - Older revisions aren't kept.
- **Levels:**
  - Contribution = sum of (value × `level_weight`), ranked within the game.
  - Only reviews from games whose result is currently final count.
  - A verified level stays locked while a result is reopened.

## Win percentage

`win_pct` = wins ÷ all finalized matches (draws included) × 100, rounded to 1 decimal. Null if there are no matches.

## Frontend checklist

1. Switch to the approved v3 names (`skill_levels`, `p_skill_levels`, `public_reviews`, `p_skill_rating`) and handle `DAILY_LIMIT_REACHED`.
2. `browse_games`: expect full games by default and read `description`.
3. `request_to_join`: map `NOT_ELIGIBLE`.
4. Results form: build the inputs from `sport_stat_definitions` and send `metrics`.
5. Profile stats: `player_sport_stats.win_pct` plus `player_sport_metric_totals`.
6. "Add a sport": call `create_sport`, and use the returned `slug` everywhere.
