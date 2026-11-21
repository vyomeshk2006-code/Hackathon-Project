// v5 test suite (docs/database-contract-v5-proposal.md): usernames, private phones,
// game contacts, chat removal, venue address + end time, expiration, history, winner-only results.
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
const dataDir = path.join(here, 'data-v5-' + Date.now());
const conn = { host: 'localhost', port: 54334, user: 'postgres', password: 'pw', database: 'postgres' };

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
const newUser = async (handle) => {
  const id = crypto.randomUUID();
  await q(`insert into auth.users (id, email) values ($1, $2)`, [id, `${handle}@test.local`]);
  return id;
};
const profile = (over = {}) => ({ p_display_name: 'Test Person', p_neighborhood: 'downtown', p_travel_radius_miles: 10, p_bio: '',
  p_sports: [{ sport_slug: 'soccer', skill_level: 'intermediate' }], ...over });
async function player(handle, extra = {}) {
  const id = await newUser(handle);
  await rpc(id, 'save_profile', profile({ p_display_name: handle, p_username: handle, p_phone: '8135550123', ...extra }));
  return id;
}
async function createGame(uid, args = {}) {
  const id = await rpc(uid, 'create_game', { p_sport_slug: 'soccer', p_title: 'Test Game', p_venue: 'Park',
    p_venue_address: '1 Test St, Tampa, FL', p_neighborhood: 'downtown', p_starts_at: inMinutes(180), p_max_players: 10, ...args });
  await q(`update public.games set created_at = now() - interval '3 days' where id = $1`, [id]);   // skip the daily limit
  return id;
}
async function addPlayer(org, gameId, uid, team = null) {
  const inv = await rpc(org, 'send_invitation', { p_game_id: gameId, p_recipient_id: uid, p_team: team });
  return rpc(uid, 'respond_to_invitation', { p_invitation_id: inv, p_response: 'accepted' });
}
// set a game's times directly (admin) — e.g. "ended a second ago"
const setTimes = (id, startSql, endSql) => q(`update public.games set starts_at = ${startSql}, ends_at = ${endSql} where id = $1`, [id]);

