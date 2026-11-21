
import assert from 'node:assert/strict'
import { after, beforeEach, test } from 'node:test'
import { createServer } from 'vite'

const server = await createServer({
  configFile: false, optimizeDeps: { noDiscovery: true },
  server: { middlewareMode: true, ws: false },
})
after(() => server.close())
const { demoService: service, demoAccounts, signInAsDemoAccount } = await server.ssrLoadModule('/src/services/demo.ts')
const [jordan, maya, andre, sofia, cam] = demoAccounts

function storage() {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage() })
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage() })
})

const sign = account => signInAsDemoAccount(account.id)
const clock = t => t.mock.timers.enable({ apis: ['Date'], now: new Date('2027-01-16T15:00:00Z') })
const game = (options = {}) => service.createGame({
  sport: 'soccer', title: 'Tampa pickup', venue: 'Demo field', neighborhood: 'downtown',
  startsAt: new Date(Date.now() + 45 * 60_000).toISOString(),
  maxPlayers: 2, teamSize: 1, joinMode: 'open', ...options,
})

async function addSport(account, sport, skill = 'intermediate') {
  sign(account)
  const profile = await service.getProfile(account.id)
  await service.saveProfile({ ...profile, sports: [...profile.sports, { sport, skill }] })
}

async function finalize(gameId, scores, confirmer = maya, performances = []) {
  sign(jordan)
  await service.submitResults(gameId, { teamAScore: scores[0], teamBScore: scores[1], performances })
  sign(confirmer)
  assert.equal(await service.confirmResults(gameId), 'final')
  assert.equal(await service.confirmResults(gameId), 'final')
}

test('sport normalization, catalog persistence, signup onboarding, and customized game creation', async t => {
  clock(t)
  const signed = await service.signUp('new@example.test', 'demo-password')
  assert.equal(await service.getProfile(signed.userId), null)
  const [first, second] = await Promise.all([service.createSport('  Disc   Golf  '), service.createSport('disc golf')])
  assert.equal(first.slug, second.slug)
  assert.equal(first.name, 'Disc Golf')
  assert.equal((await service.listSports()).filter(row => row.slug === first.slug).length, 1)
  assert.notEqual((await service.createSport('Disc-Golf')).slug, first.slug)
  await assert.rejects(service.createSport('!'), { code: 'VALIDATION' })
  await service.saveProfile({ displayName: 'Riley', neighborhood: 'downtown', bio: '', travelRadiusMiles: 5,
    sports: [{ sport: first.slug, skill: 'intermediate' }],
    notificationPreferences: { replacementAlerts: false, newGameAlerts: true } })
  assert.equal((await service.getNotificationPreferences()).replacementAlerts, false)
  await service.signOut()
  assert.equal((await service.signIn('new@example.test', 'demo-password')).userId, signed.userId)
  await assert.rejects(game({ sport: first.slug, teamSize: 3 }), { code: 'VALIDATION' })
  const id = await game({ sport: first.slug, description: ' Casual round ', teamSize: 3, maxPlayers: 6 })
  assert.equal((await service.getGame(id)).description, 'Casual round')
  assert.equal((await service.getGame(id)).teamSize, 3)
})

