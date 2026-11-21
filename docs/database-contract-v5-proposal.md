# Pickup Sports Tampa database contract — v5

**Status: APPROVED and implemented** (`supabase/migrations/009_v5.sql`, 88 tests). Also answers `pickup_sports_backend_change_request_updated.md`.

v5 answers the frontend's change request (`pickup_sports_backend_change_request.md`) and its "Automatic Game Expiration" clarification. It builds on **v4** ([`database-contract-v4.md`](database-contract-v4.md), migration `008`). It will ship as migration `009`, so the live database needs `008` **and then** `009`.

## Summary of changes

| # | Change | Breaking? |
| --- | --- | --- |
| 1 | **Signup fields:** full name, unique **@username**, phone (private), neighborhood, sports + levels | `save_profile` gains arguments; new profiles must include username + phone |
| 2 | **Search players by username** | No (new) |
| 3 | **Private phone numbers + game contacts**, visible only to the organizer and confirmed roster **until the game ends** | No (new) |
| 4 | **Remove game chat** (tables, functions, realtime) | **Yes:** chat calls stop working |
| 5 | **Exact venue address** + directions link | No (new optional argument) |
| 6 | **Game end time** (`ends_at`, from a duration) | No (default 2 hours) |
| 7 | **Browse:** no location filter or distance; shows ongoing games until they end; filters by sport name, date, game type, open spots; pagination | **Yes:** arguments and columns change |
| 8 | **Automatic expiration** from Browse at `ends_at`, never deleted | No |
| 9 | **Game history** list | No (new) |
| 10 | **After a game ends, the organizer is asked for the result.** The winner (A / B / draw) is required; scores and stats are optional. | `submit_results` gains `p_winner`; scores become optional |
| 11 | More Tampa neighborhoods + optional free-text area note | No |
| 12 | **Skill level rules** written out in full (ratings 50% / stats 30% / win rate 20%, or 60/40 for sports without stats). Unchanged except for winner-only results. | No |

## Decisions (agreed by the backend owner)

1. **Radius stays, but only behind the scenes.** It's gone from Browse (no filter, no distance, no "near me"). It's still used for **emergency replacement alerts**, **new-game alerts**, and the organizer's **player search**. It never limits who can see, join, or request a game.
2. **Neighborhood** is chosen from a fixed list of Tampa areas (so alerts can measure distance), plus an optional free-text **area note** (e.g. "near Fowler Ave"). It's self-declared: no GPS, no geocoding, never an address. It **never** affects discovery, eligibility, or approval.
3. **Phone** is **required when a new profile is created**. Existing accounts (including demo accounts) without one keep working, and the frontend prompts them to add one. A game's contact list simply leaves out players with no phone.
4. **End time:** the organizer picks a **duration** (default **2 hours**), and `ends_at = starts_at + duration`. Existing games get start + 2 hours. Games ending after midnight work, because everything is stored as exact timestamps.
5. **Contacts are visible only while the game is upcoming or ongoing:** `status = 'scheduled'` and `now() < ends_at`. They're hidden once the game ends, is cancelled, or has a result submitted.
6. **Joining still closes at kickoff.** A started game shows in Browse as **ongoing** until it ends, but can't be joined or requested.
7. **Results:** the organizer **must** say who won (`A`, `B`, or `draw`). Scores and per-player stats are **optional**. Teams must still be set, since that's how "who won" maps to players. Results can still be submitted from the game's day onward (America/New_York); the "asked" prompt comes once the game ends.
8. **Chat is removed** with a reviewed migration. Workflow notifications are kept; chat never created notifications.

## 1. Account setup and profile

| Signup field | Where it lives | Who can see it |
| --- | --- | --- |
| Full name (e.g. *Vyomesh Kumar*) | `profiles.display_name` (existing) | Every signed-in user |
| **Username** (e.g. *@vyomeshk*) | `profiles.username` **(new)** | Every signed-in user |
| Email + password | Supabase Auth (existing) | Only the user |
| **Phone** | `private_contacts.phone_e164` **(new table)** | Only the user, plus the game contacts rule (§3) |
| Neighborhood (e.g. *USF Area*) + optional area note | `profiles.neighborhood` (existing) + `profiles.area_note` **(new)** | Every signed-in user |
| Favorite sports + skill levels | `user_sports` (existing) | Every signed-in user |

