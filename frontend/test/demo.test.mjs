import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, ws: false },
})
after(() => server.close())
const { demoService: service, demoAccounts, signInAsDemoAccount } = await server.ssrLoadModule('/src/services/demo.ts')
const { tampaToIso } = await server.ssrLoadModule('/src/lib/time.ts')

function memoryStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: memoryStorage() })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: memoryStorage() })
})

const [jordan, maya] = demoAccounts
const password = 'demo-password'

async function signUpPlayer(email, displayName, options = {}) {
  const session = await service.signUp(email, password)
  assert.equal(await service.getProfile(session.userId), null)
  await service.saveProfile({
    displayName, username: email.split('@')[0].replaceAll('-', '_'), phoneNumber: '+12025550142', neighborhood: 'usf', bio: '',
    sports: [{ sport: 'soccer', skill: 'intermediate' }],
    ...options,
  })
  return session.userId
}

const createSoccerGame = (options = {}) => {
  const startsAt = options.startsAt ?? new Date(Date.now() + 86_400_000).toISOString()
  return service.createGame({
    sport: 'soccer', title: 'After-work soccer', venue: 'Tampa field', venueAddress: '100 Example Ave, Tampa, FL',
    maxPlayers: 2, startsAt, endsAt: new Date(Date.parse(startsAt) + 90 * 60_000).toISOString(), ...options,
  })
}

test('signup, onboarding, filters, invitation, and updated roster', async () => {
  await assert.rejects(service.myGames(), /Log in/)
  const playerId = await signUpPlayer('player@example.test', 'Alex Demo')
  await service.signOut()
  await assert.rejects(service.signIn('player@example.test', 'wrong'), /incorrect/)

  signInAsDemoAccount(jordan.id)
  const results = await service.findPlayers({ sport: 'soccer', name: 'alex' })
  assert.deepEqual(results.map(player => player.displayName), ['Alex Demo'])
  const gameId = await createSoccerGame()
  const invitation = await service.invite(gameId, playerId)
  assert.equal(await service.invite(gameId, playerId), invitation)
  assert.equal((await service.getGame(gameId)).confirmed, 1)
  await assert.rejects(service.respond(invitation, 'accepted'), /unavailable/)

  await service.signIn('PLAYER@example.test', password)
  assert.equal((await service.inbox())[0].senderName, 'Jordan Rivera')
  assert.equal(await service.respond(invitation, 'accepted'), 'accepted')
  assert.equal(await service.respond(invitation, 'accepted'), 'accepted')
  assert.equal((await service.myGames())[0].id, gameId)
  assert.deepEqual(await service.inbox(), [])

  signInAsDemoAccount(jordan.id)
  const game = await service.getGame(gameId)
  assert.equal(game.confirmed, 2)
  assert.deepEqual(game.roster.map(player => player.displayName), ['Jordan Rivera', 'Alex Demo'])
})

test('a full game keeps the competing invitation pending and allows decline', async () => {
  const playerId = await signUpPlayer('second@example.test', 'Second Player')
  signInAsDemoAccount(jordan.id)
  const gameId = await createSoccerGame()
  const mayaInvite = await service.invite(gameId, maya.id)
  const secondInvite = await service.invite(gameId, playerId)

  signInAsDemoAccount(maya.id)
  assert.equal(await service.respond(mayaInvite, 'accepted'), 'accepted')
  await service.signIn('second@example.test', password)
  await assert.rejects(service.respond(secondInvite, 'accepted'), /full/)
  assert.equal((await service.inbox())[0].id, secondInvite)
  assert.equal(await service.respond(secondInvite, 'declined'), 'declined')
  assert.equal((await service.getGame(gameId)).participation.isMember, false)
  assert.deepEqual(await service.myGames(), [])
  signInAsDemoAccount(jordan.id)
  await assert.rejects(service.invite(gameId, playerId), { code: 'INVITATION_CLOSED' })
})

test('player search uses sport and name with no geographic exclusion and skips invited or rostered players', async () => {
  const distant = await signUpPlayer('distant@example.test', 'Distant Player', { neighborhood: 'Custom Area' })
  signInAsDemoAccount(jordan.id)
  const game = await createSoccerGame()
  const search = { sport: 'soccer', gameId: game }
  const matches = await service.findPlayers(search)
  assert.ok(matches.some(row => row.id === distant && row.neighborhood === 'Custom Area'))
  assert.ok(matches.some(row => row.id === maya.id && row.neighborhood === 'USF Area'))
  assert.equal(matches.some(row => 'distanceMiles' in row || 'phoneNumber' in row), false)
  assert.equal((await service.findPlayers({ ...search, skill: 'advanced' })).length, 0)
  const invitation = await service.invite(game, maya.id)
  assert.equal((await service.findPlayers(search)).some(row => row.id === maya.id), false)
  signInAsDemoAccount(maya.id)
  await service.respond(invitation, 'accepted')
  signInAsDemoAccount(jordan.id)
  assert.equal((await service.findPlayers(search)).some(row => row.id === maya.id), false)
})