test('future games are discoverable regardless of skill or membership and actions remain caller-scoped', async t => {
  clock(t)
  await assert.rejects(service.browseGames())
  sign(jordan)
  const open = await game({ skillLevel: 'intermediate' })
  const restricted = await game({ joinMode: 'invite_only', skillLevel: 'intermediate', teamSize: 2, maxPlayers: 4 })
  const allLevels = await game({ joinMode: 'invite_only' })
  const otherSport = await game({ joinMode: 'invite_only', sport: 'volleyball' })
  const cancelled = await game({ joinMode: 'invite_only' })
  await service.cancelGame(cancelled)

  sign(andre)
  assert.deepEqual((await service.browseGames()).map(row => row.id), [open, restricted, allLevels, otherSport])
  const detail = await service.getGame(restricted)
  assert.equal(detail.participation.canJoin, false)
  assert.equal(detail.participation.canRequest, false)
  assert.match(detail.participation.ineligibleReason, /Intermediate/)
  assert.match((await service.getGame(otherSport)).participation.ineligibleReason, /Add this sport/)
  assert.equal((await service.getGame(allLevels)).participation.canRequest, true)
  await assert.rejects(service.joinGame(open), { code: 'NOT_ELIGIBLE' })
  await assert.rejects(service.joinGame(allLevels), { code: 'FORBIDDEN' })
  await assert.rejects(service.requestToJoin(restricted), { code: 'NOT_ELIGIBLE' })
  await assert.rejects(service.requestToJoin(otherSport), { code: 'NOT_ELIGIBLE' })
  await assert.rejects(service.requestToJoin(cancelled), { code: 'GAME_UNAVAILABLE' })
  await assert.rejects(service.getChat(restricted), { code: 'FORBIDDEN' })

  const profileless = await service.signUp('viewer@example.test', 'demo-password')
  assert.equal(await service.getProfile(profileless.userId), null)
  assert.equal((await service.browseGames()).length, 4)
  assert.equal((await service.getGame(allLevels)).participation.canRequest, false)
  await assert.rejects(service.requestToJoin(allLevels), { code: 'NOT_ELIGIBLE' })

  sign(maya)
  assert.equal((await service.browseGames({ sport: 'soccer', from: '2027-01-16', to: '2027-01-16' })).length, 3)
  assert.equal((await service.browseGames({ from: '2027-01-17' })).length, 0)
  assert.equal((await service.getGame(open)).participation.canJoin, true)
  await service.joinGame(open)
  await service.joinGame(open)
  assert.equal((await service.browseGames()).find(row => row.id === open).isMember, true)
  assert.equal((await service.browseGames({ openSpots: true })).some(row => row.id === open), false)
  const first = await service.requestToJoin(restricted)
  assert.equal(await service.requestToJoin(restricted), first)
  assert.equal((await service.getGame(restricted)).participation.requestId, first)
  assert.equal((await service.getGame(restricted)).participation.canRequest, false)
  assert.equal((await service.getGame(restricted)).joinRequests.length, 0)
  await service.cancelJoinRequest(first)
  const pending = await service.requestToJoin(restricted)
  assert.notEqual(pending, first)

  sign(jordan)
  assert.equal((await service.notifications()).filter(row => row.type === 'player_joined').length, 1)
  assert.equal((await service.getGame(restricted)).joinRequests[0].playerName, 'Maya Chen')
  await service.respondToJoinRequest(pending, 'approved', 'A')
  await service.respondToJoinRequest(pending, 'approved', 'A')
  const invite = await service.invite(restricted, andre.id, 'B')
  sign(andre)
  assert.equal((await service.getGame(restricted)).sentInvitations.length, 0)
  await service.respond(invite, 'accepted')
  assert.equal((await service.getGame(restricted)).participation.isMember, true)
  sign(maya)
  assert.equal((await service.getGame(restricted)).roster.find(row => row.id === maya.id).team, 'A')
  assert.equal((await service.notifications()).filter(row => row.type === 'join_request_approved').length, 1)
  await assert.rejects(service.requestToJoin(restricted), { code: 'VALIDATION' })
})

test('join approvals check team and game capacity and declines notify only the requester', async t => {
  clock(t)
  sign(jordan)
  const id = await game({ joinMode: 'invite_only' })
  await service.setTeam(id, jordan.id, 'A')
  sign(maya)
  const mayaRequest = await service.requestToJoin(id)
  sign(andre)
  const andreRequest = await service.requestToJoin(id)
  await assert.rejects(service.cancelJoinRequest(mayaRequest), { code: 'FORBIDDEN' })
  await assert.rejects(service.respondToJoinRequest(mayaRequest, 'approved'), { code: 'FORBIDDEN' })
  sign(sofia)
  const sofiaRequest = await service.requestToJoin(id)
  sign(jordan)
  await assert.rejects(service.respondToJoinRequest(mayaRequest, 'approved', 'A'), { code: 'TEAM_FULL' })
  await service.respondToJoinRequest(sofiaRequest, 'approved', 'B')
  await assert.rejects(service.respondToJoinRequest(mayaRequest, 'approved', 'B'), { code: 'GAME_FULL' })
  await service.respondToJoinRequest(mayaRequest, 'declined')
  await service.respondToJoinRequest(mayaRequest, 'declined')

  sign(maya)
  assert.equal((await service.notifications()).filter(row => row.type === 'join_request_declined').length, 1)
  await assert.rejects(service.requestToJoin(id), { code: 'GAME_FULL' })
  sign(andre)
  assert.equal((await service.notifications()).some(row => row.type === 'join_request_declined'), false)
  assert.equal((await service.getGame(id)).participation.requestId, andreRequest)
  assert.equal(await service.cancelJoinRequest(andreRequest), 'cancelled')
  t.mock.timers.setTime(new Date('2027-01-16T16:30:00Z').getTime())
  assert.equal((await service.browseGames()).length, 0)
  assert.equal(await service.getGame(id), null)
  await assert.rejects(service.requestToJoin(id), { code: 'GAME_UNAVAILABLE' })
})

