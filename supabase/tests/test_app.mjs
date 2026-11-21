// App-support test suite (migration 010): functions the frontend's Supabase adapter uses.
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
const dataDir = path.join(here, 'data-app-' + Date.now());
const conn = { host: 'localhost', port: 54335, user: 'postgres', password: 'pw', database: 'postgres' };

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
const newUser = async (handle) => {
  const id = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, `${handle}@test.local`]);
  return id;
};
async function player(handle, extra = {}) {
  const id = await newUser(handle);
  await rpc(id, 'save_profile', { p_display_name: handle, p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '',
    p_sports: [{ sport_slug: 'soccer', skill_level: 'intermediate' }], p_username: handle, p_phone: '8135550123', ...extra });
  return id;
}
async function createGame(uid, args = {}) {
  const id = await rpc(uid, 'create_game', { p_sport_slug: 'soccer', p_title: 'Test Game', p_venue: 'Park',
    p_venue_address: '1 Test St', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, ...args });
  await q(`update public.games set created_at = now() - interval '3 days' where id = $1`, [id]);   // skip the daily limit
  return id;
}
const setTimes = (id, startSql, endSql) => q(`update public.games set starts_at = ${startSql}, ends_at = ${endSql} where id = $1`, [id]);

try {
  await q(fs.readFileSync(path.join(here, 'supabase_stub.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) { await q(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')); console.log('ran', f); }
  await q(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  console.log('ran seed.sql');

  const org = await player('appowner', { p_phone: '8135550301' });
  const ann = await player('annie', { p_display_name: 'Annie Adams', p_sports: [{ sport_slug: 'soccer', skill_level: 'advanced' }] });
  const bob = await player('bobby', { p_display_name: 'Bob Beginner', p_sports: [{ sport_slug: 'soccer', skill_level: 'beginner' }] });
  const noPhone = await newUser('nophone2');
  await q(`insert into profiles (id, display_name, neighborhood, travel_radius_miles, username) values ($1, 'Nora NoPhone', 'downtown', 10, 'nora')`, [noPhone]);
  await q(`insert into user_sports (user_id, sport_slug, skill_level) values ($1, 'soccer', 'advanced')`, [noPhone]);

  console.log('\n== username_available');
  check('taken username → false (any case, with @)', (await rpc(bob, 'username_available', { p_username: '@ANNIE' })) === false);
  check('free username → true', (await rpc(bob, 'username_available', { p_username: 'brand_new' })) === true);
  check('your own username counts as free', (await rpc(ann, 'username_available', { p_username: 'annie' })) === true);
  check('works before sign-in (anon)', (await rpc(null, 'username_available', { p_username: 'brand_new' })) === true);
  await expectError('invalid format', () => rpc(bob, 'username_available', { p_username: 'a b' }), 'VALIDATION');

  console.log('\n== set_notification_preferences');
  await rpc(bob, 'set_notification_preferences', { p_replacement_alerts: false, p_new_game_alerts: true });
  const pref = await one(`select replacement_alerts, new_game_alerts from profiles where id = $1`, [bob]);
  check('preferences saved', pref.replacement_alerts === false && pref.new_game_alerts === true, pref);
  const fresh = await newUser('noprof');
  await expectError('no profile yet', () => rpc(fresh, 'set_notification_preferences', { p_replacement_alerts: true, p_new_game_alerts: true }), 'PROFILE_REQUIRED');
  await expectError('null value', () => rpc(bob, 'set_notification_preferences', { p_replacement_alerts: null, p_new_game_alerts: true }), 'VALIDATION');

  console.log('\n== edit_game');
  const g = await createGame(org, { p_title: 'Original', p_join_mode: 'open', p_skill_levels: ['advanced'] });
  const s = new Date(Date.now() + 5 * 3600e3), e = new Date(s.getTime() + 90 * 60e3);
  await rpc(org, 'edit_game', { p_game_id: g, p_title: ' Renamed ', p_venue: 'New Park', p_venue_address: '2 New St',
    p_starts_at: s.toISOString(), p_ends_at: e.toISOString(), p_description: 'Bring water' });
  const eg = await one(`select title, venue, venue_address, description, extract(epoch from ends_at - starts_at)::int d from games where id = $1`, [g]);
  check('edited (trimmed), 90-minute game', eg.title === 'Renamed' && eg.venue === 'New Park' && eg.venue_address === '2 New St'
    && eg.description === 'Bring water' && eg.d === 5400, eg);
  const edit = (uid, over) => rpc(uid, 'edit_game', { p_game_id: g, p_title: 'x', p_venue: 'y', p_venue_address: '',
    p_starts_at: s.toISOString(), p_ends_at: e.toISOString(), ...over });
  await expectError('non-organizer edits', () => edit(ann, {}), 'FORBIDDEN');
  await expectError('game shorter than 30 min', () => edit(org, { p_ends_at: new Date(s.getTime() + 10 * 60e3).toISOString() }), 'VALIDATION');
  await expectError('start in the past', () => edit(org, { p_starts_at: new Date(Date.now() - 6e4).toISOString() }), 'VALIDATION');
  await q(`update games set starts_at = now() - interval '5 minutes' where id = $1`, [g]);
  await expectError('edit after kickoff', () => edit(org, {}), 'GAME_UNAVAILABLE');

  console.log('\n== find_players');
  const names = async (uid, args) => (await rpc(uid, 'find_players', args)).map((r) => r.username);
  check('sport + skill + name filter', JSON.stringify(await names(org, { p_sport: 'soccer', p_skill: 'beginner', p_name: 'bob' })) === '["bobby"]');
  check('name matches display name or username', (await names(org, { p_name: 'adams' })).includes('annie')
    && (await names(org, { p_name: '@ann' })).includes('annie'));
  check('never includes yourself', !(await names(org, { p_name: 'appowner' })).includes('appowner'));
  const row = (await rpc(org, 'find_players', { p_name: 'annie' }))[0];
  check('rows carry sports + rating, no phone', Array.isArray(row.sports) && 'avg_rating' in row && !JSON.stringify(row).includes('+1813'), row);
  const g2 = await createGame(org, { p_title: 'Directory game', p_join_mode: 'invite_only' });
  await rpc(org, 'send_invitation', { p_game_id: g2, p_recipient_id: ann });
  check('game filter hides roster + pending invitees', !(await names(org, { p_sport: 'soccer', p_game_id: g2 })).some((u) => ['annie', 'appowner'].includes(u)));
  await expectError('game filter is organizer-only', () => rpc(bob, 'find_players', { p_game_id: g2 }), 'FORBIDDEN');
  await expectError('unknown sport', () => rpc(org, 'find_players', { p_sport: 'quidditch' }), 'VALIDATION');

  console.log('\n== game_participation');
  const gp = await createGame(org, { p_title: 'Participation', p_join_mode: 'open', p_skill_levels: ['advanced'] });
  const part = async (uid, id = gp) => (await rpc(uid, 'game_participation', { p_game_id: id }))[0];
  const a = await part(ann);
  check('eligible advanced player can join', a.can_join === true && a.can_request === false && a.ineligible_reason === null, a);
  const b = await part(bob);
  check('beginner: cannot join, says why', b.can_join === false && /advanced/.test(b.ineligible_reason), b);
  const n = await part(noPhone);
  check('no phone: cannot join, says why', n.can_join === false && /phone/i.test(n.ineligible_reason), n);
  check('organizer is a member', (await part(org)).is_member === true);
  const gi = await createGame(org, { p_title: 'Invite-only all', p_join_mode: 'invite_only' });
  check('invite-only: can request', (await part(bob, gi)).can_request === true);
  const rq = await rpc(bob, 'request_to_join', { p_game_id: gi });
  const after = await part(bob, gi);
  check('after requesting: request id, cannot request again', after.request_id === rq && after.can_request === false, after);
  const inv = await rpc(org, 'send_invitation', { p_game_id: gi, p_recipient_id: ann });
  check('pending invitation id returned', (await part(ann, gi)).invitation_id === inv);
  const gr = await createGame(org, { p_title: 'Replacement', p_join_mode: 'open', p_team_size: 1, p_max_players: 2, p_starts_at: inMinutes(45) });
  await rpc(bob, 'join_game', { p_game_id: gr });
  await rpc(bob, 'withdraw_from_game', { p_game_id: gr });
  check('alerted player can claim', (await part(ann, gr)).can_claim === true);
  check('non-alerted player cannot claim', (await part(noPhone, gr)).can_claim === false);
  await setTimes(gi, `now() - interval '3 hours'`, `now() - interval '1 hour'`);
  check('game you cannot see → no row', (await rpc(fresh, 'game_participation', { p_game_id: gi })).length === 0);
} catch (e) {
  bad('UNEXPECTED ERROR', e.stack);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await client.end();
  await db.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
