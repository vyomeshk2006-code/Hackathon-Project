// Local test suite for the Supabase backend (docs/database-contract-v2.md).
// Spins up a throwaway Postgres, fakes Supabase's auth schema and roles
// (supabase_stub.sql), runs every migration + seed, then checks both
// contract milestones and the security rules.
//
//   cd supabase/tests && npm install && npm test
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ?? path.resolve(here, '..', '..');   // repo root containing supabase/
const dataDir = path.join(here, 'data-' + Date.now());
const conn = { host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' };

const db = new EmbeddedPostgres({ databaseDir: dataDir, user: conn.user, password: conn.password, port: conn.port,
  persistent: false, initdbFlags: ['--encoding=UTF8', '--locale=C'] });
await db.initialise();
await db.start();
const client = new pg.Client(conn);
await client.connect();

let pass = 0, fail = 0;
const ok = (name) => { pass++; console.log('  PASS', name); };
const bad = (name, info) => { fail++; console.log('  FAIL', name, info ?? ''); };
const check = (name, cond, info) => (cond ? ok(name) : bad(name, typeof info === 'object' ? JSON.stringify(info) : info));
const q = (sql, p) => client.query(sql, p);
const one = async (sql, p) => (await q(sql, p)).rows[0];

// Run SQL as a logged-in user (or anon when uid is null), the way PostgREST does.
async function as(uid, sql, params = [], c = client) {
  await c.query('begin');
  try {
    await c.query(`set local role ${uid ? 'authenticated' : 'anon'}`);
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    const res = await c.query(sql, params);
    await c.query('commit');
    return res;
  } catch (e) { await c.query('rollback'); throw e; }
}
const rpc = async (uid, fn, args = {}) => {
  const keys = Object.keys(args);
  const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
  const res = await as(uid, sql, keys.map((k) => (args[k] !== null && typeof args[k] === 'object' ? JSON.stringify(args[k]) : args[k])));
  const out = res.rows.length === 1 && Object.keys(res.rows[0]).length === 1 ? Object.values(res.rows[0])[0] : res.rows;
  // v3 limits users to 2 new games per day; backdate test games so this v2 suite can create many.
  if (fn === 'create_game' && typeof out === 'string')
    await q(`update public.games set created_at = now() - interval '3 days' where id = $1`, [out]);
  return out;
};
async function expectError(name, fn, code) {
  try { await fn(); bad(name, '(no error raised)'); }
  catch (e) { check(`${name} → ${code}`, e.message === code || new RegExp(code).test(e.message), `got: ${e.message}`); }
}
// move a game's start time (admin only, bypasses triggers/RLS) to simulate time passing
const setStart = (gameId, sqlInterval) =>
  q(`update public.games set starts_at = now() + interval '${sqlInterval}' where id = '${gameId}'`);
const newUser = async (email) => {
  const id = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, email]);
  return id;
};

