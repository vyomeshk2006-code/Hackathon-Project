// v3 test suite (docs/database-contract-v3-proposal.md).
// Same harness as test.mjs: throwaway Postgres + fake Supabase auth, all
// migrations + seed, then every v3 feature and its security rules.
//
//   cd supabase/tests && npm install && npm test
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? path.resolve(here, '..', '..');
const dataDir = path.join(here, 'data-v3-' + Date.now());
const conn = { host: 'localhost', port: 54330, user: 'postgres', password: 'pw', database: 'postgres' };

const db = new EmbeddedPostgres({ databaseDir: dataDir, user: conn.user, password: conn.password, port: conn.port,
  persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
await db.initialise();
await db.start();
const client = new pg.Client(conn);
await client.connect();

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log('  PASS', n); };
const bad = (n, info) => { fail++; console.log('  FAIL', n, info ?? ''); };
const check = (n, cond, info) => (cond ? ok(n) : bad(n, typeof info === 'object' ? JSON.stringify(info) : info));
const q = (sql, p) => client.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];

async function as(uid, sql, params = []) {
  await client.query('begin');
  try {
    await client.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await client.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    const res = await client.query(sql, params);
    await client.query('commit');
    return res;
  } catch (e) { await client.query('rollback'); throw e; }
}
// JSON args (objects / object arrays) are sent as JSON text; string arrays as Postgres arrays.
const toParam = (k, v) => {
  if (k === 'p_sports' || k === 'p_performances') return JSON.stringify(v);
  if (v !== null && typeof v === 'object' && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))) return JSON.stringify(v);
  return v;
};
const rpc = async (uid, fn, args = {}) => {
  const keys = Object.keys(args);
  const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const res = await as(uid, sql, keys.map((k) => toParam(k, args[k])));
  return res.rows.length === 1 && Object.keys(res.rows[0]).length === 1 ? Object.values(res.rows[0])[0] : res.rows;
};
async function expectError(name, fn, code) {
  try { await fn(); bad(name, '(no error raised)'); }
  catch (e) { check(`${name} → ${code}`, e.message === code || new RegExp(code).test(e.message), `got: ${e.message}`); }
}
const inMinutes = (m) => new Date(Date.now() + m * 60e3).toISOString();
const setStart = (gameId, interval) => q(`update public.games set starts_at = now() + interval '${interval}' where id = $1`, [gameId]);
const notifs = async (uid, type, gameId = null) =>
  (await one(`select count(*)::int c from public.notifications where user_id = $1 and type = $2 and ($3::uuid is null or game_id = $3)`,
    [uid, type, gameId])).c;