test('organizer cancellation supports retry and re-inviting and cancels all pending invitations', async () => {
  signInAsDemoAccount(jordan.id)
  const gameId = await createSoccerGame()
  const firstId = await service.invite(gameId, maya.id)
  signInAsDemoAccount(maya.id)
  await assert.rejects(service.cancelInvitation(firstId), { code: 'FORBIDDEN' })
  await assert.rejects(service.cancelGame(gameId), { code: 'FORBIDDEN' })
  signInAsDemoAccount(jordan.id)
  assert.equal(await service.cancelInvitation(firstId), 'cancelled')
  assert.equal(await service.cancelInvitation(firstId), 'cancelled')
  const secondId = await service.invite(gameId, maya.id)
  assert.notEqual(firstId, secondId)
  assert.equal(await service.cancelGame(gameId), 'cancelled')
  assert.equal((await service.getGame(gameId)).status, 'cancelled')
  assert.deepEqual((await service.getGame(gameId)).sentInvitations.map(invite => invite.status), ['cancelled', 'cancelled'])
  signInAsDemoAccount(maya.id)
  await assert.rejects(service.respond(secondId, 'accepted'), { code: 'INVITATION_CLOSED' })
  assert.deepEqual(await service.inbox(), [])
})

test('teams, disputed and revised results, final-only stats, and one review per player', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-16T15:00:00Z') })
  const third = await signUpPlayer('advanced@example.test', 'Advanced Player', {
    sports: [{ sport: 'soccer', skill: 'advanced' }],
  })
  signInAsDemoAccount(jordan.id)
  const gameId = await createSoccerGame({ startsAt: '2027-01-16T22:00:00Z', maxPlayers: 4 })
  const mayaInvite = await service.invite(gameId, maya.id)
  const thirdInvite = await service.invite(gameId, third)
  const pendingInvite = await service.invite(gameId, '10000000-0000-4000-8000-000000000003')
  const input = { teamAScore: 2, teamBScore: 1, performances: [{ playerId: jordan.id, goals: 2, points: 99 }] }
  await assert.rejects(service.submitResults(gameId, input), { code: 'TEAMS_INCOMPLETE' })
  signInAsDemoAccount(maya.id)
  await service.respond(mayaInvite, 'accepted')
  await assert.rejects(service.autoAssignTeams(gameId), { code: 'FORBIDDEN' })
  await assert.rejects(service.submitResults(gameId, input), { code: 'FORBIDDEN' })
  await service.signIn('advanced@example.test', password)
  await service.respond(thirdInvite, 'accepted')

  signInAsDemoAccount(jordan.id)
  const assignments = await service.autoAssignTeams(gameId)
  assert.deepEqual(assignments.map(row => row.team), ['A', 'B', 'B'])
  assert.equal(assignments[0].playerId, third)
  await service.setTeam(gameId, jordan.id, 'A')
  await service.setTeam(gameId, third, null)
  await assert.rejects(service.submitResults(gameId, input), { code: 'TEAMS_INCOMPLETE' })
  await service.setTeam(gameId, third, 'B')
  assert.equal(await service.submitResults(gameId, input), 'pending')
  const game = await service.getGame(gameId)
  assert.equal(game.status, 'completed')
  assert.equal(game.sentInvitations.find(invite => invite.id === pendingInvite).status, 'expired')
  assert.equal(game.performances.find(row => row.playerId === jordan.id).points, 0)
  assert.equal(game.performances.find(row => row.playerId === third).goals, 0)
  assert.equal((await service.getPlayerDetails(jordan.id)).stats.gamesPlayed, 0)
  await assert.rejects(service.confirmResults(gameId), { code: 'FORBIDDEN' })
  await assert.rejects(service.setTeam(gameId, jordan.id, 'B'), { code: 'GAME_UNAVAILABLE' })
  await assert.rejects(service.submitReview(gameId, { revieweeId: maya.id, rating: 4, comment: '' }), { code: 'NOT_ELIGIBLE' })

  signInAsDemoAccount(maya.id)
  assert.equal(await service.disputeResults(gameId, 'The score was 3–1.'), 'disputed')
  await assert.rejects(service.confirmResults(gameId), { code: 'RESULT_NOT_PENDING' })
  signInAsDemoAccount(jordan.id)
  const correction = { ...input, teamAScore: 3, performances: [{ playerId: jordan.id, goals: 3 }] }
  assert.equal(await service.submitResults(gameId, correction), 'pending')
  assert.equal((await service.getGame(gameId)).result.revision, 2)
  signInAsDemoAccount(maya.id)
  assert.equal(await service.confirmResults(gameId), 'final')
  assert.equal(await service.confirmResults(gameId), 'final')
  const player = await service.getPlayerDetails(jordan.id)
  assert.equal(player.stats.gamesPlayed, 1)
  assert.equal(player.stats.wins, 1)
  assert.equal(player.sportStats[0].goals, 3)
  assert.equal((await service.getPlayerDetails(maya.id)).stats.losses, 1)
  const review = { revieweeId: jordan.id, rating: 5, comment: 'Great organizer' }
  await service.submitReview(gameId, review)
  await assert.rejects(service.submitReview(gameId, review), { code: 'ALREADY_REVIEWED' })
  await assert.rejects(service.submitReview(gameId, { ...review, revieweeId: maya.id }), { code: 'NOT_ELIGIBLE' })
  await assert.rejects(service.submitReview(gameId, { ...review, revieweeId: 'outside-the-roster' }), { code: 'NOT_ELIGIBLE' })
  const reviewed = await service.getPlayerDetails(jordan.id)
  assert.equal(reviewed.avgRating, 5)
  assert.equal(reviewed.reviewCount, 1)
  assert.deepEqual(Object.keys(reviewed.reviews[0]).sort(), ['comment', 'id', 'rating', 'skillRating', 'sport'])

  signInAsDemoAccount(jordan.id)
  await service.submitResults(gameId, { ...correction, teamAScore: 1, performances: [] })
  assert.equal((await service.getPlayerDetails(jordan.id)).stats.gamesPlayed, 0)
  signInAsDemoAccount(maya.id)
  await service.confirmResults(gameId)
  const finalRecord = await service.getPlayerDetails(jordan.id)
  assert.equal(finalRecord.stats.gamesPlayed, 1)
  assert.equal(finalRecord.stats.draws, 1)
  assert.equal(finalRecord.stats.goals, 0)
  assert.equal(finalRecord.reviewCount, 1)
})

