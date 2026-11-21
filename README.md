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

Use **Try the demo** to open Jordan, Maya, Andre, Sofia, or Cam in separate tabs on the same URL. Fresh demo accounts have synthetic contact numbers. Use test numbers and throwaway passwords when creating additional accounts. Older local profiles can claim a username and add a phone from Settings.

1. As Jordan, create an invite-only Soccer game with an exact address and a future start and end in Tampa time.
2. As Maya, find it by sport in **Browse games** and request to join. Jordan can see Maya's declared neighborhood on the request.
3. Approve Maya and open the game in both tabs. The **Game contacts** section is available only while authorized and before the game closes. Use **Open directions** to open the venue address in Maps.
4. Before kickoff, Maya can withdraw. Jordan is notified and eligible players who opted in can claim an emergency replacement. Replacement eligibility uses sport and skill without geographic matching.
5. Use **Game management** for invites, requests, squads, teams, cancellation, and before-kickoff editing of the venue and schedule. At the scheduled end, the game leaves Browse Games and remains in My Games history for members and organizers.
6. Use the results workflow from the game. Confirm or dispute as another player, revise as the organizer, and submit anonymous reviews after confirmation. Computed skill is separate from self-declared skill. Sports needing unapproved normalization remain provisional.

### Supabase integration

The running app uses browser-local mock data and per-tab sessions. On browsers with Web Locks, writes are serialized across tabs on the same origin. This simulates authorization for demonstrations; shared browser storage itself is accessible to the browser owner.

See the [v4 addendum proposal](docs/database-contract-v4-addendum-proposal.md) for private phone storage and RPC access, unique usernames, end-time filtering, and unresolved skill normalization. The confirmed-v2 adapter is inactive. Binding a live adapter requires backend-owner approval, compatible queries and RLS, and real multi-account integration tests. The [agreed v2 contract](docs/database-contract.md) and [v3 proposal](docs/database-contract-v3-proposal.md) remain available for comparison.

See the [frontend acceptance audit](docs/frontend-acceptance-audit.md) for the requirement checklist and verification evidence.
