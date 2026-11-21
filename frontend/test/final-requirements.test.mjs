
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({ configFile: false, optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, ws: false } })
after(() => server.close())
const { demoService: service, demoAccounts, signInAsDemoAccount } = await server.ssrLoadModule('/src/services/demo.ts')
const { normalizePhone, normalizeUsername } = await server.ssrLoadModule('/src/lib/account.ts')
const { skillTier, weightedSkillScore, winRateScore } = await server.ssrLoadModule('/src/lib/skillRating.ts')
const [jordan, maya, andre, sofia, cam] = demoAccounts
const sign = account => signInAsDemoAccount(account.id)
const fixed = t => t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-16T15:00:00Z') })

function storage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
}
beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage() })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() })
})

const profile = (extra = {}) => ({
  displayName: 'Alex Demo', username: 'Alex_Demo', phoneNumber: '+44 (20) 7946 0958', neighborhood: 'Custom Tampa Area',
  sports: [{ sport: 'soccer', skill: 'intermediate' }], bio: '', ...extra,
})
const game = (extra = {}) => ({
  title: 'Pickup at Ybor', sport: 'soccer', venue: 'Ybor Test Field', venueAddress: '12 Example Ave, Tampa, FL',
  startsAt: '2027-01-16T10:30:00-05:00', endsAt: '2027-01-16T11:00:00-05:00',
  maxPlayers: 4, teamSize: 2, joinMode: 'invite_only', ...extra,
})

test('normalizes account fields, rejects duplicates under racing saves and keeps phone owner-only', async () => {
  assert.equal(normalizeUsername(' Alex_Demo '), 'alex_demo')
  for (const invalid of ['ab', '@alex', 'alex-name', 'náme', 'a'.repeat(21)]) assert.equal(normalizeUsername(invalid), null)
  for (const invalid of ['8135550100', '+01234567', '+1', '+1202555010012345', '+44abc123456']) assert.equal(normalizePhone(invalid), null)
  const a = await service.signUp('one@example.test', 'test-password')
  const b = await service.signUp('two@example.test', 'test-password')
  assert.equal(await service.usernameAvailable('Alex_Demo'), true)
  let queue = Promise.resolve()
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { navigator: { locks: {
    request(_, operation) {
      const result = queue.then(operation)
      queue = result.catch(() => {})
      return result
    },
  } } } })
  try {
    const first = service.saveProfile(profile())
    const otherSignIn = service.signIn('one@example.test', 'test-password')
    await first
    await otherSignIn
    assert.equal(await service.usernameAvailable('ALEX_DEMO'), false)
    await assert.rejects(service.saveProfile(profile({ username: 'ALEX_DEMO' })), { code: 'USERNAME_TAKEN' })
    const mine = await service.saveProfile(profile({ username: 'other_player', phoneNumber: '+91 98765 43210' }))
    assert.equal(mine.id, a.userId)
    assert.equal(mine.neighborhood, 'Custom Tampa Area')
    assert.deepEqual(await service.getAccountDetails(), { phoneNumber: '+919876543210' })
    const publicOther = await service.getPlayerDetails(b.userId)
    assert.equal(publicOther.username, 'alex_demo')
    assert.equal('phoneNumber' in publicOther, false)
    await assert.rejects(service.saveProfile(profile({ username: 'another' })), { code: 'VALIDATION' })
  } finally { delete globalThis.window }
})

test('concurrent claims serialize on the username and a legacy profile keeps its identity and sports', async () => {
  const other = await service.signUp('new@example.test', 'test-password')
  const key = 'pickup-tampa.demo.v1'
  const data = JSON.parse(localStorage.getItem(key))
  const firstSeed = data.profiles.find(row => row.id === jordan.id)
  delete firstSeed.username
  data.contacts = data.contacts.filter(row => row.playerId !== jordan.id)
  localStorage.setItem(key, JSON.stringify(data))

  let release
  const barrier = new Promise(resolve => { release = resolve })
  let queue = barrier
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { navigator: { locks: {
    request(_, operation) {
      const result = queue.then(operation)
      queue = result.catch(() => {})
      return result
    },
  } } } })
  try {
    const candidate = service.saveProfile(profile({ username: 'shared_id' }))
    sign(jordan)
    const legacy = await service.getProfile(jordan.id)
    assert.equal((await service.getAccountDetails()).phoneNumber, null)
    const duplicate = service.saveProfile({ ...legacy, username: 'SHARED_ID', phoneNumber: '+12025550132' })
    release()
    const [success, failure] = await Promise.allSettled([candidate, duplicate])
    assert.equal(success.value.id, other.userId)
    assert.equal(failure.reason.code, 'USERNAME_TAKEN')
    const claimed = await service.saveProfile({ ...legacy, username: 'legacy_player', phoneNumber: '+12025550132' })
    assert.equal(claimed.id, legacy.id)
    assert.deepEqual(claimed.sports, legacy.sports)
    assert.equal(claimed.displayName, legacy.displayName)
  } finally { release(); delete globalThis.window }
})