**Username rules**
- 3–20 characters: ASCII letters, digits and `_` only (no dots or spaces). Stored lowercase.
- Stored without the `@`, compared case-insensitively, unique
- Taken (including a different-case version, or two people claiming it at the same moment) → `USERNAME_TAKEN`.
- **Set once:** after it's saved it can't be changed (`USERNAME_LOCKED`). Re-sending the same username is fine.
- Existing accounts without a username claim one later through `save_profile`. Demo accounts use their handle (`marcus`, `aisha`, …).

**Phone rules**
- Normalized to E.164: digits only with a leading `+`, 8–15 digits.
- A 10-digit US number like `(813) 555-0142` becomes `+18135550142`.
- Invalid → `VALIDATION`.
- Not verified by SMS (possible later).
- Never stored in `profiles`, and never included in browse, search, notifications, or any public view.

**`save_profile`** gains optional arguments: `p_username text`, `p_phone text`, `p_area_note text` (0–80 characters).
- **Creating** a profile requires `p_username` and `p_phone` (`VALIDATION` if missing).
- **Updating** one keeps current values when these are null.
- Own phone: `from('private_contacts').select('phone_e164')`. Row-level security returns only the caller's own row; nobody can read anyone else's.

**Neighborhoods:** the existing 6 slugs stay. `usf` is renamed **"USF Area"**. Added: Ybor City, Hyde Park, Westshore, Carrollwood, New Tampa, Temple Terrace, Brandon, Westchase, Town 'n' Country, Riverview (16 total, each with an approximate center point used only for alerts and player search).

## 2. Search players by username

`search_players_by_username(p_query text, p_limit int default 20)`
- Signed-in users only.
- Case-insensitive, matching from the start of the username (a leading `@` is ignored). At least 2 characters.
- Returns `id, username, display_name, neighborhood, neighborhood_name, area_note, sports` (`[{ sport_slug, skill_level, level_source }]`), `avg_rating, review_count`.
- **Never** returns phone numbers.
- Ordered by exact match first, then alphabetically.

## 3. Game contacts

`get_game_contacts(p_game_id uuid)` returns `player_id, display_name, username, phone_e164, is_organizer`.

| Caller | Result |
| --- | --- |
| Organizer, or a player currently on the roster, while the game is scheduled and `now() < ends_at` | Organizer + all confirmed roster members who have a phone (including the caller) |
| Anyone else: browsing, pending requester, declined, withdrawn, removed, invited but not accepted | `FORBIDDEN` |
| A roster member after the game ends, is cancelled, or has a result | `CONTACTS_CLOSED` |

- Membership is re-checked on **every** call, so withdrawing revokes access immediately. Numbers already seen or copied can't be recalled.
- `private_contacts` has **no** read access for other users. The only way to see someone else's number is this function.

## 4. Remove chat

Migration `009` drops:
- tables `game_messages` and `game_chat_reads`
- view `my_game_chat_status`
- functions `send_game_message` and `mark_chat_read`
- the chat realtime publication entry

Nothing else depends on them (checked: no notifications, triggers, or other functions use chat). Realtime stays on for `notifications`.

## 5. Venue

| Field | Notes |
| --- | --- |
| `games.venue` (existing) | Venue name, e.g. *Al Lopez Park* |
| `games.venue_address` **(new)** | Exact address or unambiguous description, 0–200 characters. Set with `create_game(..., p_venue_address text)`. Optional in the database for older callers, **required in the frontend form**. |
| `games.neighborhood` (existing) | Area label, still required. Used only for alerts and player search, never for Browse. |

**Directions:** the frontend builds `https://www.google.com/maps/dir/?api=1&destination=<URL-encoded venue + address>`. No Maps API key or distance needed.

## 6–8. End time, Browse, expiration

