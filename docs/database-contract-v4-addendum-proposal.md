
# Pickup Sports Tampa v4 addendum proposal

**Status: awaiting backend-owner approval.** The agreed [v2 contract](database-contract.md) remains unchanged. The [v3 proposal](database-contract-v3-proposal.md) defines the earlier game, notification, squad, and peer-rating behavior. The final frontend change request supersedes its chat, geographic matching, discovery timing, and skill calculations. This document describes frontend requirements beyond v3. The frontend currently exercises them through its mock service.


## Account data and contact access

- Use a nullable canonical lowercase `username` for migration, then claim it through an authenticated profile-write operation. Require 3–20 ASCII letters, digits or underscores and enforce case-insensitive uniqueness with a database unique index. Availability is advisory. Concurrent saves must resolve atomically, with one winner and a distinct conflict outcome. Keep full names non-unique. Existing accounts can claim a username and add a phone without changing their ID, memberships, sports, history or reviews. Defer username changes after initial claim.
- Store a validated international `phone_number` in a separate private table keyed by account ID. The mock checks E.164-style syntax only. Number ownership and SMS verification require a separate decision. Only the owner can fetch or update their account phone directly. Retain the preferred neighborhood as descriptive user-entered text. Allow common area labels and custom text without tracking or geocoding.
- Propose an owner-only account query and an atomic account/profile write. Require a phone before creating a game, joining, requesting, accepting an invitation, or claiming a replacement. Review required fields and backfill with the backend owner. Public profile and organizer request projections may include username, full name, neighborhood, sport and public skill. Exclude the applicant's phone and all private account fields.
- Propose a dedicated game-contacts RPC. On every request, derive the actor from Auth, check the game is scheduled with `ends_at > now()`, then check organizer or current roster membership. Return only contact data for the organizer and other confirmed members of that game. Pending, declined, withdrawn, removed, invited-but-unaccepted, and unrelated users have no contact access. End time, cancellation, or completion closes the directory immediately. Contact data already seen or copied cannot be recalled.
- Direct REST queries, public views, discovery/search payloads, Realtime, notifications, telemetry and exports must never expose phone numbers. Approve the specific private-table grants, RLS and RPC definition with the backend owner. Remove chat from frontend capabilities. Review existing server dependencies before any migration removes historical chat objects.

## Exact venues and active games

- Add required exact `venue_name`, `venue_address`, and timezone-aware `ends_at` for newly scheduled games. `ends_at` must be later than `starts_at`, and a new or edited start must be in the future. Exchange offset-bearing timestamps and persist UTC instants. Interpret forms in America/New_York. Review a migration for legacy games without end times or exact addresses. The mock retains those games in My Games and omits them from active discovery until the organizer supplies the missing schedule. The frontend builds an encoded directions link from the address.
- Propose an organizer-only game edit operation for title, venue, address, description, and timing before kickoff. Lock the game while editing and preserve roster, team size, eligibility, invitations and pending requests. Agree on any notifications for schedule or venue changes before integration.
- The active-game query returns all scheduled games with `ends_at > now()` to every authenticated caller, including open, invite-only, ongoing and full games. Support sport-name, start-date, join-mode and open-spots filters. Default to no geography or open-spots filter and sort by start time. Keep explicit caller-scoped `can_join`, `can_request`, `is_member` and `has_pending_request` flags. Return the caller's pending request ID or expose it through the caller-scoped request query.
- Update `games` and `game_players` read policies to expose only active game and public roster fields to authenticated viewers. Keep historical records, results and disputes with their existing access rules. Completed and cancelled games never appear in active discovery. Use server filtering as authoritative and recalculate frontend visibility at the next boundary, on focus and visibility changes, and on refreshed data. Do not delete games, rosters, results, reviews, or statistics when the discovery window closes.
- Preserve pre-kickoff eligibility for self-service joins and requests. Open joins need no approval; invite-only requests need organizer approval and current capacity/team checks. A null skill filter means all skills, while the sport and phone are still required. Direct organizer invitations can bypass skill matching. Keep invitations, requests and workflow notifications access-controlled. Replacement and opted-in new-game alerts use sport and eligibility without distance estimates, radius, or automatic neighborhood rules.

## Skill-rating update

Store or project self-declared skill separately from computed score, computed tier, provisional status, evidence counts, and last recalculation. Use self-declared skill for current matchmaking until the backend owner confirms how computed ratings affect eligibility. Compute per player and sport using only the active confirmed result and valid reviews. For demo peer evidence, each distinct rater's latest eligible skill review in the sport contributes to the mean; map its 1–5 value to 0–100. Keep reviewer IDs private and use the anonymous public review contract.

- Stats-supported sports use 50% normalized peer score, 30% approved normalized individual stats, and 20% win rate. Select by sport configuration so recorded zero statistics never choose the other formula. Defer numeric scoring until per-appearance, sport- and role-aware normalization is approved.
- Sports without meaningful individual stats use 60% normalized peer score and 40% win rate. Win rate equals `100 × (wins + 0.5 × draws) / (wins + draws + losses)`. Missing evidence produces a provisional rating without a number. The mock rounds the weighted score to an integer before tiering at 40 and 70.
- Require five confirmed matches and three distinct eligible peers for a non-provisional rating. Recompute from source rows on finalization, review or correction. Pending/disputed revisions contribute no evidence, and retries never double-count. Preserve existing duplicate/self-review prevention. Confirm anti-abuse thresholds, smoothing or movement caps, ties, review weighting and normalization before making production rating claims.

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
- Extend v3 `create_game` with optional trimmed description, up to 500 characters. Keep team-size and self-declared skill eligibility and apply the active discovery rules above.
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
6. Verify roster, replacement, notification, squad and anonymous rating policies through real separate sessions. Confirm an outsider cannot read raw reviews or per-game performances.

7. Check Username A vs username a races and safe legacy claims. Verify contact denial for browsers, pending/declined/withdrawn users and unaccepted invitations, timely revocation at end/completion/cancellation, and owner-only account reads.
8. Confirm that a full invite-only game remains discoverable without location filters. Exercise cross-neighborhood requests and verify organizer cards show neighborhoods without phones. Test overnight Tampa timestamps, ongoing games, exact expiration without reload, and history access after refresh.
9. Verify both skill formulas, draw handling, the 39/40 and 69/70 boundaries, minimum evidence, zero performance vs. unavailable normalization, and revision idempotence.
