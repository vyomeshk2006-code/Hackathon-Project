import { tampaInput } from '../lib/time'
import { isActiveGame, isUpcoming, neighborhoodLabel, seededSports, skills } from '../types/domain'
import type {
  DirectoryPlayer, Game, GameEdit, Invitation, PlayerGameStat, Skill, Team,
} from '../types/domain'
import type { PickupService } from './contract'
import { displayName, finalReviews, ratingFor, statsFor, summary } from './demoQueries'
import type { DemoData } from './demoQueries'
import { requireRule } from './errors'
import { demoParticipation } from './demoParticipation'
import { demoCommunity } from './demoCommunity'
import { demoAccount } from './demoAccount'
import { skillRatingsFor } from './demoRatings'
import { addToRoster, canSeeGame, emit, notifyNewGame, participation, preferenceFor, profileFor, requireContact, rosterFor, teamHasRoom } from './demoRules'

const dataKey = 'pickup-tampa.demo.v1'
const sessionKey = 'pickup-tampa.session.v1'
const changes = new EventTarget()

export const demoAccounts = [
  { id: '10000000-0000-4000-8000-000000000001', label: 'Jordan · Organizer', email: 'jordan@example.test' },
  { id: '10000000-0000-4000-8000-000000000002', label: 'Maya · Player', email: 'maya@example.test' },
  { id: '10000000-0000-4000-8000-000000000003', label: 'Andre · Player', email: 'andre@example.test' },
  { id: '10000000-0000-4000-8000-000000000004', label: 'Sofia · Player', email: 'sofia@example.test' },
  { id: '10000000-0000-4000-8000-000000000005', label: 'Cam · Player', email: 'cam@example.test' },
] as const