**New column:** `games.ends_at timestamptz` (> `starts_at`). `create_game(..., p_duration_minutes smallint default 120)`, allowed 30–480.

**`browse_games`** is replaced:

```
browse_games(p_sport_query text default null, p_from date default null, p_to date default null,
             p_join_mode text default null, p_only_open_spots boolean default false,
             p_limit int default 50, p_offset int default 0)
```

- **Lists:** `status = 'scheduled'` and `ends_at > now()`. Expired, cancelled, and completed games are never listed. Nothing is deleted.
- **`p_sport_query`:** matches the sport slug or name, case-insensitive, custom sports included.
- **Dates:** America/New_York calendar days on `starts_at`.
- **`p_join_mode`:** `open`, `invite_only`, or null for both.
- **Order:** by `starts_at`. `p_limit` can be at most 100.
- **Returns:** `id, title, description, sport_slug, sport_name, venue, venue_address, starts_at, ends_at, is_ongoing, max_players, team_size, join_mode, skill_levels, organizer_id, organizer_name, organizer_username, player_count, spots_left, is_member, can_join, can_request, has_pending_request`. No `neighborhood` or `distance_miles`. `is_ongoing` = `starts_at <= now() < ends_at`.
- `can_join` / `can_request` are false once the game has started.
- **Visibility rule (RLS):** v4's "upcoming = `starts_at > now()`" becomes **`ends_at > now()`**, so ongoing games stay readable. After a game ends, the v3 rules apply: participants, plus **open** games stay viewable; invite-only games aren't.

**Disappearing without a refresh (frontend):** each row carries `ends_at`. The page removes a card when its `ends_at` passes, using a timer, and also re-fetches periodically. The server filter guarantees a re-fetch never brings an expired game back.

## 9. Game history

`my_game_history(p_limit int default 50, p_offset int default 0)`:
- **Lists:** games the caller organized or is on the roster of, that have ended, been cancelled, or have a result.
- **Returns:** `id, title, sport_slug, venue, venue_address, starts_at, ends_at, status, is_organizer, my_team, winner, team_a_score, team_b_score, result_status, needs_result`.
- **Order:** newest first.
- `needs_result` = the caller is the organizer, the game ended, it wasn't cancelled, and no result exists yet.
- Stats and reviews use the existing views.

## 10. Results after the game

**The prompt:**
- Once a game ends with no result, it appears with `needs_result = true` in the organizer's history (the frontend shows "Add the result").
- The organizer also gets a one-time **`results_needed`** notification, never sent twice for the same game. It's sent by a backend job every 10 minutes (`pg_cron`, set up automatically when Supabase allows it), **and** whenever the organizer opens `my_game_history`, so it works even without the job.

**`submit_results`** changes:

```
submit_results(p_game_id, p_team_a_score smallint default null, p_team_b_score smallint default null,
               p_performances jsonb default '[]', p_winner text default null)
```

- **`p_winner`:** `'A'`, `'B'`, or `'draw'`. **Required unless both scores are given.**
  - With scores and no winner, the winner comes from the scores (v2 behavior).
  - Scores that disagree with `p_winner` → `VALIDATION`.
  - No winner and no scores → `VALIDATION`.
- **Scores** are optional; `game_results.team_a_score` / `team_b_score` become nullable. `game_results.winner` is new and always set.
- **Per-player stats** (`p_performances`) stay optional. Omitted metrics count as 0 (v4).
- Everything else is unchanged: teams required, a different player confirms or disputes, corrections never double-count, and only final results feed stats and levels.

## 11. Notifications

- **Kept:** every workflow notification.
- **Removed:** none (chat had no notification type).
- **Added:** `results_needed` (to the organizer).
- **Never** in any notification payload: phone numbers.

## 12. How a player's skill level is decided

**This is the approved model.** It replaces the 40/40/20 candidate formula and the "5 matches + 3 reviewers" provisional threshold in section 11 of the change request. The self-declared level, hidden numeric score, current tier, verified status and update time are already stored separately per sport.

Most of this is already live (v3 + v4) and is **unchanged in v5**. The one v5 addition is the last bullet under **Stats**. It's collected here so both sides use the same rules.

