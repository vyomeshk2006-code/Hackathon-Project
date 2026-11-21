# Pickup Sports Tampa — Supabase backend

Implements [`docs/database-contract-v2.md`](../docs/database-contract-v2.md), the approved [`docs/database-contract-v3-proposal.md`](../docs/database-contract-v3-proposal.md), [`docs/database-contract-v4.md`](../docs/database-contract-v4.md), and [`docs/database-contract-v5-proposal.md`](../docs/database-contract-v5-proposal.md) (v5, approved). The contracts are the source of truth for every table, column, function, and error code. This README only covers setup.

| File | What it does |
|---|---|
| `migrations/001_schema.sql` | v2 tables, indexes, and the stats/ratings views |
| `migrations/002_security.sql` | v2 read-only grants, Row Level Security, and `private` helper functions |
| `migrations/003_functions.sql` | v2 writes: profiles, games, invitations, teams, results, reviews, `search_players` |
| `migrations/004_reference_data.sql` | The 6 neighborhoods and 4 sports |
| `migrations/005_v3_schema.sql` | v3 tables and columns: game types, skill levels, team size, squads, join requests, withdrawals, replacement alerts, notifications, chat, hidden level scores, plus the views `public_reviews`, `my_game_chat_status`, `my_squads`, `my_game_quota` |
| `migrations/006_v3_security.sql` | v3 grants and RLS: who can see open/invite-only games, roster-only chat, anonymous reviews |
| `migrations/007_v3_functions.sql` | v3 functions: `browse_games`, `join_game`, join requests, `withdraw_from_game`, `claim_replacement_spot`, bulk and squad invites, squads, chat, notifications, level calculation, and the updated v2 functions |
| `migrations/008_v4.sql` | v4: every upcoming game discoverable, 13-sport catalog + `create_sport`, per-sport metrics (`sport_stat_definitions`, `player_game_stat_values`, `player_sport_metric_totals`), win %, game descriptions |
| `migrations/009_v5.sql` | v5: usernames, private phone numbers + `get_game_contacts`, username search, chat removed, venue address, game end time + automatic expiration from Browse, `my_game_history`, winner-only results + `results_needed` reminders |
| `seed.sql` | Optional **demo data**: 12 players (usernames + fictional 555 phones), 15 games, past results, reviews, one squad |
| `tests/` | Local tests: 109 v2 + 117 v3 + 73 v4 + 88 v5 checks. Needs no Supabase account. |

## Setup (new project)

1. **Create the project:** supabase.com → New project → region **East US**. Save the database password privately.
2. **Run the SQL:** Dashboard → **SQL Editor** → New query. Paste and **Run** each file in this order:
   `001` → … → `009` (all nine, in order) → `seed.sql` (optional, and only **after** all nine).
3. **Auth:** Authentication → Sign In / Providers → Email: enabled, and **Confirm email: off** (per the contract, for the hackathon).
4. **Realtime:** Database → Publications → `supabase_realtime` should list `notifications`. (Chat was removed in v5.)
5. **Keys for the frontend:** Project Settings → API keys. Share these privately with the frontend (not in Git):
   ```
   VITE_SUPABASE_URL=https://<project>.supabase.co
   VITE_SUPABASE_PUBLISHABLE_KEY=<publishable / anon key>
   ```
   Never share the `service_role` / secret key.
6. **Check:** Table Editor → `profiles` has 12 rows and `games` has 15 (if you ran the seed).

**Already running an older version?** Run only the migrations you haven't run yet, in order (from v3: `008` then `009`). Existing data is kept, and old results are copied into the new metrics table. Don't re-run the seed.

## Demo data

- Demo logins: `marcus`, `aisha`, `daniel`, `sofia`, `jordan`, `priya`, `tyler`, `camila`, `kevin`, `lena`, `andre`, `mei` — each `@demo.pickuptampa.test`, password `demo1234`.
- **Saturday Morning Soccer** (Marcus): open 5v5 for intermediate + advanced, 6 of 10 players. This is the "need 4 more players" scenario.
- **Sunday Hoops** (Jordan): invite-only 5v5 for intermediate + advanced. **Sunset Beach Volleyball** (Lena): open 4v4, all levels. **Pickleball Doubles** (Mei): invite-only, advanced only.
- Squad **Ybor FC** (soccer, captain Camila, join code `YBORFC26`).
- Demo games are backdated, so every demo account can still create 2 games today.
- To remove all demo data:
  ```sql
  delete from auth.users where email like '%@demo.pickuptampa.test';
  ```

**Demo tips**
- Results can be submitted from the game's day onward (America/New_York), and invitations close once the game starts. Create the live demo game for **later the same day**.
- To show the emergency replacement: create a game starting in **under 60 minutes**, have a player join and withdraw, then claim the spot from another eligible account.
- Each account can create only **2 games per day**, so plan which account creates the demo games.

## Running the tests

```bash
cd supabase/tests
npm install
npm test
```

The tests start a throwaway Postgres, fake Supabase's `auth` schema and roles, run every migration and the seed, then check all contract milestones. `test.mjs` re-runs the v2 checks against the full v3 database, to prove v2 calls still work. `test_v3.mjs`, `test_v4.mjs` and `test_v5.mjs` cover every v3, v4 and v5 feature, including attempts to break the rules.
