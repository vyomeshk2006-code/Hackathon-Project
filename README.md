# Hackathon-Project
A location-based sports matchmaking platform that connects players across Tampa to organize pickup games, discover teammates, track match statistics, and build a trusted sports community.

## Frontend

Run the browser demo with Node.js 22.12 or newer.

```sh
cd frontend
npm ci
npm run dev
```

Open the local URL Vite prints. Run `npm test` to check the mock service and `npm run build` to type-check and build the production bundle. For Vercel deployment, set the root directory to `frontend`.

### Two-player demo

1. Open **Try the demo** and choose **Jordan · Organizer**.
2. Create a soccer game in Downtown with capacity of two. Schedule it for later **today, Tampa time** so results are available during the demo.
3. Select **Find players to invite** to search by player travel radius. Open Maya Chen's profile and send the invitation.
4. Log out, choose **Maya · Player**, and accept under **Invitations**. You can also open a second tab at the same URL and sign in as Maya there.
5. As Jordan, open the game under **My games**. The roster shows both players and zero spots open. Select **Auto-assign teams** or assign one player to each team manually. Enter the score and player performance, then submit the result.
6. As Maya, open the completed game and confirm the result. To demonstrate a dispute, select **Dispute results**, enter a reason, then have Jordan revise the score and Maya confirm the new revision.
7. Each player can review the other from the game after the result is final. Open either profile to see its record, sport totals, and reviews.

To try cancellations, create a separate upcoming game with an open spot. Send an invitation, cancel it under **Game management**, and send a new one. Cancelling the game clears its remaining pending invitations.

To demo onboarding, sign up with a test email such as `player@example.test` and a throwaway password. Select a sport and Tampa neighborhood, then save the profile. Demo data persists for the browser origin, and sign-in is per tab. Clear the site's browser storage to reset the demo.

### Supabase integration

The browser mock covers both v2 demo milestones. It uses local storage, per-tab sessions, and approximate neighborhood centers. It reproduces permission checks and result states for the demo. Supabase still needs to provide the live data, authorization, and database transactions.

Implement the async interface in `frontend/src/services/contract.ts` using Supabase and select it in `frontend/src/services/index.ts`. Omit the optional `demo` configuration to hide the seeded account shortcuts and demo messaging.

- Connect sign-up, sign-in, sign-out, and session changes to Supabase Auth. Keep email confirmation off for the hackathon project and create profiles through `save_profile`.
- Use `search_players` for travel-radius matching and the exact-neighborhood profile query for exact matches. Map SQL rows and RPC outputs to the frontend types, including nullable ratings and team fields.
- Read games, roster, invitations, results, and performance rows under RLS. Use the v2 RPCs for all writes, including cancellation, team changes, result submission and confirmation, and reviews. Translate stable error codes using `frontend/src/services/errors.ts`.
- Read totals and ratings from `player_stats`, `player_sport_stats`, and `player_ratings`. Refresh relevant reads after writes and on session changes. Re-run both acceptance milestones with two real accounts.

The [v2 database contract](docs/database-contract.md) defines the exact tables, views, RPC parameters, and authorization rules.