**Starting point.** At signup the player picks a level for each sport. It shows as **"Self-rated"** and becomes their starting score:

| Chosen level | Starting score |
| --- | --- |
| Beginner | 1.5 |
| Intermediate | 3.0 |
| Advanced | 4.5 |

**After each game, three things are measured, each on a 1–5 scale:**

| Part | How it's measured |
| --- | --- |
| ⭐ **Ratings** | After a game is final, every other player in it (teammates **and** opponents) anonymously rates the player's **skill**, 1–5. The score is the average of each rater's **latest** rating, so one person can't dominate. With 5 or more raters, the single highest and lowest are dropped. Only games whose result is currently final count. |
| 📊 **Stats** | In each game, the player's **contribution** is ranked against everyone else in that same game: top = 5, bottom = 1, evenly spaced, ties averaged. The score is the average over games. |
| 🏆 **Win rate** | win share = (wins + 0.5 × draws + 2) ÷ (games + 4), and the score is 1 + 4 × win share. The "+2 / +4" act like 2 pretend wins and 2 pretend losses, so an early lucky streak doesn't count as 100%. |

**Contribution used for Stats**, as a sum of each stat × its weight:

| Sport | Contribution |
| --- | --- |
| ⚽ Soccer | goals × 1 + assists × 0.75 |
| 🏀 Basketball | points × 1 + rebounds × 1 + assists × 1.5 |
| 🏏 Cricket | runs × 1 + wickets × 20 |
| 🏐 Volleyball | points × 1 + aces × 1 + blocks × 1 |
| 🎾 Tennis / 🏸 Badminton | sets won × 1 |
| 🏓 Pickleball, and all other or custom sports | no stats, so Stats isn't used |

**Weights:**

| Sport type | Ratings | Stats | Win rate |
| --- | --- | --- | --- |
| Sports with stats (soccer, basketball, cricket, volleyball, tennis, badminton) | **50%** | **30%** | **20%** |
| Sports without stats (pickleball, custom sports, …) | **60%** | — | **40%** |

- Ratings count most because they capture what stats miss: defending, goalkeeping, setting, positioning.
- Win rate counts least in team sports, because it depends on teammates.
- **Sportsmanship ratings never affect level.** They're shown separately as reputation.
- If a part has no data yet (e.g. no ratings), its weight is shared proportionally by the other parts.

**Combining them:**

```
performance  = weighted average of Ratings, Stats, Win rate (weights above)
final score  = (3 × starting score + games played × performance) ÷ (3 + games played)
```

The chosen level counts like 3 games, so real results gradually take over: after 10 games they dominate.

**Score → level**, with a 0.25 buffer so levels don't flip back and forth:

| Final score | Level | Move up at | Move down at |
| --- | --- | --- | --- |
| 1.00 – 2.32 | 🟢 Beginner | ≥ 2.58 → Intermediate | — |
| 2.33 – 3.66 | 🟡 Intermediate | ≥ 3.92 → Advanced | ≤ 2.08 → Beginner |
| 3.67 – 5.00 | 🔴 Advanced | — | ≤ 3.42 → Intermediate |

**Verification and locking:**
- A level only changes automatically once the player has skill ratings from **at least 3 different players across at least 2 games**. It then shows **"Verified by N players"**.
- Once verified, the player **can't change that level themselves** (`LEVEL_LOCKED`); only results and ratings move it. This stays true even if a result is reopened.
- A newly added sport starts self-rated again.

**When it's recalculated:**
- when the player receives a review
- when a result becomes final
- when a result is reopened, so a reopened game stops counting
- The player gets a `level_changed` notification whenever their level moves.

**Star guide shown on the review form:**

| Stars | Meaning |
| --- | --- |
| ⭐ 1 | Still learning the basics |
| ⭐⭐ 2 | Knows the basics, makes frequent mistakes |
| ⭐⭐⭐ 3 | Solid, consistent player |
| ⭐⭐⭐⭐ 4 | Strong player, makes a real difference |
| ⭐⭐⭐⭐⭐ 5 | Stands out, among the best in the game |