test('contact authorization follows confirmation, withdrawal, completion, cancellation and exact end time', async t => {
  fixed(t)
  sign(jordan)
  const id = await service.createGame(game())
  const invite = await service.invite(id, andre.id)
  sign(maya)
  const request = await service.requestToJoin(id)
  await assert.rejects(service.getGameContacts(id), { code: 'FORBIDDEN' })
  sign(cam)
  const declined = await service.requestToJoin(id)
  sign(andre)
  await assert.rejects(service.getGameContacts(id), { code: 'FORBIDDEN' })
  sign(jordan)
  const detail = await service.getGame(id)
  const candidate = detail.joinRequests.find(row => row.id === request)
  assert.equal(candidate.neighborhood, 'USF Area')
  assert.equal(candidate.username, 'maya')
  assert.equal(JSON.stringify(detail).includes('+1202555'), false)
  assert.deepEqual(await service.getGameContacts(id), [])
  await service.respondToJoinRequest(declined, 'declined')
  await service.respondToJoinRequest(request, 'approved', 'B')
  assert.deepEqual((await service.getGameContacts(id)).map(row => row.name), ['Maya Chen'])
  sign(cam)
  await assert.rejects(service.getGameContacts(id), { code: 'FORBIDDEN' })
  sign(andre)
  await service.respond(invite, 'accepted')
  assert.deepEqual((await service.getGameContacts(id)).map(row => row.name), ['Jordan Rivera', 'Maya Chen'])
  sign(maya)
  await service.withdraw(id)
  await assert.rejects(service.getGameContacts(id), { code: 'FORBIDDEN' })
  assert.equal(JSON.stringify(await service.notifications()).includes('+1202555'), false)
  assert.equal(JSON.stringify(await service.browseGames()).includes('+1202555'), false)
  sign(jordan)
  assert.deepEqual((await service.getGameContacts(id)).map(row => row.name), ['Andre Lewis'])

  const cancelled = await service.createGame(game({ joinMode: 'open' }))
  const completed = await service.createGame(game({ joinMode: 'open' }))
  sign(sofia)
  await service.joinGame(cancelled)
  await service.joinGame(completed)
  sign(jordan)
  await service.cancelGame(cancelled)
  await service.autoAssignTeams(completed)
  await service.submitResults(completed, { teamAScore: 2, teamBScore: 1, performances: [] })
  sign(sofia)
  await assert.rejects(service.getGameContacts(cancelled), { code: 'GAME_UNAVAILABLE' })
  await assert.rejects(service.getGameContacts(completed), { code: 'GAME_UNAVAILABLE' })
  assert.equal((await service.browseGames()).length, 1)
  t.mock.timers.setTime(new Date('2027-01-16T16:00:00Z').getTime())
  sign(andre)
  await assert.rejects(service.getGameContacts(id), { code: 'GAME_UNAVAILABLE' })
  assert.equal((await service.browseGames()).length, 0)
  assert.equal((await service.myGames())[0].id, id)
  assert.ok((await service.getGame(id)).roster.some(row => row.id === andre.id))
})

test('requires contact setup before a legacy account can request, join, or accept', async t => {
  fixed(t)
  sign(jordan)
  const privateId = await service.createGame(game())
  const openId = await service.createGame(game({ joinMode: 'open' }))
  const invite = await service.invite(privateId, maya.id)
  const key = 'pickup-tampa.demo.v1'
  const data = JSON.parse(localStorage.getItem(key))
  data.contacts = data.contacts.filter(row => row.playerId !== maya.id)
  localStorage.setItem(key, JSON.stringify(data))
  sign(maya)
  assert.equal((await service.browseGames()).length, 2)
  assert.match((await service.getGame(openId)).participation.ineligibleReason, /Settings/)
  await assert.rejects(service.requestToJoin(privateId), { code: 'CONTACT_REQUIRED' })
  await assert.rejects(service.joinGame(openId), { code: 'CONTACT_REQUIRED' })
  await assert.rejects(service.respond(invite, 'accepted'), { code: 'CONTACT_REQUIRED' })
  await service.saveProfile({ ...await service.getProfile(maya.id), phoneNumber: '+12025550165' })
  await service.respond(invite, 'accepted')
  assert.equal((await service.getGameContacts(privateId))[0].name, 'Jordan Rivera')
})