test('result timing uses Tampa game day and invitations close at start time', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-16T03:00:00Z') })
  signInAsDemoAccount(jordan.id)
  const gameId = await createSoccerGame({ startsAt: '2027-01-16T22:00:00Z' })
  await assert.rejects(service.submitResults(gameId, { teamAScore: 0, teamBScore: 0, performances: [] }), { code: 'RESULTS_TOO_EARLY' })
  const invitation = await service.invite(gameId, maya.id)
  t.mock.timers.setTime(new Date('2027-01-16T22:00:00Z').getTime())
  signInAsDemoAccount(maya.id)
  assert.deepEqual(await service.inbox(), [])
  await assert.rejects(service.respond(invitation, 'accepted'), { code: 'GAME_UNAVAILABLE' })
})

test('v1 browser saves retain roster and gain defaults for the v2 fields', async () => {
  localStorage.setItem('pickup-tampa.demo.v1', JSON.stringify({
    accounts: [],
    profiles: [{ id: jordan.id, displayName: 'Jordan', neighborhood: 'west-tampa', sports: [], travelRadiusMiles: 10, bio: '' }],
    games: [{ id: 'old-game', organizerId: jordan.id, venue: 'Field', sport: 'soccer', title: 'Old game',
      startsAt: new Date(Date.now() + 3_600_000).toISOString(), maxPlayers: 2, status: 'scheduled' }],
    roster: [{ gameId: 'old-game', playerId: jordan.id }],
    invitations: [],
  }))
  signInAsDemoAccount(jordan.id)
  const game = await service.getGame('old-game')
  assert.equal(game.endsAt, null)
  assert.equal(game.venueAddress, '')
  assert.equal((await service.getProfile(jordan.id)).neighborhood, 'West Tampa')
  assert.equal((await service.browseGames()).length, 0)
  assert.equal(game.roster[0].team, null)
  assert.equal(game.result, null)
  assert.equal((await service.getPlayerDetails(jordan.id)).reviewCount, 0)
})

test('game form uses Tampa time and rejects daylight-saving gaps and overlaps', () => {
  assert.equal(tampaToIso('2027-01-16T17:00'), '2027-01-16T22:00:00.000Z')
  assert.equal(tampaToIso('2027-07-17T17:00'), '2027-07-17T21:00:00.000Z')
  assert.throws(() => tampaToIso('2027-03-14T02:30'), /daylight-saving/)
  assert.throws(() => tampaToIso('2027-11-07T01:30'), /daylight-saving/)
})