async function player(handle, name, hood, radius, sports, extra = {}) {
  const id = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, `${handle}@test.local`]);
  await rpc(id, 'save_profile', { p_display_name: name, p_neighborhood: hood, p_travel_radius_miles: radius, p_bio: '',
    p_sports: sports.map(([s, l]) => ({ sport_slug: s, skill_level: l })), ...extra });
  return id;
}
// Creates a game, then backdates created_at so the 2-per-day limit doesn't block the rest of the suite.
async function createGame(uid, args = {}, { backdate = true } = {}) {
  const id = await rpc(uid, 'create_game', { p_sport_slug: 'soccer', p_title: 'Test Game', p_venue: 'Park',
    p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, ...args });
  if (backdate) await q(`update public.games set created_at = now() - interval '3 days' where id = $1`, [id]);
  return id;
}
async function addPlayer(org, gameId, uid, team = null) {
  const inv = await rpc(org, 'send_invitation', { p_game_id: gameId, p_recipient_id: uid, p_team: team });
  return rpc(uid, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' });
}

try {
  await q(fs.readFileSync(path.join(here, 'supabase_stub.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) { await q(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')); console.log('ran', f); }
  await q(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  console.log('ran seed.sql');
  const demo = async (h) => (await one(`select id from auth.users where email = $1`, [`${h}@demo.pickuptampa.test`])).id;
  const mei = await demo('mei'), camila = await demo('camila');

  console.log('\n== Seed (v3)');
  const sat = await one(`select join_mode, skill_levels, team_size from games where title = 'Saturday Morning Soccer' and status = 'scheduled'`);
  check('demo soccer game is open, intermediate+advanced, 5v5', sat.join_mode === 'open' && sat.team_size === 5 && sat.skill_levels.join() === 'intermediate,advanced', sat);
  check('demo squad Ybor FC has 3 members', (await one(`select count(*)::int c from squad_members m join squads s on s.id = m.squad_id where s.join_code = 'YBORFC26'`)).c === 3);
  check('hidden level scores computed for demo players', (await one(`select count(*)::int c from private.skill_scores`)).c === 24);
  check('demo games do not use up today\'s quota', (await as(await demo('marcus'), `select games_left_today from my_game_quota`)).rows[0].games_left_today === 2);

  console.log('\n== Test players');
  const olivia = await player('olivia', 'Olivia Organizer', 'downtown', 10, [['soccer', 'advanced']]);
  const nina   = await player('nina', 'Nina Intermediate', 'downtown', 10, [['soccer', 'intermediate']], { p_new_game_alerts: true });
  const ben    = await player('ben', 'Ben Beginner', 'downtown', 10, [['soccer', 'beginner']], { p_new_game_alerts: true });
  const far    = await player('far', 'Fay Faraway', 'usf', 2, [['soccer', 'intermediate']], { p_new_game_alerts: true });
  const quiet  = await player('quiet', 'Quinn Quiet', 'downtown', 10, [['soccer', 'intermediate']]);
  const optout = await player('optout', 'Otto Optout', 'downtown', 10, [['soccer', 'intermediate']], { p_replacement_alerts: false });
  const p1 = await player('p1', 'Pat One', 'downtown', 10, [['soccer', 'intermediate']]);
  const p2 = await player('p2', 'Pat Two', 'downtown', 10, [['soccer', 'intermediate']]);
  const p3 = await player('p3', 'Pat Three', 'downtown', 10, [['soccer', 'intermediate']]);
  const qq = await player('qq', 'Quincy', 'downtown', 10, [['soccer', 'intermediate']]);
  const prof = await one(`select replacement_alerts, new_game_alerts from profiles where id = $1`, [quiet]);
  check('alert defaults: replacement on, new games off', prof.replacement_alerts === true && prof.new_game_alerts === false);
  check('opt-out saved', (await one(`select replacement_alerts from profiles where id = $1`, [optout])).replacement_alerts === false);

  console.log('\n== create_game v3 + daily limit');
  await expectError('team size 5 with max 8', () => rpc(olivia, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 8, p_team_size: 5 }), 'VALIDATION');
  await expectError('unknown level', () => rpc(olivia, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, p_skill_levels: ['pro'] }), 'VALIDATION');
  await expectError('duplicate level', () => rpc(olivia, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, p_skill_levels: ['beginner', 'beginner'] }), 'VALIDATION');
  await expectError('empty level list', () => rpc(olivia, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, p_skill_levels: [] }), 'VALIDATION');
  await expectError('bad join mode', () => rpc(olivia, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, p_join_mode: 'public' }), 'VALIDATION');

  const game1 = await createGame(olivia, { p_title: 'Open Soccer', p_join_mode: 'open', p_skill_levels: ['intermediate', 'advanced'], p_team_size: 5 }, { backdate: false });
  const game2 = await createGame(olivia, { p_title: 'Invite-only Intermediate', p_join_mode: 'invite_only', p_skill_levels: ['intermediate'], p_team_size: 5 }, { backdate: false });
  check('quota shows 0 left after 2 games', (await as(olivia, `select games_left_today from my_game_quota`)).rows[0].games_left_today === 0);
  await expectError('third game today', () => createGame(olivia, {}, { backdate: false }), 'DAILY_LIMIT_REACHED');
  const pete = await player('pete', 'Pete', 'downtown', 10, [['soccer', 'advanced']]);
  const peteA = await createGame(pete, {}, { backdate: false });
  await rpc(pete, 'send_invitation', { p_game_id: peteA, p_recipient_id: qq });
  await rpc(pete, 'cancel_game', { p_game_id: peteA });
  check('cancel notifies pending invitee', (await notifs(qq, 'game_cancelled', peteA)) === 1);
  await createGame(pete, {}, { backdate: false });
  await expectError('cancelled games still count toward the limit', () => createGame(pete, {}, { backdate: false }), 'DAILY_LIMIT_REACHED');
  await q(`update games set created_at = now() - interval '3 days' where organizer_id = any($1)`, [[olivia, pete]]);

  console.log('\n== New-game alerts');
  check('eligible opted-in player alerted', (await notifs(nina, 'new_game_nearby', game1)) === 1);
  check('wrong level not alerted', (await notifs(ben, 'new_game_nearby', game1)) === 0);
  check('out of radius not alerted', (await notifs(far, 'new_game_nearby', game1)) === 0);
  check('opted-out (default) not alerted', (await notifs(quiet, 'new_game_nearby', game1)) === 0);
  check('invite-only intermediate game alerts intermediate player', (await notifs(nina, 'new_game_nearby', game2)) === 1);

  console.log('\n== Visibility + browse');
  check('open game visible to a beginner', (await as(ben, `select * from games where id = $1`, [game1])).rowCount === 1);
  check('open game roster visible to anyone', (await as(ben, `select * from game_players where game_id = $1`, [game1])).rowCount === 1);
  check('invite-only intermediate game visible to intermediate', (await as(nina, `select * from games where id = $1`, [game2])).rowCount === 1);
  check('invite-only intermediate game hidden from beginner', (await as(ben, `select * from games where id = $1`, [game2])).rowCount === 0);
  const browseN = await rpc(nina, 'browse_games', { p_sport_slug: 'soccer' });
  const b1 = browseN.find((g) => g.id === game1), b2 = browseN.find((g) => g.id === game2);
  check('browse: open game can_join for intermediate', b1?.can_join === true && b1?.can_request === false, b1);
  check('browse: invite-only can_request for intermediate', b2?.can_request === true && b2?.can_join === false, b2);
  check('browse: spots_left and distance', b1?.spots_left === 9 && Number(b1?.distance_miles) === 0, b1);
  const browseB = await rpc(ben, 'browse_games', { p_sport_slug: 'soccer' });
  check('browse: beginner sees open game but cannot join, no invite-only game',
    browseB.find((g) => g.id === game1)?.can_join === false && !browseB.some((g) => g.id === game2));

  console.log('\n== join_game');
  check('join open game', (await rpc(nina, 'join_game', { p_game_id: game1 })) === 'joined');
  check('join again is idempotent', (await rpc(nina, 'join_game', { p_game_id: game1 })) === 'joined');
  check('organizer notified (player_joined)', (await notifs(olivia, 'player_joined', game1)) === 1);
  await expectError('beginner joins intermediate+advanced game', () => rpc(ben, 'join_game', { p_game_id: game1 }), 'NOT_ELIGIBLE');
  await expectError('join an invite-only game', () => rpc(nina, 'join_game', { p_game_id: game2 }), 'FORBIDDEN');

  console.log('\n== Join requests');
  const req = await rpc(nina, 'request_to_join', { p_game_id: game2 });
  check('request again returns same id', (await rpc(nina, 'request_to_join', { p_game_id: game2 })) === req);
  check('organizer notified (join_request_received)', (await notifs(olivia, 'join_request_received', game2)) === 1);
  await expectError('beginner requests', () => rpc(ben, 'request_to_join', { p_game_id: game2 }), 'FORBIDDEN');
  await expectError('non-organizer approves', () => rpc(nina, 'respond_to_join_request', { p_request_id: req, p_response: 'approved' }), 'FORBIDDEN');
  check('approve onto Team B', (await rpc(olivia, 'respond_to_join_request', { p_request_id: req, p_response: 'approved', p_team: 'B' })) === 'approved');
  check('approved player is on Team B', (await one(`select team from game_players where game_id = $1 and player_id = $2`, [game2, nina])).team === 'B');
  check('player notified (join_request_approved)', (await notifs(nina, 'join_request_approved', game2)) === 1);
  const req2 = await rpc(p1, 'request_to_join', { p_game_id: game2 });
  check('decline', (await rpc(olivia, 'respond_to_join_request', { p_request_id: req2, p_response: 'declined' })) === 'declined');
  check('player notified (join_request_declined)', (await notifs(p1, 'join_request_declined', game2)) === 1);
  const req3 = await rpc(p2, 'request_to_join', { p_game_id: game2 });
  check('requester cancels own request', (await rpc(p2, 'cancel_join_request', { p_request_id: req3 })) === 'cancelled');
  check('outsider cannot read join requests', (await as(ben, `select * from join_requests where game_id = $1`, [game2])).rowCount === 0);

  console.log('\n== Team size + invite to a team');
  const gameT = await createGame(olivia, { p_title: '2v2', p_team_size: 2, p_max_players: 4 });
  await rpc(olivia, 'set_team', { p_game_id: gameT, p_player_id: olivia, p_team: 'A' });
  check('invite onto Team A, accept lands on A', (await addPlayer(olivia, gameT, p1, 'A')) === 'accepted'
    && (await one(`select team from game_players where game_id = $1 and player_id = $2`, [gameT, p1])).team === 'A');
  const invA = await rpc(olivia, 'send_invitation', { p_game_id: gameT, p_recipient_id: p2, p_team: 'A' });
  check('invitation stores team', (await one(`select team from invitations where id = $1`, [invA])).team === 'A');
  await expectError('accept onto a full team', () => rpc(p2, 'respond_to_invitation', { p_invitation_id: invA, p_response: 'accepted' }), 'TEAM_FULL');
  check('invite stays pending after TEAM_FULL', (await one(`select status from invitations where id = $1`, [invA])).status === 'pending');
  await addPlayer(olivia, gameT, p3);
  await expectError('set_team onto a full team', () => rpc(olivia, 'set_team', { p_game_id: gameT, p_player_id: p3, p_team: 'A' }), 'TEAM_FULL');
  check('set_team onto team with room', (await rpc(olivia, 'set_team', { p_game_id: gameT, p_player_id: p3, p_team: 'B' })) === 'B');
  await expectError('bad team on invite', () => rpc(olivia, 'send_invitation', { p_game_id: gameT, p_recipient_id: qq, p_team: 'C' }), 'VALIDATION');

  console.log('\n== Bulk invite');
  const bulk = await rpc(olivia, 'send_invitations', { p_game_id: game1, p_recipient_ids: [qq, mei, olivia, p2], p_team: 'A' });
  const byId = Object.fromEntries(bulk.map((r) => [r.recipient_id, r]));
  check('bulk: valid players invited', byId[qq]?.invitation_id && !byId[qq]?.error && byId[p2]?.invitation_id && !byId[p2]?.error, bulk);
  check('bulk: player without the sport skipped (VALIDATION)', byId[mei]?.error === 'VALIDATION' && !byId[mei]?.invitation_id);
  check('bulk: organizer skipped (VALIDATION)', byId[olivia]?.error === 'VALIDATION');
  check('bulk invites carry the team', (await one(`select team from invitations where id = $1`, [byId[qq].invitation_id])).team === 'A');
  await expectError('bulk by non-organizer', () => rpc(nina, 'send_invitations', { p_game_id: game1, p_recipient_ids: [qq] }), 'FORBIDDEN');

  console.log('\n== Squads');
  const [sq] = await rpc(olivia, 'create_squad', { p_name: 'Downtown Ballers', p_sport_slug: 'soccer' });
  check('create_squad returns id + 8-char code', sq?.id && /^[0-9A-F]{8}$/.test(sq.join_code), sq);
  check('join with code (case-insensitive)', (await rpc(p3, 'join_squad', { p_join_code: sq.join_code.toLowerCase() })) === sq.id);
  check('join again is idempotent', (await rpc(p3, 'join_squad', { p_join_code: sq.join_code })) === sq.id);
  check('captain notified (squad_member_joined)', (await notifs(olivia, 'squad_member_joined')) === 1);
  await expectError('join without playing the sport', () => rpc(mei, 'join_squad', { p_join_code: sq.join_code }), 'VALIDATION');
  await expectError('unknown code', () => rpc(p3, 'join_squad', { p_join_code: 'NOPE1234' }), 'FORBIDDEN');
  await expectError('non-member cannot read join codes', () => as(ben, `select join_code from squads`), 'permission denied');
  check('member sees code in my_squads', (await as(p3, `select join_code from my_squads where id = $1`, [sq.id])).rows[0]?.join_code === sq.join_code);
  check('non-member sees nothing in my_squads', (await as(ben, `select * from my_squads`)).rowCount === 0);
  const sqInv = await rpc(olivia, 'invite_squad', { p_game_id: game1, p_squad_id: sq.id, p_team: 'B' });
  check('invite_squad invites members except organizer', sqInv.length === 1 && sqInv[0].recipient_id === p3 && sqInv[0].invitation_id, sqInv);
  const sqRow = await one(`select team, squad_id from invitations where id = $1`, [sqInv[0].invitation_id]);
  check('squad invitation has team B and squad_id', sqRow.team === 'B' && sqRow.squad_id === sq.id);
  check('notification shows squad name',
    (await one(`select data->>'squad_name' s from notifications where invitation_id = $1`, [sqInv[0].invitation_id])).s === 'Downtown Ballers');
  await rpc(p3, 'respond_to_invitation', { p_invitation_id: sqInv[0].invitation_id, p_response: 'accepted' });
  check('squad member lands on Team B', (await one(`select team from game_players where game_id = $1 and player_id = $2`, [game1, p3])).team === 'B');
  const ybor = (await one(`select id from squads where join_code = 'YBORFC26'`)).id;
  const yInv = await rpc(olivia, 'invite_squad', { p_game_id: game1, p_squad_id: ybor });
  check('inviting another squad invites all 3 members (levels don\'t limit invites)', yInv.filter((r) => r.invitation_id).length === 3, yInv);
  await expectError('invite a squad of another sport', async () => {
    const [vb] = await rpc(mei, 'create_squad', { p_name: 'Spikers', p_sport_slug: 'volleyball' });
    await rpc(olivia, 'invite_squad', { p_game_id: game1, p_squad_id: vb.id });
  }, 'VALIDATION');
  await expectError('captain cannot leave', () => rpc(olivia, 'leave_squad', { p_squad_id: sq.id }), 'FORBIDDEN');
  await expectError('non-captain removes member', () => rpc(p3, 'remove_squad_member', { p_squad_id: ybor, p_player_id: camila }), 'FORBIDDEN');
  check('member leaves', (await rpc(p3, 'leave_squad', { p_squad_id: sq.id })) === 'left');
  check('captain deletes squad', (await rpc(olivia, 'delete_squad', { p_squad_id: sq.id })) === 'deleted');

  console.log('\n== Withdraw + emergency replacement');
  const w1 = await player('w1', 'Will One', 'downtown', 10, [['soccer', 'intermediate']]);
  const w2 = await player('w2', 'Will Two', 'downtown', 10, [['soccer', 'intermediate']]);
  const x1 = await player('x1', 'Xena', 'downtown', 10, [['soccer', 'intermediate']]);
  const gameR = await createGame(olivia, { p_title: 'Kickoff Soon', p_join_mode: 'open', p_team_size: 2, p_max_players: 4, p_starts_at: inMinutes(45) });
  await rpc(olivia, 'set_team', { p_game_id: gameR, p_player_id: olivia, p_team: 'A' });
  await addPlayer(olivia, gameR, w1, 'A');
  await addPlayer(olivia, gameR, w2, 'B');
  await addPlayer(olivia, gameR, x1, 'B');
  await expectError('organizer withdraws', () => rpc(olivia, 'withdraw_from_game', { p_game_id: gameR }), 'FORBIDDEN');
  await expectError('non-member withdraws', () => rpc(ben, 'withdraw_from_game', { p_game_id: gameR }), 'FORBIDDEN');
  check('withdraw → withdrawn', (await rpc(w1, 'withdraw_from_game', { p_game_id: gameR })) === 'withdrawn');
  check('withdraw again → withdrawn', (await rpc(w1, 'withdraw_from_game', { p_game_id: gameR })) === 'withdrawn');
  check('organizer notified exactly once', (await notifs(olivia, 'player_withdrew', gameR)) === 1);
  check('one replacement alert (no duplicates)', (await one(`select count(*)::int c from replacement_alerts where game_id = $1`, [gameR])).c === 1);
  check('eligible nearby player alerted', (await notifs(nina, 'replacement_needed', gameR)) === 1);
  check('withdrawing player not alerted', (await notifs(w1, 'replacement_needed', gameR)) === 0);
  check('roster players not alerted', (await notifs(w2, 'replacement_needed', gameR)) === 0 && (await notifs(x1, 'replacement_needed', gameR)) === 0);
  check('organizer not alerted', (await notifs(olivia, 'replacement_needed', gameR)) === 0);
  check('opted-out player not alerted', (await notifs(optout, 'replacement_needed', gameR)) === 0);
  check('out-of-radius player not alerted', (await notifs(far, 'replacement_needed', gameR)) === 0);
  check('player without the sport not alerted', (await notifs(mei, 'replacement_needed', gameR)) === 0);
  check('alert recipient can see the game', (await as(nina, `select * from games where id = $1`, [gameR])).rowCount === 1);
  check('withdrawn player left the roster', (await one(`select count(*)::int c from game_players where game_id = $1 and player_id = $2`, [gameR, w1])).c === 0);
  await expectError('non-recipient claims', () => rpc(optout, 'claim_replacement_spot', { p_game_id: gameR }), 'NOT_ELIGIBLE');
  check('recipient claims → joined', (await rpc(nina, 'claim_replacement_spot', { p_game_id: gameR })) === 'joined');
  check('claimer takes the withdrawn player\'s team (A)', (await one(`select team from game_players where game_id = $1 and player_id = $2`, [gameR, nina])).team === 'A');
  check('organizer notified (replacement_joined)', (await notifs(olivia, 'replacement_joined', gameR)) === 1);
  await expectError('second claimer for the last spot', () => rpc(p1, 'claim_replacement_spot', { p_game_id: gameR }), 'GAME_FULL');
  check('alert notifications are private', (await as(olivia, `select * from notifications where user_id = $1`, [nina])).rowCount === 0);

  const gameN = await createGame(olivia, { p_title: 'Later Game', p_join_mode: 'open', p_starts_at: inMinutes(180) });
  await rpc(qq, 'join_game', { p_game_id: gameN });
  await rpc(qq, 'withdraw_from_game', { p_game_id: gameN });
  check('withdraw > 60 min before: organizer notified, no replacement alert',
    (await notifs(olivia, 'player_withdrew', gameN)) === 1 && (await one(`select count(*)::int c from replacement_alerts where game_id = $1`, [gameN])).c === 0);
  await rpc(qq, 'join_game', { p_game_id: gameN });
  await setStart(gameN, '-1 minute');
  await expectError('withdraw after kickoff', () => rpc(qq, 'withdraw_from_game', { p_game_id: gameN }), 'GAME_UNAVAILABLE');

  console.log('\n== Game chat');
  const msg = await rpc(nina, 'send_game_message', { p_game_id: gameR, p_body: '  On my way!  ' });
  check('roster member sends a message', /^[0-9a-f-]{36}$/.test(msg));
  check('message trimmed', (await one(`select body from game_messages where id = $1`, [msg])).body === 'On my way!');
  check('roster member reads chat', (await as(w2, `select * from game_messages where game_id = $1`, [gameR])).rowCount === 1);
  check('withdrawn player cannot read chat', (await as(w1, `select * from game_messages where game_id = $1`, [gameR])).rowCount === 0);
  await expectError('withdrawn player cannot send', () => rpc(w1, 'send_game_message', { p_game_id: gameR, p_body: 'hi' }), 'FORBIDDEN');
  check('outsider cannot read chat', (await as(ben, `select * from game_messages where game_id = $1`, [gameR])).rowCount === 0);
  await expectError('outsider cannot send', () => rpc(ben, 'send_game_message', { p_game_id: gameR, p_body: 'hi' }), 'FORBIDDEN');
  await expectError('empty message', () => rpc(w2, 'send_game_message', { p_game_id: gameR, p_body: '   ' }), 'VALIDATION');
  await expectError('no direct message inserts', () => as(nina, `insert into game_messages (game_id, sender_id, body) values ($1, $2, 'x')`, [gameR, nina]), 'permission denied');
  const dot = async (uid) => (await as(uid, `select has_new from my_game_chat_status where game_id = $1`, [gameR])).rows[0]?.has_new;
  check('"new" dot on for other players', (await dot(w2)) === true);
  check('"new" dot off for the sender', (await dot(nina)) === false);
  await rpc(w2, 'mark_chat_read', { p_game_id: gameR });
  check('"new" dot off after mark_chat_read', (await dot(w2)) === false);

  console.log('\n== Notifications');
  const unread = (await one(`select count(*)::int c from notifications where user_id = $1 and read_at is null`, [nina])).c;
  check(`mark all read (${unread})`, (await rpc(nina, 'mark_notifications_read', {})) === unread && unread > 0);
  check('nothing unread afterwards', (await one(`select count(*)::int c from notifications where user_id = $1 and read_at is null`, [nina])).c === 0);
  await expectError('clients cannot create notifications', () => as(nina, `insert into notifications (user_id, type, title) values ($1, 'x', 'x')`, [olivia]), 'permission denied');

  console.log('\n== Peer-rated levels + anonymous reviews');
  const leo = await player('leo', 'Leo Learner', 'downtown', 10, [['soccer', 'beginner']]);
  const ra = await player('ra', 'Rater A', 'downtown', 10, [['soccer', 'intermediate']]);
  const rb = await player('rb', 'Rater B', 'downtown', 10, [['soccer', 'intermediate']]);
  const rc = await player('rc', 'Rater C', 'downtown', 10, [['soccer', 'intermediate']]);
  async function playGame(teamA, teamB, perf, scoreA, scoreB, confirmer) {
    const g = await createGame(olivia, { p_title: 'Rated Game', p_starts_at: inMinutes(120) });
    await rpc(olivia, 'set_team', { p_game_id: g, p_player_id: olivia, p_team: teamA.includes(olivia) ? 'A' : 'B' });
    for (const u of [...teamA, ...teamB].filter((u) => u !== olivia)) await addPlayer(olivia, g, u, teamA.includes(u) ? 'A' : 'B');
    await setStart(g, '-1 minute');
    await rpc(olivia, 'submit_results', { p_game_id: g, p_team_a_score: scoreA, p_team_b_score: scoreB, p_performances: perf });
    await rpc(confirmer, 'confirm_results', { p_game_id: g });
    return g;
  }
  const g1 = await playGame([leo, ra], [olivia, rb], [{ player_id: leo, goals: 3 }, { player_id: olivia, goals: 1 }], 3, 1, ra);
  check('results_submitted / results_confirmed notifications', (await notifs(leo, 'results_submitted', g1)) === 1 && (await notifs(leo, 'results_confirmed', g1)) === 1);
  await expectError('skill rating 7', () => rpc(ra, 'submit_review', { p_game_id: g1, p_reviewee_id: leo, p_rating: 4, p_comment: '', p_skill_rating: 7 }), 'VALIDATION');
  await rpc(ra, 'submit_review', { p_game_id: g1, p_reviewee_id: leo, p_rating: 4, p_comment: 'Great finisher', p_skill_rating: 5 });
  await rpc(rb, 'submit_review', { p_game_id: g1, p_reviewee_id: leo, p_rating: 5, p_comment: '', p_skill_rating: 5 });
  let us = await one(`select skill_level, level_source, rating_count from user_sports where user_id = $1 and sport_slug = 'soccer'`, [leo]);
  check('2 raters in 1 game: still self-rated beginner', us.skill_level === 'beginner' && us.level_source === 'self' && us.rating_count === 2, us);
  const g2 = await playGame([leo, rc], [olivia, ra], [{ player_id: leo, goals: 2 }, { player_id: olivia, goals: 1 }], 2, 1, rc);
  await rpc(rc, 'submit_review', { p_game_id: g2, p_reviewee_id: leo, p_rating: 4, p_comment: '', p_skill_rating: 5 });
  us = await one(`select skill_level, level_source, rating_count from user_sports where user_id = $1 and sport_slug = 'soccer'`, [leo]);
  check('3 raters across 2 games: verified intermediate', us.skill_level === 'intermediate' && us.level_source === 'verified' && us.rating_count === 3, us);
  const score = (await one(`select score from private.skill_scores where player_id = $1 and sport_slug = 'soccer'`, [leo])).score;
  check(`score matches the contract example (2.79, got ${score})`, Number(score) === 2.79);
  check('level_changed notification', (await notifs(leo, 'level_changed')) === 1);
  await expectError('verified level cannot be changed by the player', () => rpc(leo, 'save_profile', { p_display_name: 'Leo Learner', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '', p_sports: [{ sport_slug: 'soccer', skill_level: 'advanced' }] }), 'LEVEL_LOCKED');
  await rpc(leo, 'save_profile', { p_display_name: 'Leo Learner', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '', p_sports: [{ sport_slug: 'soccer', skill_level: 'intermediate' }, { sport_slug: 'volleyball', skill_level: 'advanced' }] });
  const both = (await q(`select sport_slug, skill_level, level_source from user_sports where user_id = $1 order by 1`, [leo])).rows;
  check('saving keeps verified level; new sport starts self-rated', both[0].level_source === 'verified' && both[1].sport_slug === 'volleyball' && both[1].level_source === 'self', both);
  await rpc(leo, 'save_profile', { p_display_name: 'Leo Learner', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '', p_sports: [{ sport_slug: 'volleyball', skill_level: 'advanced' }] });
  await rpc(leo, 'save_profile', { p_display_name: 'Leo Learner', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '', p_sports: [{ sport_slug: 'soccer', skill_level: 'beginner' }, { sport_slug: 'volleyball', skill_level: 'advanced' }] })
    .then(() => bad('removing and re-adding a sport keeps the lock', 'no error'),
          (e) => check('removing and re-adding a sport keeps the lock → LEVEL_LOCKED', e.message === 'LEVEL_LOCKED', e.message));
  check('reviewee cannot see who reviewed them', (await as(leo, `select * from reviews where reviewee_id = $1`, [leo])).rowCount === 0);
  check('reviewer sees only reviews they wrote', (await as(ra, `select * from reviews`)).rowCount === 1);
  const pr = (await as(ben, `select * from public_reviews where reviewee_id = $1`, [leo])).rows;
  check('public_reviews: 3 reviews, no reviewer/game/date columns', pr.length === 3
    && !('reviewer_id' in pr[0]) && !('game_id' in pr[0]) && !('created_at' in pr[0]) && pr.every((r) => r.skill_rating === 5));
  await expectError('anonymous visitors cannot read reviews', () => as(null, `select * from public_reviews`), 'permission denied');
  await expectError('no direct writes to new tables (squads)', () => as(olivia, `update squads set name = 'x'`), 'permission denied');
  await expectError('hidden scores not readable by clients', () => as(leo, `select * from private.skill_scores`), 'permission denied');
  check('auto_assign_teams still balances with team_size', await (async () => {
    const g = await createGame(olivia, { p_title: 'Auto 2v2', p_team_size: 2, p_max_players: 4 });
    for (const u of [ra, rb, rc]) await addPlayer(olivia, g, u);
    const t = await rpc(olivia, 'auto_assign_teams', { p_game_id: g });
    return t.filter((r) => r.team === 'A').length === 2 && t.filter((r) => r.team === 'B').length === 2;
  })());
} catch (e) {
  bad('UNEXPECTED ERROR', e.stack);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await client.end();
  await db.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