test('team caps, individual and bulk invitations, squad consent and squad invitations', async t => {
  clock(t)
  sign(jordan)
  const id = await game({ joinMode: 'invite_only', skillLevel: 'advanced' })
  await service.setTeam(id, jordan.id, 'A')
  await assert.rejects(service.invite(id, maya.id, 'A'), { code: 'TEAM_FULL' })
  const squadId = await service.createSquad('Sunday Club', 'soccer')
  const code = (await service.mySquads())[0].joinCode
  const bulk = await service.inviteMany(id, [maya.id, cam.id, 'missing'], 'B')
  assert.equal(bulk.filter(row => row.invitationId).length, 2)
  assert.equal(bulk.find(row => row.recipientId === 'missing').error, 'VALIDATION')
  sign(maya)
  assert.equal((await service.mySquads()).length, 0)
  await service.joinSquad(code.toLowerCase())
  await service.joinSquad(code)
  const invitation = (await service.inbox())[0]
  assert.equal(invitation.team, 'B')
  await service.respond(invitation.id, 'accepted')
  sign(cam)
  const fullInvite = (await service.inbox())[0].id
  await assert.rejects(service.respond(fullInvite, 'accepted'), { code: 'GAME_FULL' })
  await service.joinSquad(code)
  sign(jordan)
  const next = await game({ teamSize: 2, maxPlayers: 4 })
  const replies = await service.inviteSquad(next, squadId, 'B')
  assert.equal(replies.length, 2)
  assert.ok(replies.every(row => row.invitationId))
  await service.cancelInvitation(fullInvite)
  await assert.rejects(service.leaveSquad(squadId), { code: 'FORBIDDEN' })
  assert.equal(await service.removeSquadMember(squadId, maya.id), 'removed')
  sign(cam)
  assert.equal(await service.leaveSquad(squadId), 'left')
  const fromSquad = (await service.inbox()).find(row => row.gameId === next)
  assert.equal(fromSquad.squadId, squadId)
  await service.respond(fromSquad.id, 'accepted')
  sign(jordan)
  await service.deleteSquad(squadId)
  assert.equal((await service.getGame(next)).roster.find(row => row.id === cam.id).team, 'B')

  const teamLimited = await game({ teamSize: 2, maxPlayers: 4 })
  await service.setTeam(teamLimited, jordan.id, 'B')
  const a = await service.invite(teamLimited, maya.id, 'B')
  const b = await service.invite(teamLimited, andre.id, 'B')
  sign(maya)
  await service.respond(a, 'accepted')
  sign(andre)
  await assert.rejects(service.respond(b, 'accepted'), { code: 'TEAM_FULL' })
  assert.equal((await service.inbox()).find(row => row.id === b).status, 'pending')
  sign(jordan)
  await service.autoAssignTeams(teamLimited)
  const roster = (await service.getGame(teamLimited)).roster
  assert.ok(roster.filter(row => row.team === 'A').length <= 2)
  assert.ok(roster.filter(row => row.team === 'B').length <= 2)
})