try {
  await q(fs.readFileSync(path.join(here, 'supabase_stub.sql'), 'utf8'));
  // Runs every migration (v2 + v3) so this suite also proves v3 keeps v2 calls working.
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) {
    await q(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8'));
    console.log('ran', f);
  }
  await q(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  console.log('ran seed.sql');

  const demoId = async (h) => (await one(`select id from auth.users where email = $1`, [`${h}@demo.pickuptampa.test`])).id;
  const marcus = await demoId('marcus'), daniel = await demoId('daniel'), kevin = await demoId('kevin'),
        mei = await demoId('mei'), aisha = await demoId('aisha');

  console.log('\n== Seed');
  const c = await one(`select (select count(*) from profiles)::int p, (select count(*) from games)::int g,
                              (select count(*) from game_results where status='final')::int r, (select count(*) from sports)::int s,
                              (select count(*) from neighborhoods)::int n`);
  check('12 profiles, 15 games, 11 final results, 13 sports (4 + 9 added in v4), 16 neighborhoods (6 + 10 added in v5)', c.p === 12 && c.g === 15 && c.r === 11 && c.s === 13 && c.n === 16, c);

  console.log('\n== Access basics');
  check('anon can read sports', (await as(null, `select * from sports`)).rowCount === 13);
  await expectError('anon cannot read profiles', () => as(null, `select * from profiles`), 'permission denied');
  await expectError('anon cannot call functions', () => rpc(null, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y',
    p_neighborhood: 'downtown', p_starts_at: new Date(Date.now() + 864e5).toISOString(), p_max_players: 10 }), 'permission denied');
  await expectError('private helpers not callable by anon', () => as(null, `select private.is_game_player(gen_random_uuid())`), 'permission denied');
  await expectError('no direct table writes', () => as(marcus, `insert into games (organizer_id, sport_slug, title, venue, neighborhood, starts_at, max_players)
      values ($1,'soccer','x','y','downtown', now() + interval '1 day', 10)`, [marcus]), 'permission denied');
  await expectError('no direct profile edits', () => as(marcus, `update profiles set display_name='x' where id=$1`, [marcus]), 'permission denied');

  console.log('\n== Milestone 1: signup → onboarding');
  const sam = await newUser('sam@example.com');
  check('new signup has no profile yet (onboarding gate)', (await as(sam, `select * from profiles where id=$1`, [sam])).rowCount === 0);
  await expectError('create_game before onboarding', () => rpc(sam, 'create_game', { p_sport_slug: 'soccer', p_title: 'x', p_venue: 'y',
    p_neighborhood: 'downtown', p_starts_at: new Date(Date.now() + 864e5).toISOString(), p_max_players: 10 }), 'PROFILE_REQUIRED');
  const profileArgs = (over = {}) => ({ p_display_name: '  Sam Lee ', p_neighborhood: 'west-tampa', p_travel_radius_miles: 10, p_bio: 'Forward',
    p_sports: [{ sport_slug: 'soccer', skill_level: 'intermediate' }],
    p_username: 'samlee', p_phone: '(813) 555-0199', ...over });   // v5: new profiles need username + phone
  await expectError('no sports', () => rpc(sam, 'save_profile', profileArgs({ p_sports: [] })), 'VALIDATION');
  await expectError('duplicate sport', () => rpc(sam, 'save_profile', profileArgs({ p_sports: [{ sport_slug: 'soccer', skill_level: 'beginner' }, { sport_slug: 'soccer', skill_level: 'advanced' }] })), 'VALIDATION');
  await expectError('unknown neighborhood', () => rpc(sam, 'save_profile', profileArgs({ p_neighborhood: 'miami' })), 'VALIDATION');
  await expectError('bad skill', () => rpc(sam, 'save_profile', profileArgs({ p_sports: [{ sport_slug: 'soccer', skill_level: 'pro' }] })), 'VALIDATION');
  await expectError('radius over 50', () => rpc(sam, 'save_profile', profileArgs({ p_travel_radius_miles: 51 })), 'VALIDATION');
  await expectError('bio over 300', () => rpc(sam, 'save_profile', profileArgs({ p_bio: 'x'.repeat(301) })), 'VALIDATION');
  check('save_profile returns caller id', (await rpc(sam, 'save_profile', profileArgs())) === sam);
  const sp = await one(`select display_name from profiles where id=$1`, [sam]);
  check('display name trimmed', sp.display_name === 'Sam Lee');
  await rpc(sam, 'save_profile', profileArgs({ p_sports: [{ sport_slug: 'soccer', skill_level: 'advanced' }, { sport_slug: 'pickleball', skill_level: 'beginner' }] }));
  const sports = (await q(`select sport_slug, skill_level from user_sports where user_id=$1 order by 1`, [sam])).rows;
  check('second save replaces sports', sports.length === 2 && sports[1].skill_level === 'advanced', sports);
  await rpc(sam, 'save_profile', profileArgs());

  console.log('\n== Milestone 1: create game');
  const soon = () => new Date(Date.now() + 2 * 3600e3).toISOString();
  const game = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Demo Day Soccer', p_venue: 'Curtis Hixon Park',
    p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 10 });
  check('create_game returns uuid', /^[0-9a-f-]{36}$/.test(game));
  check('organizer is first roster player', (await one(`select count(*)::int c from game_players where game_id=$1 and player_id=$2`, [game, marcus])).c === 1);
  await expectError('past start time', () => rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Old', p_venue: 'Park',
    p_neighborhood: 'downtown', p_starts_at: new Date(Date.now() - 6e4).toISOString(), p_max_players: 10 }), 'VALIDATION');
  await expectError('max players 1', () => rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Tiny', p_venue: 'Park',
    p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 1 }), 'VALIDATION');
  // v4: every signed-in user can discover UPCOMING games (past games stay protected; see test_v4.mjs)
  check('(v4) upcoming game discoverable by outsider', (await as(kevin, `select * from games where id=$1`, [game])).rowCount === 1);
  check('(v4) upcoming roster discoverable by outsider', (await as(kevin, `select * from game_players where game_id=$1`, [game])).rowCount === 1);
  check('organizer sees own game', (await as(marcus, `select * from games where id=$1`, [game])).rowCount === 1);

  console.log('\n== Milestone 1: search');
  const found = await rpc(marcus, 'search_players', { p_sport_slug: 'soccer', p_neighborhood: 'downtown', p_game_id: game });
  const names = found.map((r) => r.display_name);
  check('Sam (West Tampa, 10 mi) found for a Downtown game', names.includes('Sam Lee'), names);
  check('caller excluded', !names.includes('Marcus Rivera'));
  check('sorted by distance', found.every((r, i) => i === 0 || Number(found[i - 1].distance_miles) <= Number(r.distance_miles)));
  check('result has rating fields', 'avg_rating' in found[0] && 'review_count' in found[0]);
  const far = await rpc(marcus, 'search_players', { p_sport_slug: 'soccer', p_neighborhood: 'usf' });
  check('radius respected: Kevin (South Tampa, 8 mi) not shown for a USF game', !far.some((r) => r.display_name === "Kevin O'Brien"));
  const adv = await rpc(marcus, 'search_players', { p_sport_slug: 'soccer', p_neighborhood: 'downtown', p_skill_level: 'advanced' });
  check('skill filter', adv.length > 0 && adv.every((r) => r.skill_level === 'advanced'));
  await expectError('unknown sport', () => rpc(marcus, 'search_players', { p_sport_slug: 'quidditch', p_neighborhood: 'downtown' }), 'VALIDATION');

  console.log('\n== Milestone 1: invite → accept → roster');
  const inv = await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: sam });
  check('send_invitation returns uuid', /^[0-9a-f-]{36}$/.test(inv));
  check('re-send returns the same pending invitation', (await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: sam })) === inv);
  await expectError('non-organizer invites', () => rpc(kevin, 'send_invitation', { p_game_id: game, p_recipient_id: sam }), 'FORBIDDEN');
  await expectError('recipient who does not play the sport', () => rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: mei }), 'VALIDATION');
  await expectError('invite yourself', () => rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: marcus }), 'VALIDATION');
  const inbox = await as(sam, `select * from invitations where recipient_id=$1 and status='pending'`, [sam]);
  check('recipient inbox shows invitation', inbox.rowCount === 1 && inbox.rows[0].sender_id === marcus);
  check('recipient with pending invite can read the game', (await as(sam, `select * from games where id=$1`, [game])).rowCount === 1);
  check('outsider cannot read the invitation', (await as(kevin, `select * from invitations where id=$1`, [inv])).rowCount === 0);
  const searchAfter = await rpc(marcus, 'search_players', { p_sport_slug: 'soccer', p_neighborhood: 'downtown', p_game_id: game });
  check('search hides players with a pending invite to this game', !searchAfter.some((r) => r.id === sam));
  await expectError("someone else responds", () => rpc(kevin, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' }), 'FORBIDDEN');
  await expectError('bad response value', () => rpc(sam, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'maybe' }), 'VALIDATION');
  check('accept → accepted', (await rpc(sam, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' })) === 'accepted');
  check('identical retry → accepted', (await rpc(sam, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' })) === 'accepted');
  await expectError('conflicting response', () => rpc(sam, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'declined' }), 'INVITATION_CLOSED');
  const roster = await as(marcus, `select p.display_name from game_players gp join profiles p on p.id = gp.player_id where gp.game_id=$1`, [game]);
  check('organizer sees Sam on roster (2/10)', roster.rowCount === 2 && roster.rows.some((r) => r.display_name === 'Sam Lee'));
  await expectError('invite someone already on roster', () => rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: sam }), 'VALIDATION');

  console.log('\n== Declined stays declined; cancelled can be re-invited');
  const ki = await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: kevin });
  check('decline → declined', (await rpc(kevin, 'respond_to_invitation', { p_invitation_id: ki, p_response: 'declined' })) === 'declined');
  await expectError('re-invite after decline', () => rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: kevin }), 'INVITATION_CLOSED');
  const ai = await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: aisha });
  await expectError('non-organizer cancels invitation', () => rpc(kevin, 'cancel_invitation', { p_invitation_id: ai }), 'FORBIDDEN');
  check('cancel_invitation → cancelled', (await rpc(marcus, 'cancel_invitation', { p_invitation_id: ai })) === 'cancelled');
  check('cancel retry → cancelled', (await rpc(marcus, 'cancel_invitation', { p_invitation_id: ai })) === 'cancelled');
  await expectError('respond to cancelled invitation', () => rpc(aisha, 'respond_to_invitation', { p_invitation_id: ai, p_response: 'accepted' }), 'INVITATION_CLOSED');
  const ai2 = await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: aisha });
  check('re-invite after cancel creates a new invitation', ai2 !== ai);

  console.log('\n== Capacity');
  const small = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: '1v1', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 2 });
  const s1 = await rpc(marcus, 'send_invitation', { p_game_id: small, p_recipient_id: sam });
  const s2 = await rpc(marcus, 'send_invitation', { p_game_id: small, p_recipient_id: daniel });
  await rpc(sam, 'respond_to_invitation', { p_invitation_id: s1, p_response: 'accepted' });
  await expectError('accept a full game', () => rpc(daniel, 'respond_to_invitation', { p_invitation_id: s2, p_response: 'accepted' }), 'GAME_FULL');
  check('competing invitation stays pending', (await one(`select status from invitations where id=$1`, [s2])).status === 'pending');
  await expectError('invite to a full game', () => rpc(marcus, 'send_invitation', { p_game_id: small, p_recipient_id: aisha }), 'GAME_FULL');

  // Two players race for the last spot in separate connections.
  const race = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Race', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 2 });
  const r1 = await rpc(marcus, 'send_invitation', { p_game_id: race, p_recipient_id: sam });
  const r2 = await rpc(marcus, 'send_invitation', { p_game_id: race, p_recipient_id: daniel });
  const c1 = new pg.Client(conn), c2 = new pg.Client(conn);
  await c1.connect(); await c2.connect();
  for (const [cl, uid] of [[c1, sam], [c2, daniel]]) {
    await cl.query('begin'); await cl.query('set local role authenticated');
    await cl.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
  }
  await c1.query(`select public.respond_to_invitation($1, 'accepted')`, [r1]);        // holds the game lock
  const p2 = c2.query(`select public.respond_to_invitation($1, 'accepted')`, [r2]).then(() => 'accepted', (e) => e.message);
  await new Promise((r) => setTimeout(r, 300));
  await c1.query('commit');
  const second = await p2;
  await c2.query(second === 'accepted' ? 'commit' : 'rollback');
  await c1.end(); await c2.end();
  check('concurrent last spot: exactly one wins, other gets GAME_FULL', second === 'GAME_FULL', second);
  check('race game roster is 2/2', (await one(`select count(*)::int c from game_players where game_id=$1`, [race])).c === 2);

  console.log('\n== Cancel game / started game');
  const cg = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Cancel me', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 10 });
  const ci = await rpc(marcus, 'send_invitation', { p_game_id: cg, p_recipient_id: sam });
  await expectError('non-organizer cancels game', () => rpc(sam, 'cancel_game', { p_game_id: cg }), 'FORBIDDEN');
  check('cancel_game → cancelled', (await rpc(marcus, 'cancel_game', { p_game_id: cg })) === 'cancelled');
  check('pending invitations cancelled too', (await one(`select status from invitations where id=$1`, [ci])).status === 'cancelled');
  await expectError('accept after cancel', () => rpc(sam, 'respond_to_invitation', { p_invitation_id: ci, p_response: 'accepted' }), 'INVITATION_CLOSED');
  const sg = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Started', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 10 });
  const si = await rpc(marcus, 'send_invitation', { p_game_id: sg, p_recipient_id: sam });
  await setStart(sg, '-1 minute');
  await expectError('accept after game started', () => rpc(sam, 'respond_to_invitation', { p_invitation_id: si, p_response: 'accepted' }), 'GAME_UNAVAILABLE');
  await expectError('invite after game started', () => rpc(marcus, 'send_invitation', { p_game_id: sg, p_recipient_id: daniel }), 'GAME_UNAVAILABLE');

  console.log('\n== Milestone 2: teams');
  const di = await rpc(marcus, 'send_invitation', { p_game_id: game, p_recipient_id: daniel });
  await rpc(daniel, 'respond_to_invitation', { p_invitation_id: di, p_response: 'accepted' });   // roster: marcus, sam, daniel
  await expectError('non-organizer sets team', () => rpc(sam, 'set_team', { p_game_id: game, p_player_id: sam, p_team: 'A' }), 'FORBIDDEN');
  await expectError('bad team value', () => rpc(marcus, 'set_team', { p_game_id: game, p_player_id: sam, p_team: 'C' }), 'VALIDATION');
  await expectError('player not on roster', () => rpc(marcus, 'set_team', { p_game_id: game, p_player_id: kevin, p_team: 'A' }), 'VALIDATION');
  check('set_team → A', (await rpc(marcus, 'set_team', { p_game_id: game, p_player_id: sam, p_team: 'A' })) === 'A');
  await setStart(game, '-1 minute');   // the game has now been played
  await expectError('results with incomplete teams', () => rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 1, p_team_b_score: 0, p_performances: [] }), 'TEAMS_INCOMPLETE');
  await rpc(marcus, 'set_team', { p_game_id: game, p_player_id: marcus, p_team: 'A' });
  await rpc(marcus, 'set_team', { p_game_id: game, p_player_id: daniel, p_team: 'B' });
  check('roster player can read teams', (await as(sam, `select team from game_players where game_id=$1 and team is not null`, [game])).rowCount === 3);

  const auto = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Auto', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 10 });
  for (const uid of [sam, daniel, aisha, kevin, await demoId('camila')]) {
    const i = await rpc(marcus, 'send_invitation', { p_game_id: auto, p_recipient_id: uid });
    await rpc(uid, 'respond_to_invitation', { p_invitation_id: i, p_response: 'accepted' });
  }
  const teams = await rpc(marcus, 'auto_assign_teams', { p_game_id: auto });
  const a = teams.filter((t) => t.team === 'A').length, b = teams.filter((t) => t.team === 'B').length;
  check(`auto_assign_teams returns {player_id, team} for all 6, balanced (${a} v ${b})`, teams.length === 6 && a === 3 && b === 3 && 'player_id' in teams[0]);
  await expectError('non-organizer auto-assigns', () => rpc(sam, 'auto_assign_teams', { p_game_id: auto }), 'FORBIDDEN');

  console.log('\n== Milestone 2: results → stats');
  const statsOf = async (uid) => (await as(sam, `select * from player_stats where player_id=$1`, [uid])).rows[0] ?? { games_played: 0, wins: 0, draws: 0, goals: 0 };
  const mBefore = await statsOf(marcus);
  const perf = [{ player_id: sam, goals: 2 }, { player_id: marcus, goals: 1, assists: 2 }, { player_id: daniel, goals: 1 }];
  await expectError('non-organizer submits', () => rpc(sam, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 1, p_performances: perf }), 'FORBIDDEN');
  await expectError('player not on roster in performances', () => rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 1, p_performances: [{ player_id: kevin, goals: 1 }] }), 'VALIDATION');
  await expectError('duplicate player in performances', () => rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 1, p_performances: [{ player_id: sam, goals: 1 }, { player_id: sam, goals: 1 }] }), 'VALIDATION');
  await expectError('negative goals', () => rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 1, p_performances: [{ player_id: sam, goals: -1 }] }), 'VALIDATION');
  await setStart(auto, '3 days');
  await expectError('submit before game day', () => rpc(marcus, 'submit_results', { p_game_id: auto, p_team_a_score: 1, p_team_b_score: 0, p_performances: [] }), 'RESULTS_TOO_EARLY');
  await expectError('confirm before any result', () => rpc(sam, 'confirm_results', { p_game_id: game }), 'RESULT_NOT_PENDING');
  check('submit_results → pending', (await rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 1, p_performances: perf })) === 'pending');
  check('game is completed', (await one(`select status from games where id=$1`, [game])).status === 'completed');
  check('pending invitations expired', (await one(`select status from invitations where id=$1`, [ai2])).status === 'expired');
  check('pending result does not change stats', (await statsOf(sam)).games_played === 0);
  check('roster player can read the result', (await as(sam, `select * from game_results where game_id=$1`, [game])).rowCount === 1);
  check('outsider cannot read the result', (await as(kevin, `select * from game_results where game_id=$1`, [game])).rowCount === 0);
  await expectError('organizer confirms own result', () => rpc(marcus, 'confirm_results', { p_game_id: game }), 'FORBIDDEN');
  await expectError('outsider confirms', () => rpc(kevin, 'confirm_results', { p_game_id: game }), 'FORBIDDEN');
  check('confirm → final', (await rpc(sam, 'confirm_results', { p_game_id: game })) === 'final');
  check('confirm retry → final', (await rpc(sam, 'confirm_results', { p_game_id: game })) === 'final');
  const samS = await statsOf(sam);
  check('Sam: 1 game, 1 win, 2 goals', samS.games_played === 1 && samS.wins === 1 && samS.goals === 2, samS);
  const mAfter = await statsOf(marcus);
  check(`Marcus: ${mBefore.games_played}→${mAfter.games_played} games, ${mBefore.wins}→${mAfter.wins} wins, ${mBefore.goals}→${mAfter.goals} goals`,
    mAfter.games_played === mBefore.games_played + 1 && mAfter.wins === mBefore.wins + 1 && mAfter.goals === mBefore.goals + 1);
  check('Daniel recorded as a loss', (await one(`select outcome from player_game_stats where game_id=$1 and player_id=$2`, [game, daniel])).outcome === 'loss');
  check('per-sport stats view', (await as(sam, `select * from player_sport_stats where player_id=$1 and sport_slug='soccer'`, [sam])).rows[0]?.goals === 2);

  console.log('\n== Corrections never double-count');
  const fix = [{ player_id: sam, goals: 2 }, { player_id: marcus, goals: 1 }, { player_id: daniel, goals: 3 }];
  await rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 3, p_performances: fix });
  check('while corrected result is pending, it drops out of stats', (await statsOf(sam)).games_played === 0);
  await expectError('dispute with empty reason', () => rpc(daniel, 'dispute_results', { p_game_id: game, p_reason: '  ' }), 'VALIDATION');
  check('dispute → disputed', (await rpc(daniel, 'dispute_results', { p_game_id: game, p_reason: 'It was 3-2' })) === 'disputed');
  await expectError('confirm a disputed result', () => rpc(sam, 'confirm_results', { p_game_id: game }), 'RESULT_NOT_PENDING');
  await rpc(marcus, 'submit_results', { p_game_id: game, p_team_a_score: 3, p_team_b_score: 3, p_performances: fix });
  await rpc(daniel, 'confirm_results', { p_game_id: game });
  const samF = await statsOf(sam);
  check('after correction: Sam 1 game, 0 wins, 1 draw, 2 goals', samF.games_played === 1 && samF.wins === 0 && samF.draws === 1 && samF.goals === 2, samF);
  check('revision = 3', (await one(`select revision from game_results where game_id=$1`, [game])).revision === 3);

  console.log('\n== Milestone 2: reviews');
  const pendingGame = await rpc(marcus, 'create_game', { p_sport_slug: 'soccer', p_title: 'Not final', p_venue: 'Park', p_neighborhood: 'downtown', p_starts_at: soon(), p_max_players: 10 });
  const pi = await rpc(marcus, 'send_invitation', { p_game_id: pendingGame, p_recipient_id: sam });
  await rpc(sam, 'respond_to_invitation', { p_invitation_id: pi, p_response: 'accepted' });
  await expectError('review before result is final', () => rpc(sam, 'submit_review', { p_game_id: pendingGame, p_reviewee_id: marcus, p_rating: 5, p_comment: '' }), 'NOT_ELIGIBLE');
  const rid = await rpc(sam, 'submit_review', { p_game_id: game, p_reviewee_id: marcus, p_rating: 5, p_comment: 'Great organizer' });
  check('submit_review returns uuid', /^[0-9a-f-]{36}$/.test(rid));
  await expectError('duplicate review', () => rpc(sam, 'submit_review', { p_game_id: game, p_reviewee_id: marcus, p_rating: 4, p_comment: '' }), 'ALREADY_REVIEWED');
  await expectError('review someone not in the game', () => rpc(sam, 'submit_review', { p_game_id: game, p_reviewee_id: kevin, p_rating: 4, p_comment: '' }), 'NOT_ELIGIBLE');
  await expectError('review yourself', () => rpc(sam, 'submit_review', { p_game_id: game, p_reviewee_id: sam, p_rating: 4, p_comment: '' }), 'NOT_ELIGIBLE');
  await expectError('outsider reviews', () => rpc(kevin, 'submit_review', { p_game_id: game, p_reviewee_id: sam, p_rating: 1, p_comment: '' }), 'NOT_ELIGIBLE');
  await expectError('rating 9', () => rpc(daniel, 'submit_review', { p_game_id: game, p_reviewee_id: sam, p_rating: 9, p_comment: '' }), 'VALIDATION');
  await rpc(daniel, 'submit_review', { p_game_id: game, p_reviewee_id: sam, p_rating: 4, p_comment: 'Good teammate' });
  const rating = (await as(kevin, `select * from player_ratings where player_id=$1`, [sam])).rows[0];
  check('Sam rating visible to anyone: 4.00 from 1 review', Number(rating.avg_rating) === 4 && rating.review_count === 1, rating);
  // v3 breaking change: reviews are anonymous and read through public_reviews.
  check('reviews readable on profile (public_reviews)', (await as(kevin, `select * from public_reviews where reviewee_id=$1`, [marcus])).rowCount === 3);
} catch (e) {
  bad('UNEXPECTED ERROR', e.stack);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await client.end();
  await db.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