try {
  await q(fs.readFileSync(path.join(here, 'supabase_stub.sql'), 'utf8'));
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of migrations) { await q(fs.readFileSync(path.join(ROOT, 'supabase', 'migrations', f), 'utf8')); console.log('ran', f); }
  await q(fs.readFileSync(path.join(ROOT, 'supabase', 'seed.sql'), 'utf8'));
  console.log('ran seed.sql');

  console.log('\n== Seed (v5)');
  const s = await one(`select (select count(*) from profiles where username is not null)::int u, (select count(*) from private_contacts)::int c,
                              (select count(*) from neighborhoods)::int n, (select count(*) from games where venue_address is not null)::int a,
                              (select count(*) from games where ends_at is null)::int noend`);
  check('12 demo usernames + phones, 16 neighborhoods, addresses, every game has an end time', s.u === 12 && s.c === 12 && s.n === 16 && s.a === 15 && s.noend === 0, s);
  check('"USF Area" label', (await one(`select name from neighborhoods where slug = 'usf'`)).name === 'USF Area');

  console.log('\n== Usernames + phones');
  const vyo = await newUser('vyo');
  await expectError('new profile without username', () => rpc(vyo, 'save_profile', profile({ p_phone: '8135550142' })), 'VALIDATION');
  await expectError('new profile without phone', () => rpc(vyo, 'save_profile', profile({ p_username: 'vyomeshk' })), 'VALIDATION');
  await expectError('invalid phone', () => rpc(vyo, 'save_profile', profile({ p_username: 'vyomeshk', p_phone: '12' })), 'VALIDATION');
  for (const bad of ['ab', 'a-b-c', 'has space', 'x'.repeat(21), 'dot.name'])
    await expectError(`invalid username "${bad}"`, () => rpc(vyo, 'save_profile', profile({ p_username: bad, p_phone: '8135550142' })), 'VALIDATION');
  await rpc(vyo, 'save_profile', profile({ p_display_name: 'Vyomesh Kumar', p_username: '@VyomeshK', p_phone: '(813) 555-0142',
    p_neighborhood: 'usf', p_area_note: 'near Fowler Ave' }));
  const vp = await one(`select username, area_note from profiles where id = $1`, [vyo]);
  check('username stored lowercase without @', vp.username === 'vyomeshk', vp);
  check('area note saved', vp.area_note === 'near Fowler Ave');
  check('phone normalized to E.164', (await one(`select phone_e164 from private_contacts where user_id = $1`, [vyo])).phone_e164 === '+18135550142');
  const other = await newUser('other');
  await expectError('same username, different case', () => rpc(other, 'save_profile', profile({ p_username: 'VYOMESHK', p_phone: '8135550000' })), 'USERNAME_TAKEN');
  await expectError('username cannot be changed once set', () => rpc(vyo, 'save_profile', profile({ p_username: 'newname' })), 'USERNAME_LOCKED');
  check('re-sending the same username is fine', (await rpc(vyo, 'save_profile', profile({ p_username: 'VyomeshK', p_neighborhood: 'usf' }))) === vyo);
  await rpc(vyo, 'save_profile', profile({ p_neighborhood: 'usf', p_phone: '+44 20 7946 0958' }));
  check('update without username keeps it; international phone normalized',
    (await one(`select username from profiles where id = $1`, [vyo])).username === 'vyomeshk'
    && (await one(`select phone_e164 from private_contacts where user_id = $1`, [vyo])).phone_e164 === '+442079460958');
  await rpc(vyo, 'save_profile', profile({ p_neighborhood: 'usf', p_phone: '813.555.0142' }));
  await expectError('area note over 80 characters', () => rpc(vyo, 'save_profile', profile({ p_area_note: 'x'.repeat(81) })), 'VALIDATION');
  check('profiles has no phone column', (await one(`select count(*)::int c from information_schema.columns where table_name = 'profiles' and column_name ilike '%phone%'`)).c === 0);
  check('private_contacts: you only ever see your own row', (await as(vyo, `select * from private_contacts`)).rowCount === 1
    && (await as(other, `select * from private_contacts where user_id = $1`, [vyo])).rowCount === 0);
  await expectError('anonymous visitors cannot read contacts', () => as(null, `select * from private_contacts`), 'permission denied');
  await expectError('no direct writes to contacts', () => as(vyo, `update private_contacts set phone_e164 = '+10000000000'`), 'permission denied');

  // existing account without a username or phone (e.g. created before v5) can claim one later
  const legacy = await newUser('legacy');
  await q(`insert into profiles (id, display_name, neighborhood, travel_radius_miles) values ($1, 'Legacy', 'downtown', 10)`, [legacy]);
  await q(`insert into user_sports (user_id, sport_slug, skill_level) values ($1, 'soccer', 'intermediate')`, [legacy]);
  check('existing account can save without username/phone', (await rpc(legacy, 'save_profile', profile({ p_display_name: 'Legacy' }))) === legacy);

  // two people claim the same new username at the same moment
  const r1 = await newUser('race1'), r2 = await newUser('race2');
  const c1 = new pg.Client(conn), c2 = new pg.Client(conn);
  await c1.connect(); await c2.connect();
  for (const [c, u] of [[c1, r1], [c2, r2]]) {
    await c.query('begin'); await c.query('set local role authenticated');
    await c.query(`select set_config('request.jwt.claim.sub', $1, true)`, [u]);
  }
  const call = `select public.save_profile(p_display_name => 'R', p_neighborhood => 'downtown', p_travel_radius_miles => 10::smallint,
    p_bio => '', p_sports => '[{"sport_slug":"soccer","skill_level":"beginner"}]'::jsonb, p_username => 'samename', p_phone => '8135550111')`;
  await c1.query(call);
  const second = c2.query(call).then(() => 'ok', (e) => e.message);
  await new Promise((r) => setTimeout(r, 300));
  await c1.query('commit');
  const res2 = await second;
  await c2.query(res2 === 'ok' ? 'commit' : 'rollback'); await c1.end(); await c2.end();
  check('simultaneous claims: one succeeds, the other gets USERNAME_TAKEN', res2 === 'USERNAME_TAKEN', res2);

  console.log('\n== Username search');
  const vyo2 = await player('vyomeshk2');
  const axb = await player('axb'); const a_b = await player('a_b');
  const names = async (qry) => (await rpc(other, 'search_players_by_username', { p_query: qry })).map((r) => r.username);
  check('finds @vyomeshk from "vyo", "@VYO" and the exact name (exact first)',
    (await names('vyo')).includes('vyomeshk') && (await names('@VYO')).includes('vyomeshk') && (await names('vyomeshk'))[0] === 'vyomeshk');
  check('"_" is a normal character, not a wildcard', JSON.stringify(await names('a_')) === JSON.stringify(['a_b']));
  const hit = (await rpc(other, 'search_players_by_username', { p_query: 'vyomeshk' }))[0];
  check('search returns profile + sports, never a phone', hit.username === 'vyomeshk' && hit.neighborhood_name === 'USF Area' && hit.area_note === 'near Fowler Ave'
    && Array.isArray(hit.sports) && !JSON.stringify(hit).includes('+44') && !JSON.stringify(hit).includes('+1813') && !('phone_e164' in hit), hit);
  await expectError('one-character search', () => rpc(other, 'search_players_by_username', { p_query: 'v' }), 'VALIDATION');
  await expectError('anonymous search', () => rpc(null, 'search_players_by_username', { p_query: 'vyo' }), 'permission denied');

  console.log('\n== Game contacts');
  const org = await player('organizer1', { p_phone: '8135550001' });
  const conf = await player('confirmed1', { p_phone: '8135550002' });
  const invited = await player('invited1'), requester = await player('requester1'), declined = await player('declined1'),
        withdrawn = await player('withdrawn1'), browser = await player('browser1'), removedLater = await player('removed1');
  const nophone = await newUser('nophone');
  await q(`insert into profiles (id, display_name, neighborhood, travel_radius_miles, username) values ($1, 'No Phone', 'downtown', 10, 'nophone')`, [nophone]);
  await q(`insert into user_sports (user_id, sport_slug, skill_level) values ($1, 'soccer', 'intermediate')`, [nophone]);
  const g = await createGame(org, { p_title: 'Contacts Game', p_join_mode: 'invite_only' });
  await addPlayer(org, g, conf);
  await addPlayer(org, g, nophone);
  await addPlayer(org, g, withdrawn);
  await rpc(org, 'send_invitation', { p_game_id: g, p_recipient_id: invited });
  await rpc(requester, 'request_to_join', { p_game_id: g });
  const dinv = await rpc(org, 'send_invitation', { p_game_id: g, p_recipient_id: declined });
  await rpc(declined, 'respond_to_invitation', { p_invitation_id: dinv, p_response: 'declined' });
  await rpc(withdrawn, 'withdraw_from_game', { p_game_id: g });
  const contacts = await rpc(conf, 'get_game_contacts', { p_game_id: g });
  check('roster member sees organizer (first) + confirmed players with phones', contacts.length === 2 && contacts[0].is_organizer
    && contacts[0].phone_e164 === '+18135550001' && contacts[1].phone_e164 === '+18135550002', contacts);
  check('organizer sees the same list', (await rpc(org, 'get_game_contacts', { p_game_id: g })).length === 2);
  check('players without a phone are left out', !contacts.some((c) => c.player_id === nophone));
  for (const [who, uid] of [['browsing user', browser], ['invited, not accepted', invited], ['pending requester', requester],
                            ['declined invitee', declined], ['withdrawn player', withdrawn]])
    await expectError(`contacts for ${who}`, () => rpc(uid, 'get_game_contacts', { p_game_id: g }), 'FORBIDDEN');
  await addPlayer(org, g, removedLater);
  check('newly confirmed player can see contacts', (await rpc(removedLater, 'get_game_contacts', { p_game_id: g })).length === 3);
  await rpc(removedLater, 'withdraw_from_game', { p_game_id: g });
  await expectError('access revoked right after leaving', () => rpc(removedLater, 'get_game_contacts', { p_game_id: g }), 'FORBIDDEN');
  const leak = async (sql, p) => JSON.stringify((await q(sql, p)).rows).match(/\+1813555000[12]|\+44207/);
  check('no phone in notifications', !(await leak(`select title, body, data from notifications`)));
  check('no phone in browse / search / history payloads', !JSON.stringify(await rpc(browser, 'browse_games', {})).includes('+1813555000')
    && !JSON.stringify(await rpc(conf, 'my_game_history', {})).includes('+1813555000'));
  check('no phone in join requests or profiles', !(await leak(`select jr.*, p.* from join_requests jr join profiles p on p.id = jr.player_id`)));

  await setTimes(g, `now() - interval '2 hours'`, `now() - interval '1 second'`);
  await expectError('contacts after the game ends', () => rpc(conf, 'get_game_contacts', { p_game_id: g }), 'CONTACTS_CLOSED');
  await expectError('...still FORBIDDEN (not CLOSED) for outsiders', () => rpc(browser, 'get_game_contacts', { p_game_id: g }), 'FORBIDDEN');
  const gc = await createGame(org, { p_title: 'Cancelled' });
  await addPlayer(org, gc, conf);
  await rpc(org, 'cancel_game', { p_game_id: gc });
  await expectError('contacts after cancellation', () => rpc(conf, 'get_game_contacts', { p_game_id: gc }), 'CONTACTS_CLOSED');
  const gr = await createGame(org, { p_title: 'Result in', p_starts_at: inMinutes(60) });
  await addPlayer(org, gr, conf, 'B');
  await rpc(org, 'set_team', { p_game_id: gr, p_player_id: org, p_team: 'A' });
  await q(`update games set starts_at = now() - interval '5 minutes' where id = $1`, [gr]);   // ongoing, ends later
  await rpc(org, 'submit_results', { p_game_id: gr, p_winner: 'A' });
  await expectError('contacts after a result is submitted', () => rpc(conf, 'get_game_contacts', { p_game_id: gr }), 'CONTACTS_CLOSED');

  console.log('\n== Chat removed');
  check('chat tables, view and functions are gone', (await one(`select to_regclass('public.game_messages') m, to_regclass('public.game_chat_reads') r,
    to_regclass('public.my_game_chat_status') v, (select count(*)::int from pg_proc where proname in ('send_game_message','mark_chat_read')) f`)).f === 0
    && (await one(`select to_regclass('public.game_messages') m`)).m === null);
  check('workflow notifications still sent', (await one(`select count(*)::int c from notifications where user_id = $1 and type = 'invitation_received'`, [invited])).c === 1);

  console.log('\n== Venue + end time');
  const gv = await createGame(org, { p_title: 'Venue', p_starts_at: '2030-01-05T23:00:00-05:00', p_duration_minutes: 90 });
  const gvr = await one(`select venue_address, ends_at - starts_at as dur from games where id = $1`, [gv]);
  check('address saved; ends 90 min after start', gvr.venue_address === '1 Test St, Tampa, FL' && gvr.dur.minutes === 30 && gvr.dur.hours === 1, gvr);
  check('default duration is 2 hours', (await one(`select ends_at - starts_at as d from games where id = $1`, [await createGame(org, {})])).d.hours === 2);
  await expectError('duration under 30 min', () => createGame(org, { p_duration_minutes: 20 }), 'VALIDATION');
  await expectError('duration over 8 h', () => createGame(org, { p_duration_minutes: 500 }), 'VALIDATION');
  await expectError('address over 200 characters', () => createGame(org, { p_venue_address: 'x'.repeat(201) }), 'VALIDATION');
  await q(`update games set starts_at = starts_at + interval '1 day' where id = $1`, [gv]);
  check('moving the start keeps the duration', (await one(`select ends_at - starts_at as d from games where id = $1`, [gv])).d.minutes === 30);

  console.log('\n== Browse + automatic expiration');
  const mk = async (title, extra = {}) => createGame(org, { p_title: title, p_join_mode: 'open', ...extra });
  const gFuture = await mk('Future'), gOngoing = await mk('Ongoing'), gEndNow = await mk('Ends now'), gEnded = await mk('Ended 1s ago'),
        gSoon = await mk('Ends in 5s'), gCancel = await mk('Cancelled future'), gDone = await mk('Completed future end');
  await setTimes(gOngoing, `now() - interval '30 minutes'`, `now() + interval '30 minutes'`);
  await setTimes(gEndNow, `now() - interval '2 hours'`, `now()`);
  await setTimes(gEnded, `now() - interval '2 hours'`, `now() - interval '1 second'`);
  await setTimes(gSoon, `now() - interval '2 hours'`, `now() + interval '5 seconds'`);
  await rpc(org, 'cancel_game', { p_game_id: gCancel });
  await q(`update games set status = 'completed' where id = $1`, [gDone]);
  const listed = (await rpc(browser, 'browse_games', { p_limit: 100 })).map((r) => r.id);
  check('upcoming game listed', listed.includes(gFuture));
  check('ongoing game listed', listed.includes(gOngoing));
  check('game ending in 5 seconds still listed', listed.includes(gSoon));
  check('game ending exactly now NOT listed', !listed.includes(gEndNow));
  check('game that ended 1 second ago NOT listed', !listed.includes(gEnded));
  check('cancelled game with a future end NOT listed', !listed.includes(gCancel));
  check('completed game with a future end NOT listed', !listed.includes(gDone));
  const on = (await rpc(browser, 'browse_games', { p_limit: 100 })).find((r) => r.id === gOngoing);
  check('ongoing game flagged, cannot be joined', on.is_ongoing === true && on.can_join === false, on);
  check('browse rows carry address + end time, no location fields', on.venue_address && on.ends_at && !('neighborhood' in on) && !('distance_miles' in on));
  check('outsider can still open an ongoing game', (await as(browser, `select * from games where id = $1`, [gOngoing])).rowCount === 1);
  // (open games stay viewable after they end — v3 rule; invite-only ones don't)
  check('outsider cannot open an ended invite-only game', (await as(browser, `select * from games where id = $1`, [g])).rowCount === 0);
  check('expired games are not deleted', (await one(`select count(*)::int c from games where id = any($1)`, [[gEndNow, gEnded]])).c === 2);
  const gMid = await mk('Late night', { p_starts_at: '2030-03-01T23:00:00-05:00' });   // 11 PM → 1 AM (Tampa)
  const mid = await one(`select (ends_at at time zone 'America/New_York')::text e from games where id = $1`, [gMid]);
  check('game across midnight ends 1 AM next day', mid.e === '2030-03-02 01:00:00', mid);
  const day = async (from, to) => (await rpc(browser, 'browse_games', { p_from: from, p_to: to, p_limit: 100 })).some((r) => r.id === gMid);
  check('date filter uses the Tampa start date', (await day('2030-03-01', '2030-03-01')) && !(await day('2030-03-02', '2030-03-02')));
  check('sport search: "SOCCER" and custom sports', (await rpc(browser, 'browse_games', { p_sport_query: 'SOCCER', p_limit: 100 })).some((r) => r.id === gFuture)
    && await (async () => {
      await rpc(org, 'create_sport', { p_name: 'Foot Volley' });
      await rpc(org, 'save_profile', profile({ p_sports: [{ sport_slug: 'soccer', skill_level: 'advanced' }, { sport_slug: 'foot-volley', skill_level: 'beginner' }] }));
      const fv = await createGame(org, { p_sport_slug: 'foot-volley', p_title: 'FV' });
      return (await rpc(browser, 'browse_games', { p_sport_query: 'volley', p_limit: 100 })).some((r) => r.id === fv);
    })());
  check('game type filter', (await rpc(browser, 'browse_games', { p_join_mode: 'invite_only', p_limit: 100 })).every((r) => r.join_mode === 'invite_only'));
  await expectError('bad game type', () => rpc(browser, 'browse_games', { p_join_mode: 'public' }), 'VALIDATION');
  const page1 = (await rpc(browser, 'browse_games', { p_limit: 2, p_offset: 0 })).map((r) => r.id);
  const page2 = (await rpc(browser, 'browse_games', { p_limit: 2, p_offset: 2 })).map((r) => r.id);
  const all = (await rpc(browser, 'browse_games', { p_limit: 4 })).map((r) => r.id);
  check('pagination is stable and ordered', page1.length === 2 && JSON.stringify([...page1, ...page2]) === JSON.stringify(all));

  console.log('\n== History + results reminders');
  const gH = await createGame(org, { p_title: 'Needs result', p_starts_at: inMinutes(60) });
  await addPlayer(org, gH, conf);
  await setTimes(gH, `now() - interval '3 hours'`, `now() - interval '1 hour'`);
  const hist = await rpc(org, 'my_game_history', {});
  const h = hist.find((r) => r.id === gH);
  check('ended game without a result: needs_result for the organizer', h?.needs_result === true, h);
  check('cancelled game is in history', hist.some((r) => r.id === gc && r.status === 'cancelled'));
  check('player sees it in history without needs_result', (await rpc(conf, 'my_game_history', {})).find((r) => r.id === gH)?.needs_result === false);
  await rpc(org, 'my_game_history', {});
  await q(`select private.send_results_reminders()`);
  check('results_needed notification sent exactly once', (await one(`select count(*)::int c from notifications where game_id = $1 and type = 'results_needed'`, [gH])).c === 1);
  check('not sent for games that are still running', (await one(`select count(*)::int c from notifications where game_id = $1 and type = 'results_needed'`, [gOngoing])).c === 0);

  console.log('\n== Results: winner required, scores + stats optional');
  await rpc(org, 'set_team', { p_game_id: gH, p_player_id: org, p_team: 'A' });
  await rpc(org, 'set_team', { p_game_id: gH, p_player_id: conf, p_team: 'B' });
  await expectError('no winner and no scores', () => rpc(org, 'submit_results', { p_game_id: gH }), 'VALIDATION');
  await expectError('winner contradicts scores', () => rpc(org, 'submit_results', { p_game_id: gH, p_team_a_score: 3, p_team_b_score: 1, p_winner: 'B' }), 'VALIDATION');
  await expectError('only one score', () => rpc(org, 'submit_results', { p_game_id: gH, p_team_a_score: 3, p_winner: 'A' }), 'VALIDATION');
  await expectError('invalid winner', () => rpc(org, 'submit_results', { p_game_id: gH, p_winner: 'C' }), 'VALIDATION');
  check('winner only → pending', (await rpc(org, 'submit_results', { p_game_id: gH, p_winner: 'B' })) === 'pending');
  const res = await one(`select winner, team_a_score, team_b_score from game_results where game_id = $1`, [gH]);
  check('stored: winner B, no scores', res.winner === 'B' && res.team_a_score === null && res.team_b_score === null, res);
  check('outcomes from the winner', (await one(`select outcome from player_game_stats where game_id = $1 and player_id = $2`, [gH, conf])).outcome === 'win');
  check('notification says who won', (await one(`select body from notifications where game_id = $1 and type = 'results_submitted'`, [gH])).body.startsWith('Team B won'));
  check('history no longer needs a result', (await rpc(org, 'my_game_history', {})).find((r) => r.id === gH)?.needs_result === false);
  await rpc(conf, 'confirm_results', { p_game_id: gH });
  const gD = await createGame(org, { p_title: 'Draw', p_starts_at: inMinutes(60) });
  await addPlayer(org, gD, conf, 'B');
  await rpc(org, 'set_team', { p_game_id: gD, p_player_id: org, p_team: 'A' });
  await setTimes(gD, `now() - interval '3 hours'`, `now() - interval '1 hour'`);
  const drawsBefore = (await one(`select coalesce(draws, 0)::int d from player_sport_stats where player_id = $1 and sport_slug = 'soccer'`, [conf]))?.d ?? 0;
  await rpc(org, 'submit_results', { p_game_id: gD, p_winner: 'draw' });
  await rpc(conf, 'confirm_results', { p_game_id: gD });
  check('draw with no scores counts as a draw', (await one(`select draws::int d from player_sport_stats where player_id = $1 and sport_slug = 'soccer'`, [conf])).d === drawsBefore + 1);
  const gS = await createGame(org, { p_title: 'Scores only', p_starts_at: inMinutes(60) });
  await addPlayer(org, gS, conf, 'B');
  await rpc(org, 'set_team', { p_game_id: gS, p_player_id: org, p_team: 'A' });
  await setTimes(gS, `now() - interval '3 hours'`, `now() - interval '1 hour'`);
  await rpc(org, 'submit_results', { p_game_id: gS, p_team_a_score: 4, p_team_b_score: 2, p_performances: [{ player_id: org, metrics: { goals: 4 } }] });
  check('scores only (v4 style): winner derived, stats stored', (await one(`select winner from game_results where game_id = $1`, [gS])).winner === 'A'
    && (await one(`select value from player_game_stat_values where game_id = $1 and player_id = $2 and stat_key = 'goals'`, [gS, org])).value === 4);
} catch (e) {
  bad('UNEXPECTED ERROR', e.stack);
} finally {
  console.log(`\n${pass} passed, ${fail} failed`);
  await client.end();
  await db.stop();
  fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
}