const initialData: DemoData = {
  accounts: [],
  games: [],
  roster: [],
  invitations: [],
  results: [],
  performances: [],
  reviews: [],
  catalog: seededSports,
  requests: [], notices: [], squads: [], withdrawals: [], alerts: [],
  contacts: demoAccounts.map((account, index) => ({ playerId: account.id, phoneNumber: '+1202555010' + index })),
  profiles: [
    {
      id: demoAccounts[0].id, displayName: 'Jordan Rivera', username: 'jordan', neighborhood: 'downtown',
      bio: 'I organize casual games after work. All skill levels welcome.',
      sports: [{ sport: 'soccer', skill: 'intermediate' }, { sport: 'basketball', skill: 'beginner' }],
    },
    {
      id: demoAccounts[1].id, displayName: 'Maya Chen', username: 'maya', neighborhood: 'usf',
      bio: 'Usually up for a small-sided soccer game near campus.',
      sports: [{ sport: 'soccer', skill: 'intermediate' }, { sport: 'volleyball', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000003', displayName: 'Andre Lewis', username: 'andre', neighborhood: 'south-tampa',
      bio: 'Weekend hoops, weeknight futsal.',
      sports: [{ sport: 'basketball', skill: 'advanced' }, { sport: 'soccer', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000004', displayName: 'Sofia Torres', username: 'sofia', neighborhood: 'seminole-heights',
      bio: 'I like early games and a good doubles partner.',
      sports: [{ sport: 'pickleball', skill: 'intermediate' }, { sport: 'soccer', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000005', displayName: 'Cam Brooks', username: 'cam', neighborhood: 'west-tampa',
      bio: 'Always looking for a regular volleyball group.',
      sports: [{ sport: 'volleyball', skill: 'advanced' }, { sport: 'basketball', skill: 'intermediate' }, { sport: 'soccer', skill: 'beginner' }],
    },
  ],
}

function read(): DemoData {
  const stored = localStorage.getItem(dataKey)
  const saved = stored ? JSON.parse(stored) as Partial<DemoData> & {
    messages?: unknown; chatReads?: unknown; skillRecords?: { playerId: string; sport: string; starting: Skill }[]
  } : undefined
  const { messages: _messages, chatReads: _chatReads, skillRecords: legacySkills, ...legacy } = saved ?? {}
  const data: DemoData = { ...structuredClone(initialData), ...legacy }
  if (saved && !saved.contacts) data.contacts = []
  // Keep the original storage key and fill fields missing from v1 saves.
  return {
    ...data,
    profiles: data.profiles.map(({ id, displayName, username, neighborhood, bio, sports, notificationPreferences }) => ({
      id, displayName, username, neighborhood: neighborhoodLabel(neighborhood), bio, notificationPreferences,
      sports: sports.map(({ sport, skill }) => ({
        sport, skill: legacySkills?.find(row => row.playerId === id && row.sport === sport)?.starting ?? skill,
      })),
    })),
    games: data.games.map(game => ({
      ...game,
      teamSize: game.teamSize ?? null,
      joinMode: game.joinMode ?? 'invite_only',
      skillLevel: game.skillLevel ?? null,
      description: game.description ?? '',
      venueAddress: game.venueAddress ?? '',
      endsAt: game.endsAt && Date.parse(game.endsAt) > Date.parse(game.startsAt) ? game.endsAt : null,
    })),
    roster: data.roster.map(entry => ({
      ...entry,
      team: entry.team ?? null,
      joinedAt: entry.joinedAt ?? data.games.find(game => game.id === entry.gameId)?.startsAt ?? new Date(0).toISOString(),
    })),
    invitations: data.invitations.map(invite => ({ ...invite, team: invite.team ?? null, respondedAt: invite.respondedAt ?? null })),
    results: data.results ?? [],
    performances: data.performances.map(row => ({
      ...row, metrics: row.metrics ?? Object.fromEntries((data.catalog.find(item =>
        item.slug === data.games.find(game => game.id === row.gameId)?.sport)?.fields ?? [])
        .map(field => [field, field === 'goals' || field === 'assists' || field === 'points' ? row[field] : 0])),
    })),
    reviews: data.reviews.map(review => ({
      ...review, sport: review.sport ?? data.games.find(game => game.id === review.gameId)?.sport ?? 'unknown',
      skillRating: review.skillRating ?? null,
    })),
  }
}

function notify() {
  changes.dispatchEvent(new Event('change'))
}

async function updateData<T>(mutate: (data: DemoData) => T): Promise<T> {
  function write() {
    const data = read()
    const result = mutate(data)
    localStorage.setItem(dataKey, JSON.stringify(data))
    notify()
    return result
  }

  // Serialize read-modify-write operations across tabs on the same origin.
  const locks = typeof window === 'undefined' ? undefined : window.navigator.locks
  return locks ? locks.request(dataKey, write) : write()
}

function currentUser() {
  const id = sessionStorage.getItem(sessionKey)
  const account = demoAccounts.find(account => account.id === id) ??
    read().accounts.find(account => account.id === id)
  return account ? { userId: account.id, email: account.email } : null
}

function requireUser() {
  const session = currentUser()
  if (!session) throw new Error('Log in to continue.')
  return session.userId
}

function startSession(id: string, email: string) {
  sessionStorage.setItem(sessionKey, id)
  notify()
  return { userId: id, email }
}

async function passwordVerifier(password: string, salt: string) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    salt: encoder.encode(salt),
    iterations: 100_000,
    hash: 'SHA-256',
  }, key, 256)
  return Array.from(new Uint8Array(bits), byte => byte.toString(16).padStart(2, '0')).join('')
}

const now = () => new Date().toISOString()
const integerBetween = (value: number, min: number, max: number) => Number.isInteger(value) && value >= min && value <= max
const sportRank = { beginner: 1, intermediate: 2, advanced: 3 }
const snakeOrder = ['A', 'B', 'B', 'A'] as const

function parseScheduleInstant(value: string) {
  const calendarDate = value.slice(0, 10)
  const day = new Date(calendarDate + 'T00:00:00Z')
  const validTime = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
  return validTime && Number.isFinite(day.valueOf()) && day.toISOString().slice(0, 10) === calendarDate ? Date.parse(value) : NaN
}

function validateGameEdit(input: GameEdit) {
  const title = input.title.trim()
  const venue = input.venue.trim()
  const venueAddress = input.venueAddress.trim()
  const description = input.description?.trim() ?? ''
  requireRule(title.length >= 1 && title.length <= 80 && venue.length >= 1 && venue.length <= 100 &&
    venueAddress.length >= 3 && venueAddress.length <= 200 && description.length <= 500,
    'VALIDATION', 'Enter a title, venue name, and exact venue address.')
  const start = parseScheduleInstant(input.startsAt)
  const end = parseScheduleInstant(input.endsAt)
  requireRule(start > Date.now() && end > start,
    'VALIDATION', 'Choose a future start and an end time after the start.')
  return { title, venue, venueAddress, description, startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString() }
}

function organizedGame(data: DemoData, id: string, userId: string) {
  const game = data.games.find(game => game.id === id && game.organizerId === userId)
  requireRule(game, 'FORBIDDEN')
  return game
}

function closeInvitation(invite: Invitation, status: Exclude<Invitation['status'], 'pending'>) {
  invite.status = status
  invite.respondedAt = now()
}

function closePending(data: DemoData, gameId: string, status: 'cancelled' | 'expired') {
  for (const invite of data.invitations) {
    if (invite.gameId === gameId && invite.status === 'pending') closeInvitation(invite, status)
  }
}

function closeRequests(data: DemoData, gameId: string) {
  for (const request of data.requests) {
    if (request.gameId !== gameId || request.status !== 'pending') continue
    request.status = 'cancelled'
    request.respondedAt = now()
  }
}

function otherRosterResult(data: DemoData, gameId: string, userId: string) {
  const game = data.games.find(game => game.id === gameId)
  requireRule(game && game.organizerId !== userId &&
    data.roster.some(entry => entry.gameId === gameId && entry.playerId === userId), 'FORBIDDEN')
  const result = data.results.find(result => result.gameId === gameId)
  requireRule(result, 'RESULT_NOT_PENDING')
  requireRule(result.submittedBy !== userId, 'FORBIDDEN')
  return result
}

export function signInAsDemoAccount(id: string) {
  const account = demoAccounts.find(account => account.id === id)
  if (!account) throw new Error('This demo account is unavailable.')
  startSession(account.id, account.email)
}

const context = { read, updateData, requireUser, subscribe: (listener: () => void) => demoService.subscribe(listener) }

export const demoService: PickupService = {
  ...demoParticipation(context),
  ...demoCommunity(context),
  ...demoAccount(context),
  async getSession() {
    return currentUser()
  },

  async signUp(email, password) {
    const normalized = email.trim().toLowerCase()
    const salt = crypto.randomUUID()
    const verifier = await passwordVerifier(password, salt)
    const id = crypto.randomUUID()
    await updateData(data => {
      if ([...demoAccounts, ...data.accounts].some(account => account.email === normalized)) {
        throw new Error('A demo account already uses this email. Log in instead.')
      }
      data.accounts.push({ id, email: normalized, salt, verifier })
    })
    return startSession(id, normalized)
  },

  async signIn(email, password) {
    const normalized = email.trim().toLowerCase()
    const account = read().accounts.find(account => account.email === normalized)
    if (!account || (await passwordVerifier(password, account.salt)) !== account.verifier) {
      throw new Error('The demo email or password is incorrect.')
    }
    return startSession(account.id, account.email)
  },

  async signOut() {
    sessionStorage.removeItem(sessionKey)
    notify()
  },

  async getProfile(id) {
    requireUser()
    return read().profiles.find(profile => profile.id === id) ?? null
  },

  async getPlayerDetails(id) {
    requireUser()
    const data = read()
    const profile = data.profiles.find(profile => profile.id === id)
    if (!profile) return null
    const reviews = finalReviews(data, id).reverse().map(({ id, sport, rating, skillRating, comment }) => ({
      id, sport, rating, skillRating, comment,
    }))
    const totals = statsFor(data, id)
    return { ...profile, ...totals, ...ratingFor(data, id), reviews, skillRatings: skillRatingsFor(data, id, totals.sportStats) }
  },

  async findPlayers(filters) {
    const id = requireUser()
    const data = read()
    const { sport, skill, gameId } = filters
    const name = filters.name?.trim().toLowerCase()
    requireRule((!sport || data.catalog.some(item => item.slug === sport)) && (!skill || Object.hasOwn(skills, skill)), 'VALIDATION')

    if (gameId) organizedGame(data, gameId, id)
    const unavailable = new Set<string>()
    if (gameId) {
      for (const entry of data.roster) if (entry.gameId === gameId) unavailable.add(entry.playerId)
      if (filters.replacement) for (const row of data.withdrawals) if (row.gameId === gameId) unavailable.add(row.playerId)
      for (const invite of data.invitations) {
        if (invite.gameId === gameId && invite.status === 'pending') unavailable.add(invite.recipientId)
      }
    }

    const matches: DirectoryPlayer[] = []
    for (const profile of data.profiles) {
      if (profile.id === id || unavailable.has(profile.id) || (name &&
        !profile.displayName.toLowerCase().includes(name) && !profile.username?.includes(name.replace(/^@/, '')))) continue
      if ((sport || skill) && !profile.sports.some(item => (!sport || item.sport === sport) && (!skill || item.skill === skill))) continue
      const { notificationPreferences: _privatePreferences, ...publicProfile } = profile
      matches.push({ ...publicProfile, ...ratingFor(data, profile.id), ...statsFor(data, profile.id) })
    }
    return matches.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
  },

  async createGame(input) {
    const organizerId = requireUser()
    const game: Game = {
      ...validateGameEdit(input), sport: input.sport, maxPlayers: input.maxPlayers,
      teamSize: input.teamSize ?? null, joinMode: input.joinMode ?? 'invite_only',
      skillLevel: input.skillLevel ?? null,
      id: crypto.randomUUID(), organizerId, status: 'scheduled',
    }
    requireRule((game.joinMode === 'open' || game.joinMode === 'invite_only') &&
      (!game.skillLevel || Object.hasOwn(skills, game.skillLevel)), 'VALIDATION')
    requireRule(integerBetween(game.maxPlayers, 2, 50), 'VALIDATION', 'Set capacity between 2 and 50 players.')
    requireRule(game.teamSize === null || (integerBetween(game.teamSize, 1, 25) && game.maxPlayers === game.teamSize * 2),
      'VALIDATION', 'Maximum players must be twice the team size.')
    return updateData(data => {
      requireRule(data.profiles.some(profile => profile.id === organizerId), 'PROFILE_REQUIRED')
      requireContact(data, organizerId)
      requireRule(data.catalog.some(sport => sport.slug === game.sport), 'VALIDATION', 'Choose a sport from the catalog.')
      data.games.push(game)
      data.roster.push({ gameId: game.id, playerId: organizerId, team: null, joinedAt: now() })
      notifyNewGame(data, game)
      return game.id
    })
  },

  async editGame(gameId, input) {
    const caller = requireUser()
    await updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(isUpcoming(game), 'GAME_UNAVAILABLE', 'Edit game details before kickoff.')
      requireContact(data, caller)
      Object.assign(game, validateGameEdit(input))
    })
  },

  async myGames() {
    const id = requireUser()
    const data = read()
    return data.games
      .filter(game => game.organizerId === id || data.roster.some(entry => entry.gameId === game.id && entry.playerId === id))
      .map(game => summary(data, game, true))
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
  },

  async getGame(id) {
    const userId = requireUser()
    const data = read()
    const game = data.games.find(game => game.id === id)
    if (!game) return null
    const entries = data.roster.filter(entry => entry.gameId === id)
    const onRoster = entries.some(entry => entry.playerId === userId)
    const organizer = game.organizerId === userId
    if (!canSeeGame(data, game, userId)) return null

    return {
      ...summary(data, game, onRoster),
      participation: participation(data, game, userId),
      joinRequests: organizer ? data.requests.filter(row => row.gameId === id).reverse()
        .map(row => {
          const applicant = profileFor(data, row.playerId)
          return { ...row, playerName: displayName(data, row.playerId), username: applicant?.username,
            neighborhood: applicant?.neighborhood, skill: preferenceFor(applicant, game.sport)?.skill }
        }) : [],
      roster: entries.map(entry => ({
        id: entry.playerId, displayName: displayName(data, entry.playerId), team: entry.team,
        skill: preferenceFor(profileFor(data, entry.playerId), game.sport)?.skill,
        stats: statsFor(data, entry.playerId).stats,
      })),
      performances: onRoster ? data.performances.filter(row => row.gameId === id) : [],
      sentInvitations: organizer ? data.invitations.filter(invite => invite.gameId === id).reverse()
        .map(invite => ({ ...invite, recipientName: displayName(data, invite.recipientId) })) : [],
      reviewedPlayerIds: onRoster ? data.reviews.filter(review => review.gameId === id && review.reviewerId === userId)
        .map(review => review.revieweeId) : [],
    }
  },

  async inbox() {
    const recipientId = requireUser()
    const data = read()
    return data.invitations.filter(invite => invite.recipientId === recipientId && invite.status === 'pending')
      .flatMap(invite => {
        const game = data.games.find(game => game.id === invite.gameId)
        if (!game || !isUpcoming(game)) return []
        return [{ ...invite, game: summary(data, game), senderName: displayName(data, invite.senderId) }]
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  },

  async respond(invitationId, response) {
    const recipientId = requireUser()
    requireRule(response === 'accepted' || response === 'declined', 'VALIDATION')
    return updateData(data => {
      const invite = data.invitations.find(invite => invite.id === invitationId)
      requireRule(invite?.recipientId === recipientId, 'FORBIDDEN', 'This invitation is unavailable.')
      if (invite.status === response) return response
      requireRule(invite.status === 'pending', 'INVITATION_CLOSED')
      const game = data.games.find(game => game.id === invite.gameId)
      requireRule(game && isUpcoming(game), 'GAME_UNAVAILABLE')
      if (response === 'accepted') {
        requireRule(isActiveGame(game), 'GAME_UNAVAILABLE')
        addToRoster(data, game, recipientId, invite.team)
      }
      closeInvitation(invite, response)
      emit(data, game.organizerId, response === 'accepted' ? 'invitation_accepted' : 'invitation_declined',
        response === 'accepted' ? 'Invitation accepted' : 'Invitation declined',
        displayName(data, recipientId) + ' · ' + game.title, { gameId: game.id, invitationId })
      return response
    })
  },

  async cancelInvitation(invitationId) {
    const caller = requireUser()
    return updateData(data => {
      const invite = data.invitations.find(invite => invite.id === invitationId)
      requireRule(invite, 'FORBIDDEN')
      organizedGame(data, invite.gameId, caller)
      if (invite.status === 'cancelled') return 'cancelled'
      requireRule(invite.status === 'pending', 'INVITATION_CLOSED')
      closeInvitation(invite, 'cancelled')
      emit(data, invite.recipientId, 'invitation_cancelled', 'Invitation cancelled', 'The organizer cancelled your invitation.', { gameId: invite.gameId, invitationId })
      return 'cancelled'
    })
  },

  async cancelGame(gameId) {
    const caller = requireUser()
    return updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(game.status === 'scheduled', 'GAME_UNAVAILABLE')
      game.status = 'cancelled'
      const recipients = new Set([...rosterFor(data, gameId).map(row => row.playerId),
        ...data.invitations.filter(row => row.gameId === gameId && row.status === 'pending').map(row => row.recipientId),
        ...data.requests.filter(row => row.gameId === gameId && row.status === 'pending').map(row => row.playerId)])
      closePending(data, game.id, 'cancelled')
      closeRequests(data, game.id)
      recipients.delete(caller)
      for (const id of recipients) emit(data, id, 'game_cancelled', 'Game cancelled', game.title, { gameId })
      return 'cancelled'
    })
  },

  async setTeam(gameId, playerId, team) {
    const caller = requireUser()
    requireRule(team === null || team === 'A' || team === 'B', 'VALIDATION')
    return updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(game.status === 'scheduled', 'GAME_UNAVAILABLE')
      const member = data.roster.find(entry => entry.gameId === gameId && entry.playerId === playerId)
      requireRule(member, 'VALIDATION', 'Choose a player from the roster.')
      requireRule(teamHasRoom(data, game, team, playerId), 'TEAM_FULL')
      member.team = team
      return team
    })
  },

  async autoAssignTeams(gameId) {
    const caller = requireUser()
    return updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(game.status === 'scheduled', 'GAME_UNAVAILABLE')
      const ranked = data.roster.filter(entry => entry.gameId === gameId).map(entry => {
        const skill = data.profiles.find(profile => profile.id === entry.playerId)?.sports
          .find(preference => preference.sport === game.sport)?.skill
        const stats = statsFor(data, entry.playerId).sportStats.find(row => row.sport === game.sport)
        const winRate = stats?.gamesPlayed ? stats.wins / stats.gamesPlayed : 0
        return { entry, rank: skill ? sportRank[skill] : 0, winRate }
      }).sort((a, b) => b.rank - a.rank || b.winRate - a.winRate)
      const sizes = { A: 0, B: 0 }
      return ranked.map(({ entry }, index) => {
        const draft = snakeOrder[index % snakeOrder.length]
        const team = game.teamSize !== null && sizes[draft] >= game.teamSize ? (draft === 'A' ? 'B' : 'A') : draft
        sizes[team]++
        entry.team = team
        return { playerId: entry.playerId, team }
      })
    })
  },

  async submitResults(gameId, input) {
    const caller = requireUser()
    requireRule(integerBetween(input.teamAScore, 0, 999) && integerBetween(input.teamBScore, 0, 999),
      'VALIDATION', 'Enter whole-number scores from 0 to 999.')
    return updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(game.status !== 'cancelled', 'GAME_UNAVAILABLE')
      requireRule(tampaInput(new Date(game.startsAt)).slice(0, 10) <= tampaInput(new Date()).slice(0, 10), 'RESULTS_TOO_EARLY')
      const roster = data.roster.filter(entry => entry.gameId === gameId)
      requireRule(roster.every(entry => entry.team !== null) &&
        roster.some(entry => entry.team === 'A') && roster.some(entry => entry.team === 'B'), 'TEAMS_INCOMPLETE')

      const performances = new Map(input.performances.map(row => [row.playerId, row]))
      const fields = data.catalog.find(sport => sport.slug === game.sport)?.fields ?? []
      requireRule(performances.size === input.performances.length && input.performances.every(row =>
        roster.some(entry => entry.playerId === row.playerId) &&
        [row.goals, row.points, row.assists].every(value => value === undefined || integerBetween(value, 0, 32767)) &&
        Object.entries(row.metrics ?? {}).every(([key, value]) => fields.includes(key) && integerBetween(value, 0, 32767))),
        'VALIDATION', 'Enter whole-number statistics for roster players only.')

      const rows: PlayerGameStat[] = roster.map(entry => {
        const team = entry.team as Team
        const margin = (input.teamAScore - input.teamBScore) * (team === 'A' ? 1 : -1)
        const source = performances.get(entry.playerId)
        const values = { goals: source?.goals, assists: source?.assists, points: source?.points, ...source?.metrics } as Record<string, number | undefined>
        const metrics = Object.fromEntries(fields.map(field => [field, values[field] ?? 0]))
        return {
          gameId, playerId: entry.playerId, team, outcome: margin === 0 ? 'draw' : margin > 0 ? 'win' : 'loss',
          metrics, goals: metrics.goals ?? 0, assists: metrics.assists ?? 0, points: metrics.points ?? 0,
        }
      })
      const previous = data.results.find(result => result.gameId === gameId)
      data.results = data.results.filter(result => result.gameId !== gameId)
      data.results.push({
        gameId, teamAScore: input.teamAScore, teamBScore: input.teamBScore, status: 'pending',
        submittedBy: caller, submittedAt: now(), confirmedBy: null, confirmedAt: null, disputeReason: null,
        revision: (previous?.revision ?? 0) + 1,
      })
      data.performances = [...data.performances.filter(row => row.gameId !== gameId), ...rows]
      game.status = 'completed'
      closePending(data, gameId, 'expired')
      closeRequests(data, gameId)
      for (const row of roster) {
        if (row.playerId !== caller) emit(data, row.playerId, 'results_submitted', 'Results ready for review', game.title, { gameId })
      }
      return 'pending'
    })
  },

  async confirmResults(gameId) {
    const caller = requireUser()
    return updateData(data => {
      const result = otherRosterResult(data, gameId, caller)
      if (result.status === 'final' && result.confirmedBy === caller) return 'final'
      requireRule(result.status === 'pending', 'RESULT_NOT_PENDING')
      result.status = 'final'
      result.confirmedBy = caller
      result.confirmedAt = now()
      const game = data.games.find(row => row.id === gameId)!
      for (const row of rosterFor(data, gameId)) {
        emit(data, row.playerId, 'results_confirmed', 'Results confirmed', game.title, { gameId })
      }
      return 'final'
    })
  },

  async disputeResults(gameId, reason) {
    const caller = requireUser()
    const trimmed = reason.trim()
    requireRule(trimmed.length > 0 && trimmed.length <= 300, 'VALIDATION', 'Enter a reason of 1–300 characters.')
    return updateData(data => {
      const result = otherRosterResult(data, gameId, caller)
      requireRule(result.status === 'pending', 'RESULT_NOT_PENDING')
      result.status = 'disputed'
      result.disputeReason = trimmed
      emit(data, result.submittedBy, 'results_disputed', 'Result disputed', trimmed, { gameId })
      return 'disputed'
    })
  },

  async submitReview(gameId, input) {
    const reviewerId = requireUser()
    const comment = input.comment.trim()
    const { revieweeId, rating, skillRating } = input
    requireRule(integerBetween(rating, 1, 5) && (skillRating === undefined || integerBetween(skillRating, 1, 5)) && comment.length <= 500, 'VALIDATION')
    return updateData(data => {
      const players = new Set(data.roster.filter(entry => entry.gameId === gameId).map(entry => entry.playerId))
      requireRule(reviewerId !== revieweeId && players.has(reviewerId) && players.has(revieweeId) &&
        data.results.some(result => result.gameId === gameId && result.status === 'final'), 'NOT_ELIGIBLE')
      requireRule(!data.reviews.some(review => review.gameId === gameId &&
        review.reviewerId === reviewerId && review.revieweeId === revieweeId), 'ALREADY_REVIEWED')
      const id = crypto.randomUUID()
      const sport = data.games.find(game => game.id === gameId)!.sport
      data.reviews.push({ id, gameId, reviewerId, revieweeId, rating, skillRating: skillRating ?? null, sport, comment, createdAt: now() })
      return id
    })
  },

  subscribe(listener) {
    function onStorage(event: StorageEvent) {
      if (event.key === dataKey || event.key === null) listener()
    }
    changes.addEventListener('change', listener)
    window.addEventListener('storage', onStorage)
    return () => {
      changes.removeEventListener('change', listener)
      window.removeEventListener('storage', onStorage)
    }
  },
}
