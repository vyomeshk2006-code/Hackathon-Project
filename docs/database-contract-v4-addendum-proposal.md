
# Pickup Sports Tampa v4 addendum proposal

**Status: awaiting backend-owner approval.** The agreed [v2 contract](database-contract.md) remains unchanged. The [v3 proposal](database-contract-v3-proposal.md) defines the game, notification, chat, squad, and peer-rating behavior assumed here. This document describes frontend requirements beyond v3. The frontend currently exercises them through its mock service.

## Authenticated discovery and participation

This section replaces the v3 proposal's visibility rule for scheduled games that have yet to start. Every authenticated caller may discover and view those games and their public rosters, regardless of `join_mode`, `skill_level`, invitation status, profile completion, or current membership. Existing access rules continue to apply outside that window.

1. **Browse RPC.** `browse_games` returns all scheduled games with `starts_at > now()` that match the caller's explicit filters. Remove the previous invite-only visibility filter. Default `p_only_open_spots` to false so full games are discoverable. Return caller-scoped `can_join`, `can_request`, `is_member`, and `has_pending_request` flags. `can_join` is true only for an eligible non-member in an open game with capacity. `can_request` is true only for an eligible non-member in an invite-only game with capacity and no pending request. A missing profile or sport, a skill mismatch, or a full roster disables the relevant action. Existing pending requests remain visible to their owner and cancellable when capacity changes.
2. **Game and roster reads.** Add authenticated `SELECT` policy branches on `games` and `game_players` for scheduled future games, using the same time predicate for direct detail and browse reads. Preserve existing authorization for historical rows. Expose only the intended game fields and public roster identity, team, skill and stats. Use safe projections or column grants where needed. Keep existing RLS and RPC-only write protections. Public discovery grants no insert, update or delete rights.
3. **Join and request RPCs.** `join_game` accepts open games only. `request_to_join` accepts invite-only games only, including games with a null `skill_level` (all levels). Under the game lock, derive the caller from Auth and check status, start time, roster membership, sport, any specified skill, and capacity. Check eligibility and membership independently of game visibility. Return an existing pending request on an otherwise valid retry instead of inserting a duplicate. Approval is organizer-only and rechecks current eligibility, capacity and the requested team's size under the same lock. Declines notify the requester. Organizer invitations retain the ability to invite a player of the sport whose skill differs from the game requirement.
4. **Private data and actions.** Keep game chat and live chat events roster-only. Keep requests and invitations readable only by their owners or the organizer, and notifications readable only by their recipients. Organizer controls remain organizer-only, and replacement claims still require an alert. The browse response and public roster must never include other players' private profile details, contact information, chat, invitations, notifications, join requests, or per-game results and performance rows. Keep results and performance reads restricted to their existing authorized audience.

Add integration coverage with signed-in viewers at matching and mismatched skill levels, without the sport, and without a profile. Verify unlisted historical games remain protected, full games can be discovered, pending request state is caller-scoped, and a viewer cannot read or change protected game data.

## Extensible sports catalog

Keep `sports.slug` as the immutable primary key referenced by games, profiles, squads, and results. Add `normalized_name text unique not null` and allow authenticated creation through a server function. Seed Soccer, Basketball, Cricket, Volleyball, Tennis, Badminton, Pickleball, American Football, Baseball, Table Tennis, Futsal, Handball, and Ultimate Frisbee. Custom sports start with universal totals and no individual statistic fields.

Normalize with Unicode NFKC, trim, collapse whitespace, and apply a stable case-insensitive key independent of session locale. Accept 2–40 characters beginning with a letter or number and using letters, numbers, combining marks, spaces, and ordinary sport-name punctuation. Keep the first accepted display name. Generate stable URL-friendly slugs by removing combining marks and replacing punctuation runs with hyphens. Give distinct names that yield the same slug deterministic numeric suffixes. Use a unique constraint plus a transaction-safe insert-or-read to return the same sport for duplicate normalized input, including concurrent requests. Agree on canonical seed names and normalization fixtures before migration.

## Statistic definitions and performance