test('venue validation and edits, custom sport search, and time-based listings preserve finished games', async t => {
  fixed(t)
  sign(jordan)
  await assert.rejects(service.createGame(game({ venueAddress: '  ' })), { code: 'VALIDATION' })
  await assert.rejects(service.createGame(game({ endsAt: '2027-01-16T10:00:00-05:00' })), { code: 'VALIDATION' })
  await assert.rejects(service.createGame(game({ endsAt: '2027-01-16T12:00:00' })), { code: 'VALIDATION' })
  await assert.rejects(service.createGame(game({ endsAt: '2027-02-30T12:00:00-05:00' })), { code: 'VALIDATION' })
  const sport = await service.createSport('Disc Golf')
  const id = await service.createGame(game({ sport: sport.slug, joinMode: 'open', maxPlayers: 2, teamSize: 1 }))
  const edit = game({ venueAddress: '500 Updated Ave, Tampa, FL', endsAt: '2027-01-16T11:05:00-05:00' })
  await service.editGame(id, edit)
  sign(maya)
  await assert.rejects(service.editGame(id, edit), { code: 'FORBIDDEN' })
  const results = await service.browseGames({ sportName: 'dIsC g', joinMode: 'open', from: '2027-01-16', to: '2027-01-16' })
  assert.deepEqual(results.map(row => row.venueAddress), ['500 Updated Ave, Tampa, FL'])
  assert.equal((await service.browseGames({ joinMode: 'invite_only' })).length, 0)
  t.mock.timers.setTime(new Date('2027-01-16T15:45:00Z').getTime())
  assert.equal((await service.browseGames()).length, 1)
  await assert.rejects(service.joinGame(id), { code: 'GAME_UNAVAILABLE' })
  t.mock.timers.setTime(new Date('2027-01-16T16:05:00Z').getTime())
  assert.equal((await service.browseGames()).length, 0)
  sign(jordan)
  assert.equal((await service.myGames())[0].endsAt, '2027-01-16T16:05:00.000Z')
  assert.equal((await service.getGame(id)).status, 'scheduled')
})

test('weighted formulas, tier boundaries, draws and missing normalization follow the final spec', () => {
  assert.equal(weightedSkillScore('stats-supported', 80, 60, 70), 73)
  assert.equal(weightedSkillScore('stats-supported', 80, 60, null), null)
  assert.equal(weightedSkillScore('stats-supported', 80, 60, 0), 52)
  assert.equal(weightedSkillScore('no-individual-stats', 80, 60), 72)
  assert.equal(weightedSkillScore('no-individual-stats', 80, null), null)
  assert.equal(winRateScore({ wins: 0, losses: 0, draws: 0 }), null)
  assert.equal(winRateScore({ wins: 1, losses: 2, draws: 1 }), 37.5)
  assert.deepEqual([0, 39, 40, 69, 70, 100].map(skillTier),
    ['beginner', 'beginner', 'intermediate', 'intermediate', 'advanced', 'advanced'])
})

test('a no-stat sport gains a settled rating only after five confirmed matches and three peers; corrections remove evidence', async t => {
  fixed(t)
  for (const account of [jordan, maya, andre, sofia]) {
    sign(account)
    const p = await service.getProfile(account.id)
    await service.saveProfile({ ...p, sports: [...p.sports.filter(row => row.sport !== 'pickleball'), { sport: 'pickleball', skill: 'intermediate' }] })
  }
  const results = [[maya, 2, 1], [andre, 2, 1], [maya, 2, 1], [andre, 1, 1], [sofia, 0, 1]]
  let last
  for (const [peer, a, b] of results) {
    sign(jordan)
    last = await service.createGame(game({ sport: 'pickleball', joinMode: 'open', maxPlayers: 2, teamSize: 1 }))
    sign(peer)
    await service.joinGame(last)
    sign(jordan)
    await service.setTeam(last, jordan.id, 'A')
    await service.setTeam(last, peer.id, 'B')
    await service.submitResults(last, { teamAScore: a, teamBScore: b, performances: [] })
    sign(peer)
    await service.confirmResults(last)
    await service.confirmResults(last)
    const vote = { revieweeId: jordan.id, rating: 5, skillRating: 4, comment: '' }
    await service.submitReview(last, vote)
    await assert.rejects(service.submitReview(last, vote), { code: 'ALREADY_REVIEWED' })
    const current = (await service.getPlayerDetails(jordan.id)).skillRatings.find(row => row.sport === 'pickleball')
    if (peer.id !== sofia.id) assert.equal(current.provisional, true)
  }
  const ratings = (await service.getPlayerDetails(jordan.id)).skillRatings
  const pickleball = ratings.find(row => row.sport === 'pickleball')
  assert.deepEqual([pickleball.matches, pickleball.peers, pickleball.score, pickleball.tier, pickleball.provisional], [5, 3, 76, 'advanced', false])
  assert.equal(ratings.find(row => row.sport === 'soccer').score, null)
  sign(jordan)
  await service.submitResults(last, { teamAScore: 1, teamBScore: 1, performances: [] })
  const corrected = (await service.getPlayerDetails(jordan.id)).skillRatings.find(row => row.sport === 'pickleball')
  assert.equal(corrected.matches, 4)
  assert.equal(corrected.peers, 2)
  assert.equal(corrected.provisional, true)
})


test('removing a roster row revokes subsequent contact reads while the game stays active', async t => {
  fixed(t)
  sign(jordan)
  const id = await service.createGame(game({ joinMode: 'open' }))
  sign(maya)
  await service.joinGame(id)
  assert.equal((await service.getGameContacts(id)).length, 1)
  const key = 'pickup-tampa.demo.v1'
  const data = JSON.parse(localStorage.getItem(key))
  data.roster = data.roster.filter(row => row.gameId !== id || row.playerId !== maya.id)
  localStorage.setItem(key, JSON.stringify(data))
  await assert.rejects(service.getGameContacts(id), { code: 'FORBIDDEN' })
  assert.equal((await service.browseGames()).some(row => row.id === id), true)
})