**Example:** Sam starts intermediate (3.0) and plays 6 soccer games. Ratings = 4.2, Stats = 3.8, and he won 5 of 6, so Win rate = 1 + 4 × (7 ÷ 10) = 3.8.
- performance = 0.5 × 4.2 + 0.3 × 3.8 + 0.2 × 3.8 = **4.00**
- final = (3 × 3.0 + 6 × 4.00) ÷ 9 = **3.67**

That's inside the buffer (below 3.92), so he stays Intermediate. A couple more strong games move him up.

**v5 addition (winner-only results):** if the organizer records only the winner and no stats, that game is **skipped for Stats** and still counts for **Win rate** and **Ratings**. A player whose games never have stats is judged on Ratings and Win rate alone, using the weights shared out as above.

## New error codes

| Code | Meaning |
| --- | --- |
| `USERNAME_TAKEN` | That username already belongs to someone else |
| `USERNAME_LOCKED` | Tried to change a username after it was set |
| `CONTACTS_CLOSED` | The game has ended, been cancelled, or has a result, so contacts are no longer shared |

## Frontend checklist

1. **Signup / onboarding:** full name, username, phone, neighborhood (from the list) + optional area note, sports + levels → `save_profile`. Handle `USERNAME_TAKEN`.
2. **Settings:** edit phone, neighborhood, area note. The username is shown but can't be changed. Accounts without a username or phone get a prompt to add one.
3. **Player search by username** (`search_players_by_username`). Show no phone numbers anywhere in search.
4. **Game details:** a **Contact** section from `get_game_contacts` (`tel:` links + copy). Hide it on `FORBIDDEN` / `CONTACTS_CLOSED`.
5. **Remove all chat** UI and calls.
6. **Create game:** venue name + **address (required in the form)**, area, duration (default 2 h).
7. **Browse:** remove the neighborhood/radius/distance UI. Add sport search, date, game type, and open-spots filters, plus pagination. Show an **Ongoing** badge and the address with a **Directions** link. Remove cards at `ends_at`.
8. **History page** (`my_game_history`). Organizer prompt when `needs_result`.
9. **Results form:** a **required** Winner choice (Team A / Team B / Draw), plus optional scores and optional stats.
10. **Join request review:** show the applicant's neighborhood and area note (from `profiles`), never their phone.

## Acceptance tests (backend will add these)

1. New profile: missing username or phone is rejected; a taken username gives `USERNAME_TAKEN`; phone `(813) 555-0142` is stored as `+18135550142`.
2. Username search finds `@vyomeshk` from `vyo`, `@VYO`, and `vyomeshk`, and returns no phone.
3. **Contacts**, for each of these users:
   - **Can see them:** the organizer and confirmed roster members.
   - **`FORBIDDEN`:** browsing users, pending requesters, declined users, withdrawn players (right after withdrawing), and invited-but-not-accepted users.
   - **`CONTACTS_CLOSED`:** roster members after `ends_at`, after cancelling, and after a result is submitted.
4. No phone in `profiles`, browse, search, notifications, history, or join requests. Reading `private_contacts` directly returns only your own row.
5. Chat tables and functions are gone, and notifications still work.
6. **Browse:**
   - **Listed:** open, invite-only, and full games; ongoing games until `ends_at`, with no join or request allowed.
   - **Not listed:** expired, cancelled, and completed games, including completed games whose end time is still in the future.
7. **Expiration:**
   - A game ending exactly now, a second ago, and a second from now.
   - A game from 11 PM to 1 AM, checked at 12:30 AM (listed) and at 1:01 AM (not listed).
   - Expired games are still in the database and in history.
8. Neighborhood never changes browse results, eligibility, or approval.
9. **Results:**
   - Submitting with only `p_winner` works.
   - Missing a winner and scores → `VALIDATION`.
   - Scores that contradict the winner → `VALIDATION`.
   - A draw with no scores still counts as a draw in stats.
   - `needs_result` is set for an ended game with no result, and the `results_needed` notification is sent once.
10. Sport name search finds custom sports. Filtering by game type and date works, and pagination is stable.