| Proposed object | Purpose |
| --- | --- |
| `sport_stat_definitions(sport_slug, stat_key, display_name, sort_order, max_value)` | Catalog of ordered, nonnegative integer metrics. Primary key `(sport_slug, stat_key)`. Direct mutation restricted to backend maintenance. Keep keys stable once used. |
| `player_game_stats` | Retain the roster player, result, team, and outcome row for every player and every sport. Reference the result revision when storing history. |
| `player_game_stat_values(game_id, player_id, sport_slug, stat_key, value)` | One integer per defined metric per player in the active result revision. Foreign keys enforce membership in the performance row and the game's sport definition. |
| Stats projections | Aggregate matches, wins, losses, draws, and win percentage per sport and across sports. Aggregate metric values by sport so identically named fields do not accidentally combine across sports. Empty stats resolve to zero. |

Default metrics are Soccer goals and assists, Basketball points, rebounds, and assists, Cricket runs and wickets, Volleyball points, aces, and blocks, Tennis sets won, and Badminton sets won. Other sports default to no metrics. Derive win percentage from wins divided by all finalized matches, including draws.

## Finalization and revisions

Keep the v2/v3 flow. The organizer submits a pending revision containing the team scores and all associated player metrics. A different confirmed roster player confirms or disputes. In one transaction, lock the game first, validate the roster and proposed data, and atomically replace the active revision's player and metric rows. Omitted defined values are zero. Reject noninteger, negative, overflowing, undefined metric keys, non-roster IDs, and repeated player IDs. The frontend proposes a maximum of 32767 unless the definition sets a smaller limit.

Only the active **final** revision contributes to projections. A resubmission returns the result to pending and excludes the previous revision from totals until reconfirmation. An identical confirmation retry must leave one counted match and one set of result notifications. The backend may retain older revisions for audit without exposing them as official totals. Peer skill calculation uses eligible reviews from active final results only. A verified level stays locked if a result is temporarily reopened.

## Proposed operations and compatibility

- Add a catalog read with ordered metric definitions and a proposed `create_sport(p_name)` operation. The exact read shape and function signature require backend-owner approval.
- Extend `submit_results` to accept `[{ player_id, metrics: { stat_key: value } }]`. Continue accepting v2/v3 flat fields (`goals`, `assists`, `points`) during migration, mapping applicable fields into the nested payload. Reject conflicting assignments to the same metric.
- Extend v3 `create_game` with optional trimmed description, up to 500 characters. Keep v3 team-size and skill rules and apply the authenticated discovery rules above.
- Keep v3 `public_reviews` anonymous. Do not expose reviewer, game, date, or the private numeric skill score. Existing v2-only reviews still contribute sportsmanship and have no skill rating.
- Preserve the v2/v3 default arguments and default invite-only join mode for older callers. Backfill the seeded metric definitions and historical v2 values. A null legacy team size remains supported. Custom sports use the same profile, search, squad, and game relationships and authorization rules.
- The frontend's Supabase v2 adapter continues to use confirmed methods. Wait for v3 and v4 approval and backend rollout before binding the app to their operations.

## Security and concurrency

Enable RLS and explicit grants on catalog, performance, and metric tables. Allow authenticated catalog reads. Keep writes behind authenticated functions that derive the actor from `auth.uid()`. Use an empty search path in security-definer functions and schema-qualify references. Use the v2/v3 lock order, followed by result and performance updates, to avoid concurrent revision and confirmation races. Grant row-level game performance access only to its authorized roster readers. Expose only approved aggregate and anonymous review projections outside the game. Never expose private skill calculations or raw reviews to other users.

## Integration acceptance

1. Create a custom sport twice with different case and whitespace, including concurrently. Verify one catalog entry and a stable slug. Create two distinct names that yield the same base slug and verify both resolve.
2. Add the sport to profiles and use it in browsing, team management, squads, and a finalized draw. Verify universal totals and an empty metric set.
3. Finalize two Soccer results for one player, with two goals and one assist in a win and one goal in a loss. Verify two matches, one win, one loss, 50% win rate, three goals, and one assist.
4. Submit a Basketball result with rebounds. Reject unknown keys, negative values, and players outside the roster.
5. Confirm twice, dispute and correct a newer submission, then confirm the correction. Verify score, outcome, and aggregate metrics reflect only the active finalized revision.
6. Verify the v3 roster, chat, replacements, notifications, squad invitations, and anonymous ratings through real separate sessions. Confirm an outsider cannot read raw reviews or per-game performances.
