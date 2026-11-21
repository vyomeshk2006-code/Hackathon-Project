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


### Browser demo

Mock accounts share data across tabs on the same local URL. Each tab has its own signed-in account. Use **Try the demo** to choose Jordan, Maya, Andre, Sofia, or Cam. Sign up with a test email and a throwaway password to exercise onboarding and add a custom sport. Clear site storage to reset the mock.

- **Open game and emergency replacement:** As Jordan, create a Soccer game starting in 45 minutes Tampa time with one player per team. As Maya, browse and join. Assign Maya to Team B and send a chat message from Jordan. Switch back to Maya, read the message, and withdraw. Jordan gets a withdrawal notice, and eligible accounts such as Andre and Cam get replacement alerts. Open their notifications in separate tabs and claim the spot. The first valid claim fills the roster, and Maya loses chat access.
- **Requests and invitations:** Create an invite-only Intermediate Soccer game. Maya can request a spot and Jordan can approve, decline, or assign a team. Every signed-in user can browse future games, including all-level invite-only games. Sport and skill requirements control who can request to join. Use **Find players to invite** for single or bulk invitations, or **Find replacement** for nearby eligible players.
- **Squads:** Create a Soccer squad, share its join code with a demo player, have that player join, then invite the squad to a game from **Game management**. Squad members still accept separately.
- **Results and player records:** Create a game for later today in Tampa, fill the roster, assign both teams, and submit scores and player performances. A different player disputes or confirms. Revise disputed results as Jordan and confirm the new revision. Final games appear in player statistics, and anonymous two-rating reviews open for roster players.
- **Verified skill:** Have three distinct roster players rate a player across two finalized games. Use skill scores of 5 for an intermediate player to demonstrate a verified promotion. The player receives a level-change notification and the sport's manual level picker locks.

### Supabase integration

The running app uses browser-local mock data, per-tab sessions, and approximate neighborhood centers. On browsers with the Web Locks API, it serializes writes across tabs to the same origin. The mock is intended for demonstrations and local testing.

The typed service boundary is `frontend/src/services/contract.ts`. `frontend/src/services/supabaseV2.ts` prepares Auth and confirmed v2 profile, search, game, invitation, team, and result calls using the official client. The app does not select this adapter. It requires a complete compatible implementation before switching modes.

1. Keep the [agreed v2 contract](docs/database-contract.md) as the baseline. Confirm the [v3 proposal](docs/database-contract-v3-proposal.md) with the backend owner before binding game browsing and requests, chat, squads, withdrawals, replacements, preferences, notifications, and anonymous skill reviews.
2. Agree on the [v4 addendum proposal](docs/database-contract-v4-addendum-proposal.md) for custom sports, stat definitions, metric payloads, and game descriptions.
3. Map approved reads, RPC responses, RLS, and stable error codes to the frontend service. Realtime subscriptions should use owner-scoped notifications and roster-scoped game messages. The public review route must read `public_reviews`.
4. Configure the project URL and a Supabase publishable key, then retest Auth and the full flows with multiple real accounts. Production notification creation, privacy, and claim safety depend on the backend.