test('chat privacy, notification preferences, withdrawals and serialized replacement claims', async t => {
  clock(t)
  sign(sofia)
  await service.setNotificationPreferences({ replacementAlerts: false, newGameAlerts: true })
  sign(jordan)
  const id = await game()
  await service.setTeam(id, jordan.id, 'A')
  await assert.rejects(service.sendMessage(id, '   '), { code: 'VALIDATION' })
  await service.sendMessage(id, 'Bring water.')
  sign(maya)
  await assert.rejects(service.getChat(id), { code: 'FORBIDDEN' })
  await service.joinGame(id)
  assert.equal((await service.getChatStatus(id)).hasNew, true)
  await service.markChatRead(id)
  assert.equal((await service.getChatStatus(id)).hasNew, false)
  assert.equal((await service.getChat(id))[0].body, 'Bring water.')
  sign(jordan)
  await service.setTeam(id, maya.id, 'B')
  sign(maya)
  await service.withdraw(id)
  await service.withdraw(id)
  assert.equal((await service.myGames()).length, 0)
  await assert.rejects(service.getChat(id), { code: 'FORBIDDEN' })
  await assert.rejects(service.sendMessage(id, 'Still here'), { code: 'FORBIDDEN' })
  assert.equal((await service.notifications()).some(row => row.type === 'replacement_needed'), false)
  sign(sofia)
  assert.deepEqual((await service.notifications()).map(row => row.type), ['new_game_nearby'])
  await assert.rejects(service.claimReplacement(id), { code: 'NOT_ELIGIBLE' })
  sign(andre)
  assert.equal((await service.notifications()).filter(row => row.type === 'replacement_needed').length, 1)
  const alert = (await service.notifications())[0]
  sign(cam)
  assert.equal(await service.markNotificationsRead([alert.id]), 0)

  let queue = Promise.resolve()
  let calls = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { navigator: { locks: {
    request(_key, action) {
      calls++
      const operation = queue.then(action)
      queue = operation.catch(() => {})
      return operation
    },
  } } } })
  t.after(() => { delete globalThis.window })
  sign(andre)
  const one = service.claimReplacement(id)
  sign(cam)
  const two = service.claimReplacement(id)
  const attempts = await Promise.allSettled([one, two])
  assert.equal(calls, 2)
  assert.equal(attempts[0].value, 'joined')
  assert.equal(attempts[1].reason.code, 'GAME_FULL')
  sign(jordan)
  assert.equal((await service.getGame(id)).roster.find(row => row.id === andre.id).team, 'B')
  const notices = await service.notifications()
  assert.equal(notices.filter(row => row.type === 'player_withdrew').length, 1)
  assert.equal(notices.filter(row => row.type === 'replacement_joined').length, 1)
  assert.equal(await service.markNotificationsRead(), notices.length)
  assert.ok((await service.notifications()).every(row => row.readAt))
})

test('universal stats work for custom sports, and configured stats only count the final revision', async t => {
  clock(t)
  sign(jordan)
  const sport = await service.createSport('Disc Golf')
  await addSport(jordan, sport.slug)
  await addSport(maya, sport.slug)
  sign(jordan)
  const custom = await game({ sport: sport.slug })
  sign(maya)
  await service.joinGame(custom)
  sign(jordan)
  await service.autoAssignTeams(custom)
  await finalize(custom, [2, 2])
  const customRecord = (await service.getPlayerDetails(jordan.id)).sportStats.find(row => row.sport === sport.slug)
  assert.equal(customRecord.gamesPlayed, 1)
  assert.equal(customRecord.draws, 1)
  assert.deepEqual(customRecord.metrics, {})

  for (const [scores, goals, assists] of [[[2, 1], 2, 1], [[1, 2], 1, 0]]) {
    sign(jordan)
    const soccer = await game()
    sign(maya)
    await service.joinGame(soccer)
    sign(jordan)
    await service.setTeam(soccer, jordan.id, 'A')
    await service.setTeam(soccer, maya.id, 'B')
    await assert.rejects(service.submitResults(soccer, { teamAScore: 2, teamBScore: 1,
      performances: [{ playerId: jordan.id, metrics: { rebounds: 2 } }] }), { code: 'VALIDATION' })
    await finalize(soccer, scores, maya, [{ playerId: jordan.id, metrics: { goals, assists } }])
  }
  const totals = (await service.getPlayerDetails(jordan.id)).sportStats.find(row => row.sport === 'soccer')
  assert.equal(totals.gamesPlayed, 2)
  assert.equal(totals.wins, 1)
  assert.equal(totals.losses, 1)
  assert.deepEqual(totals.metrics, { goals: 3, assists: 1 })
  sign(jordan)
  const basketball = await game({ sport: 'basketball' })
  sign(andre)
  await service.joinGame(basketball)
  sign(jordan)
  await service.autoAssignTeams(basketball)
  await finalize(basketball, [4, 2], andre, [{ playerId: jordan.id, metrics: { rebounds: 3 } }])
  assert.equal((await service.getPlayerDetails(jordan.id)).sportStats.find(row => row.sport === 'basketball').metrics.rebounds, 3)
})

