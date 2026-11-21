// v4 test suite (docs/database-contract-v4.md): discovery, sports catalog,
// per-sport metrics, descriptions. Same harness as test_v3.mjs.
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
const dataDir = path.join(here, 'data-v4-' + Date.now());
const conn = { host: 'localhost', port: 54332, user: 'postgres', password: 'pw', database: 'postgres' };

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

async function player(handle, sports, hood = 'downtown', extra = {}) {
  const id = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, `${handle}@test.local`]);
  await rpc(id, 'save_profile', { p_display_name: handle, p_neighborhood: hood, p_travel_radius_miles: 10, p_bio: '',
    p_sports: sports.map(([s, l]) => ({ sport_slug: s, skill_level: l })),
    p_username: 'u_' + handle, p_phone: '8135550123', ...extra });   // v5: username + phone required
  return id;
}
async function createGame(uid, args = {}) {
  const id = await rpc(uid, 'create_game', { p_sport_slug: 'soccer', p_title: 'Test Game', p_venue: 'Park',
    p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, ...args });
  await q(`update public.games set created_at = now() - interval '3 days' where id = $1`, [id]);   // skip the daily limit
  return id;
}
async function addPlayer(org, gameId, uid, team = null) {
  const inv = await rpc(org, 'send_invitation', { p_game_id: gameId, p_recipient_id: uid, p_team: team });
  return rpc(uid, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' });
}
// organizer on A, the others alternate; start time moved to the past so results can be entered
async function playedGame(org, sport, others, args = {}) {
  const g = await createGame(org, { p_sport_slug: sport, p_starts_at: inMinutes(120), ...args });
  await rpc(org, 'set_team', { p_game_id: g, p_player_id: org, p_team: 'A' });
  for (const [i, u] of others.entries()) await addPlayer(org, g, u, i % 2 === 0 ? 'B' : 'A');
  await setStart(g, '-1 minute');
  return g;
}

try {
  await q(fs.readFileSync(path.join(here, 'supabase_stub.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) { await q(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')); console.log('ran', f); }
  await q(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  console.log('ran seed.sql');

  console.log('\n== Sports catalog');
  check('13 seeded sports, readable without signing in', (await as(null, `select * from sports`)).rowCount === 13);
  const bb = (await as(null, `select stat_key from sport_stat_definitions where sport_slug = 'basketball' order by sort_order`)).rows.map((r) => r.stat_key);
  check('basketball metrics: points, rebounds, assists (ordered)', bb.join() === 'points,rebounds,assists', bb);
  const defs = (await as(null, `select sport_slug, count(*)::int c from sport_stat_definitions group by 1`)).rows;
  const byS = Object.fromEntries(defs.map((d) => [d.sport_slug, d.c]));
  check('default metrics per sport', byS.soccer === 2 && byS.cricket === 2 && byS.volleyball === 3 && byS.tennis === 1 && byS.badminton === 1 && !byS.pickleball && !byS.futsal, byS);
  check('seeded demo results backfilled into metric values', (await one(`select count(*)::int c from player_game_stat_values`)).c > 0);
  const anyUser = (await one(`select id from auth.users limit 1`)).id;
  await expectError('clients cannot edit metric definitions', () => as(anyUser, `delete from sport_stat_definitions`), 'permission denied');

  const ana = await player('ana', [['soccer', 'intermediate']]);
  const r1 = (await rpc(ana, 'create_sport', { p_name: 'Foot Volley' }))[0];
  check('create_sport → new sport with slug foot-volley', r1.created === true && r1.slug === 'foot-volley' && r1.name === 'Foot Volley', r1);
  const r2 = (await rpc(ana, 'create_sport', { p_name: '  foot   VOLLEY ' }))[0];
  check('same name, different case/spacing → same sport, not created', r2.created === false && r2.slug === 'foot-volley', r2);
  const r3 = (await rpc(ana, 'create_sport', { p_name: 'Foot-Volley' }))[0];
  check('distinct name with the same base slug → foot-volley-2', r3.created === true && r3.slug === 'foot-volley-2', r3);
  const r4 = (await rpc(ana, 'create_sport', { p_name: 'Spike Ball' }))[0];
  check('existing name reads back first display name', (await rpc(ana, 'create_sport', { p_name: 'spike ball' }))[0].name === r4.name);
  await expectError('1-character name', () => rpc(ana, 'create_sport', { p_name: 'x' }), 'VALIDATION');
  await expectError('41-character name', () => rpc(ana, 'create_sport', { p_name: 'a'.repeat(41) }), 'VALIDATION');
  await expectError('markup in name', () => rpc(ana, 'create_sport', { p_name: '<b>Ball</b>' }), 'VALIDATION');
  await expectError('must start with a letter or number', () => rpc(ana, 'create_sport', { p_name: '-Ball' }), 'VALIDATION');
  await expectError('anonymous visitors cannot create sports', () => rpc(null, 'create_sport', { p_name: 'Kabaddi' }), 'permission denied');
  check('custom sport has no metric definitions', (await one(`select count(*)::int c from sport_stat_definitions where sport_slug = 'foot-volley'`)).c === 0);

  // two sessions create the same new sport at the same time
  const c1 = new pg.Client(conn), c2 = new pg.Client(conn);
  await c1.connect(); await c2.connect();
  for (const c of [c1, c2]) {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [ana]);
  }
  const a1 = (await c1.query(`select * from public.create_sport('Kabaddi')`)).rows[0];
  const p2 = c2.query(`select * from public.create_sport('  KABADDI')`);
  await new Promise((r) => setTimeout(r, 300));
  await c1.query('commit');
  const a2 = (await p2).rows[0];
  await c2.query('commit'); await c1.end(); await c2.end();
  check('concurrent creates → one sport, second call returns it', a1.created === true && a2.created === false && a1.slug === a2.slug, { a1, a2 });
  check('exactly one Kabaddi row', (await one(`select count(*)::int c from sports where normalized_name = 'kabaddi'`)).c === 1);

  console.log('\n== Custom sport end to end');
  const fvOrg = await player('fvorg', [['foot-volley', 'intermediate']]);
  const fv1 = await player('fv1', [['foot-volley', 'beginner']]);
  const fvSquad = (await rpc(fv1, 'create_squad', { p_name: 'FV Crew', p_sport_slug: 'foot-volley' }))[0];
  check('squad for a custom sport', !!fvSquad?.join_code);
  const gFvUp = await createGame(fvOrg, { p_sport_slug: 'foot-volley', p_join_mode: 'open', p_team_size: 1, p_max_players: 2 });
  check('browse filters by custom sport', (await rpc(fv1, 'browse_games', { p_sport_query: 'foot volley' })).some((g) => g.id === gFvUp));
  check('join an open custom-sport game', (await rpc(fv1, 'join_game', { p_game_id: gFvUp })) === 'joined');
  await rpc(fvOrg, 'set_team', { p_game_id: gFvUp, p_player_id: fvOrg, p_team: 'A' });
  await rpc(fvOrg, 'set_team', { p_game_id: gFvUp, p_player_id: fv1, p_team: 'B' });
  await setStart(gFvUp, '-1 minute');
  await expectError('metric on a sport with no definitions', () => rpc(fvOrg, 'submit_results', { p_game_id: gFvUp, p_team_a_score: 1, p_team_b_score: 1, p_performances: [{ player_id: fv1, metrics: { spikes: 3 } }] }), 'VALIDATION');
  await rpc(fvOrg, 'submit_results', { p_game_id: gFvUp, p_team_a_score: 1, p_team_b_score: 1, p_performances: [] });
  await rpc(fv1, 'confirm_results', { p_game_id: gFvUp });
  const fvStats = (await as(ana, `select * from player_sport_stats where player_id = $1 and sport_slug = 'foot-volley'`, [fv1])).rows[0];
  check('custom-sport draw counted: 1 game, 1 draw, 0% wins', fvStats?.games_played === 1 && fvStats?.draws === 1 && Number(fvStats?.win_pct) === 0, fvStats);
  check('custom sport has no metric totals', (await as(ana, `select * from player_sport_metric_totals where player_id = $1`, [fv1])).rowCount === 0);
  check('levels still calculated for a custom sport', (await one(`select count(*)::int c from private.skill_scores where player_id = $1 and sport_slug = 'foot-volley'`, [fv1])).c === 1);

  console.log('\n== Soccer metrics, win %, revisions');
  const org = await player('org', [['soccer', 'advanced'], ['basketball', 'advanced']]);
  const sam = await player('sam', [['soccer', 'intermediate'], ['basketball', 'intermediate']]);
  const opp = await player('opp', [['soccer', 'intermediate'], ['basketball', 'intermediate']]);
  const out = await player('outsider', [['soccer', 'beginner']]);
  // Sam is on Team B (first "other"); opp on Team A with the organizer
  const s1 = await playedGame(org, 'soccer', [sam, opp]);
  await rpc(org, 'submit_results', { p_game_id: s1, p_team_a_score: 1, p_team_b_score: 2, p_performances: [{ player_id: sam, metrics: { goals: 2, assists: 1 } }] });
  await rpc(sam, 'confirm_results', { p_game_id: s1 });
  const s2 = await playedGame(org, 'soccer', [sam, opp]);
  await rpc(org, 'submit_results', { p_game_id: s2, p_team_a_score: 3, p_team_b_score: 1, p_performances: [{ player_id: sam, metrics: { goals: 1 } }] });
  await rpc(sam, 'confirm_results', { p_game_id: s2 });
  let st = (await as(out, `select * from player_sport_stats where player_id = $1 and sport_slug = 'soccer'`, [sam])).rows[0];
  check('2 matches, 1 win, 1 loss, 50% win rate', st.games_played === 2 && st.wins === 1 && st.losses === 1 && Number(st.win_pct) === 50, st);
  const mt = Object.fromEntries((await as(out, `select stat_key, total from player_sport_metric_totals where player_id = $1 and sport_slug = 'soccer'`, [sam])).rows.map((r) => [r.stat_key, r.total]));
  check('metric totals: 3 goals, 1 assist', mt.goals === 3 && mt.assists === 1, mt);
  check('legacy goals column kept in sync', st.goals === 3 && st.assists === 1);
  check('player_stats has win_pct', Number((await as(out, `select win_pct from player_stats where player_id = $1`, [sam])).rows[0].win_pct) === 50);
  check('legacy flat fields still accepted', await (async () => {
    const g = await playedGame(org, 'soccer', [sam, opp]);
    await rpc(org, 'submit_results', { p_game_id: g, p_team_a_score: 0, p_team_b_score: 1, p_performances: [{ player_id: sam, goals: 1 }] });
    return (await one(`select value from player_game_stat_values where game_id = $1 and player_id = $2 and stat_key = 'goals'`, [g, sam])).value === 1;
  })());

  const notifs = async () => (await one(`select count(*)::int c from notifications where user_id = $1 and type = 'results_confirmed' and game_id = $2`, [sam, s1])).c;
  const before = await notifs();
  check('identical confirm retry → final', (await rpc(sam, 'confirm_results', { p_game_id: s1 })) === 'final');
  check('retry adds no notifications and no extra match', (await notifs()) === before
    && (await as(out, `select games_played from player_sport_stats where player_id = $1 and sport_slug = 'soccer'`, [sam])).rows[0].games_played === 2);
  await rpc(org, 'submit_results', { p_game_id: s1, p_team_a_score: 1, p_team_b_score: 2, p_performances: [{ player_id: sam, metrics: { goals: 0, assists: 2 } }] });
  st = (await as(out, `select * from player_sport_stats where player_id = $1 and sport_slug = 'soccer'`, [sam])).rows[0];
  check('reopened result drops out of totals', st.games_played === 1 && st.wins === 0, st);
  await rpc(sam, 'dispute_results', { p_game_id: s1, p_reason: 'I had 2 goals' });
  await rpc(org, 'submit_results', { p_game_id: s1, p_team_a_score: 1, p_team_b_score: 2, p_performances: [{ player_id: sam, metrics: { goals: 2, assists: 2 } }] });
  await rpc(sam, 'confirm_results', { p_game_id: s1 });
  const mt2 = Object.fromEntries((await as(out, `select stat_key, total from player_sport_metric_totals where player_id = $1 and sport_slug = 'soccer'`, [sam])).rows.map((r) => [r.stat_key, r.total]));
  check('after correction totals reflect only the active final revision (3 goals, 2 assists)', mt2.goals === 3 && mt2.assists === 2, mt2);

  console.log('\n== Basketball metric validation');
  const b1 = await playedGame(org, 'basketball', [sam, opp]);
  const sub = (perf) => rpc(org, 'submit_results', { p_game_id: b1, p_team_a_score: 21, p_team_b_score: 18, p_performances: perf });
  await expectError('unknown metric key', () => sub([{ player_id: sam, metrics: { dunks: 1 } }]), 'VALIDATION');
  await expectError('negative value', () => sub([{ player_id: sam, metrics: { points: -1 } }]), 'VALIDATION');
  await expectError('non-integer value', () => sub([{ player_id: sam, metrics: { points: 2.5 } }]), 'VALIDATION');
  await expectError('over 32767', () => sub([{ player_id: sam, metrics: { points: 40000 } }]), 'VALIDATION');
  await expectError('player outside the roster', () => sub([{ player_id: out, metrics: { points: 4 } }]), 'VALIDATION');
  await expectError('repeated player', () => sub([{ player_id: sam, metrics: { points: 4 } }, { player_id: sam, metrics: { rebounds: 1 } }]), 'VALIDATION');
  await expectError('conflicting flat + nested value', () => sub([{ player_id: sam, points: 3, metrics: { points: 4 } }]), 'VALIDATION');
  await expectError('metrics must be an object', () => sub([{ player_id: sam, metrics: [1, 2] }]), 'VALIDATION');
  await sub([{ player_id: sam, metrics: { points: 10, rebounds: 5 }, goals: 2 }]);   // goals isn't a basketball metric: ignored (legacy)
  const vals = Object.fromEntries((await q(`select stat_key, value from player_game_stat_values where game_id = $1 and player_id = $2`, [b1, sam])).rows.map((r) => [r.stat_key, r.value]));
  check('one value per defined metric, omitted = 0', vals.points === 10 && vals.rebounds === 5 && vals.assists === 0 && !('goals' in vals), vals);
  check('roster can read per-game metric values', (await as(opp, `select * from player_game_stat_values where game_id = $1`, [b1])).rowCount === 9);
  check('outsider cannot read per-game metric values', (await as(out, `select * from player_game_stat_values where game_id = $1`, [b1])).rowCount === 0);
  check('outsider cannot read per-game results', (await as(out, `select * from game_results where game_id = $1`, [b1])).rowCount === 0);

  console.log('\n== Discovery');
  const beg = await player('beg', [['soccer', 'beginner']]);
  const adv = await player('adv', [['soccer', 'advanced']]);
  const adv2 = await player('adv2', [['soccer', 'advanced']]);
  const nosport = await player('nosport', [['pickleball', 'advanced']]);
  const noprof = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, 'noprofile@test.local')`, [noprof]);
  const gAdv = await createGame(org, { p_title: 'Advanced Only', p_join_mode: 'invite_only', p_skill_levels: ['advanced'], p_description: 'Bring cleats.' });
  check('invite-only advanced game visible to a beginner', (await as(beg, `select * from games where id = $1`, [gAdv])).rowCount === 1);
  check('...and to a player without the sport, and a user without a profile',
    (await as(nosport, `select * from games where id = $1`, [gAdv])).rowCount === 1 && (await as(noprof, `select * from games where id = $1`, [gAdv])).rowCount === 1);
  check('public roster visible', (await as(beg, `select p.display_name from game_players gp join profiles p on p.id = gp.player_id where gp.game_id = $1`, [gAdv])).rowCount === 1);
  const flag = async (uid) => (await rpc(uid, 'browse_games', {})).find((g) => g.id === gAdv);
  check('browse: beginner sees it, cannot request', (await flag(beg))?.can_request === false);
  check('browse: player without the sport cannot request', (await flag(nosport))?.can_request === false);
  const np = await flag(noprof);
  check('browse: user without a profile sees it, no actions', np && np.can_request === false && np.can_join === false, np);
  check('browse: advanced player can request', (await flag(adv))?.can_request === true);
  check('browse returns the description', (await flag(beg))?.description === 'Bring cleats.');
  await expectError('beginner requests advanced-only game', () => rpc(beg, 'request_to_join', { p_game_id: gAdv }), 'NOT_ELIGIBLE');
  await expectError('player without the sport requests', () => rpc(nosport, 'request_to_join', { p_game_id: gAdv }), 'NOT_ELIGIBLE');
  const reqA = await rpc(adv, 'request_to_join', { p_game_id: gAdv });
  check('request retry returns the same id', (await rpc(adv, 'request_to_join', { p_game_id: gAdv })) === reqA);
  check('pending request flag is caller-scoped', (await flag(adv))?.has_pending_request === true && (await flag(adv2))?.has_pending_request === false);
  check('outsider cannot read join requests', (await as(beg, `select * from join_requests where game_id = $1`, [gAdv])).rowCount === 0);
  // eligibility re-checked at approval: adv2 requests, then (still self-rated) changes level to beginner
  const reqB = await rpc(adv2, 'request_to_join', { p_game_id: gAdv });
  await rpc(adv2, 'save_profile', { p_display_name: 'adv2', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '', p_sports: [{ sport_slug: 'soccer', skill_level: 'beginner' }] });
  await expectError('approval re-checks eligibility', () => rpc(org, 'respond_to_join_request', { p_request_id: reqB, p_response: 'approved' }), 'NOT_ELIGIBLE');
  check('eligible request approved', (await rpc(org, 'respond_to_join_request', { p_request_id: reqA, p_response: 'approved', p_team: 'B' })) === 'approved');

  const gAll = await createGame(org, { p_title: 'Invite-only all levels', p_join_mode: 'invite_only' });
  check('invite-only with all levels: any player of the sport can request', /^[0-9a-f-]{36}$/.test(await rpc(beg, 'request_to_join', { p_game_id: gAll })));
  await expectError('...but not without the sport', () => rpc(nosport, 'request_to_join', { p_game_id: gAll }), 'NOT_ELIGIBLE');
  const gOpen = await createGame(org, { p_title: 'Open', p_join_mode: 'open' });
  await expectError('request on an open game', () => rpc(beg, 'request_to_join', { p_game_id: gOpen }), 'FORBIDDEN');
  check('organizer may still invite a player of a different level', /^[0-9a-f-]{36}$/.test(await rpc(org, 'send_invitation', { p_game_id: gAdv, p_recipient_id: beg })));

  const gFull = await createGame(org, { p_title: 'Full 1v1', p_join_mode: 'open', p_max_players: 2 });
  await rpc(adv, 'join_game', { p_game_id: gFull });
  const fullRow = (await rpc(beg, 'browse_games', {})).find((g) => g.id === gFull);
  check('full games discoverable by default (0 spots, cannot join)', fullRow?.spots_left === 0 && fullRow?.can_join === false, fullRow);
  check('p_only_open_spots = true hides full games', !(await rpc(beg, 'browse_games', { p_only_open_spots: true })).some((g) => g.id === gFull));

  check('completed past game hidden from outsiders', (await as(beg, `select * from games where id = $1`, [s2])).rowCount === 0);
  await rpc(org, 'cancel_game', { p_game_id: gAll });
  check('cancelled invite-only game hidden from outsiders', (await as(nosport, `select * from games where id = $1`, [gAll])).rowCount === 0);
  await expectError('discovery grants no writes', () => as(beg, `update games set title = 'x' where id = $1`, [gAdv]), 'permission denied');

  console.log('\n== Description');
  await expectError('description over 500 characters', () => createGame(org, { p_description: 'x'.repeat(501) }), 'VALIDATION');
  const gD = await createGame(org, { p_description: '  ' + 'y'.repeat(500) + '  ' });
  check('500-character description saved (trimmed)', (await one(`select char_length(description)::int n from games where id = $1`, [gD])).n === 500);
  const gN = await createGame(org, {});
  check('no description → null', (await one(`select description from games where id = $1`, [gN])).description === null);
  check('new-game alerts now cover invite-only games without levels', await (async () => {
    const watcher = await player('watcher', [['soccer', 'intermediate']], 'downtown', { p_new_game_alerts: true });
    const g = await createGame(org, { p_title: 'Quiet invite-only', p_join_mode: 'invite_only' });
    return (await one(`select count(*)::int c from notifications where user_id = $1 and game_id = $2 and type = 'new_game_nearby'`, [watcher, g])).c === 1;
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