test('private skill evidence verifies only after enough distinct raters and locks level edits', async t => {
  clock(t)
  async function played(roster) {
    sign(jordan)
    const id = await game({ teamSize: 2, maxPlayers: 4 })
    for (const account of roster) { sign(account); await service.joinGame(id) }
    sign(jordan)
    await service.autoAssignTeams(id)
    await finalize(id, [1, 1], roster[0])
    return id
  }
  const first = await played([maya, andre])
  const second = await played([cam, maya])
  const review = { revieweeId: jordan.id, rating: 1, skillRating: 5, comment: 'Good positioning' }
  sign(maya)
  await service.submitReview(first, review)
  await assert.rejects(service.submitReview(first, review), { code: 'ALREADY_REVIEWED' })
  sign(andre)
  await service.submitReview(first, review)
  assert.equal((await service.getProfile(jordan.id)).sports[0].skill, 'intermediate')
  assert.equal((await service.getProfile(jordan.id)).sports[0].levelSource, 'self')
  sign(cam)
  await service.submitReview(second, review)
  const player = await service.getPlayerDetails(jordan.id)
  const soccer = player.sports.find(item => item.sport === 'soccer')
  assert.equal(soccer.skill, 'advanced')
  assert.equal(soccer.levelSource, 'verified')
  assert.equal(soccer.ratingCount, 3)
  assert.equal(player.avgRating, 1)
  assert.ok(player.reviews.every(item => !('reviewerId' in item) && !('reviewerName' in item) && !('gameId' in item) && !('createdAt' in item)))
  sign(jordan)
  assert.equal((await service.notifications()).filter(row => row.type === 'level_changed').length, 1)
  const downgrade = { ...player, sports: player.sports.map(item => item.sport === 'soccer' ? { ...item, skill: 'beginner' } : item) }
  await assert.rejects(service.saveProfile(downgrade), { code: 'LEVEL_LOCKED' })
  await service.saveProfile({ ...player, sports: player.sports.filter(item => item.sport !== 'soccer') })
  assert.equal((await service.saveProfile(downgrade)).sports.find(item => item.sport === 'soccer').skill, 'advanced')
})


test('skill calculation uses the latest rating per rater and trims both extremes', async () => {
  const { recalculateLevel } = await server.ssrLoadModule('/src/services/demoRules.ts')
  const record = { playerId: jordan.id, sport: 'soccer', starting: 'intermediate', level: 'intermediate', verified: false, ratingCount: 0 }
  const first = 'game-one'
  const second = 'game-two'
  const ratings = [
    [maya.id, first, 1], [andre.id, first, 5], [sofia.id, second, 5],
    [cam.id, second, 5], ['fifth-rater', first, 1], [maya.id, second, 5],
  ]
  const data = {
    skillRecords: [record],
    catalog: [{ slug: 'soccer', name: 'Soccer', fields: [] }],
    profiles: [{ id: jordan.id, sports: [{ sport: 'soccer', skill: 'intermediate' }] }],
    results: [{ gameId: first, status: 'final' }, { gameId: second, status: 'final' }],
    reviews: ratings.map(([reviewerId, gameId, skillRating]) => ({
      reviewerId, gameId, skillRating, revieweeId: jordan.id, sport: 'soccer',
    })),
    notices: [],
  }
  recalculateLevel(data, jordan.id, 'soccer')
  assert.equal(record.level, 'advanced')
  assert.equal(record.verified, true)
  assert.equal(record.ratingCount, 3)
  assert.equal(data.notices.length, 1)
  // Intermediate-equivalent scores within the buffer do not immediately demote an advanced player.
  data.reviews = ratings.slice(0, 3).map(([reviewerId, gameId]) => ({
    reviewerId, gameId, skillRating: 4, revieweeId: jordan.id, sport: 'soccer',
  }))
  recalculateLevel(data, jordan.id, 'soccer')
  assert.equal(record.level, 'advanced')
  assert.equal(data.notices.length, 1)
})

test('withdrawal outside the emergency window notifies the organizer without replacement alerts', async t => {
  clock(t)
  sign(jordan)
  const id = await game({ startsAt: new Date(Date.now() + 61 * 60_000).toISOString() })
  sign(maya)
  await service.joinGame(id)
  await service.withdraw(id)
  sign(andre)
  assert.equal((await service.notifications()).some(row => row.type === 'replacement_needed'), false)
  sign(jordan)
  assert.equal((await service.notifications()).filter(row => row.type === 'player_withdrew').length, 1)
})
