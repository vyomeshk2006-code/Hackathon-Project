import { tampaInput } from '../lib/time'
import { defaultPreferences, isUpcoming, neighborhoods, seededSports, skills } from '../types/domain'
import type {
  DirectoryPlayer, Game, Invitation, PlayerGameStat, Profile, Team,
} from '../types/domain'
import type { PickupService } from './contract'
import { displayName, finalReviews, neighborhoodDistance, ratingFor, statsFor, summary } from './demoQueries'
import type { DemoData } from './demoQueries'
import { requireRule } from './errors'
import { demoParticipation } from './demoParticipation'
import { demoCommunity } from './demoCommunity'
import { addToRoster, canSeeGame, emit, notifyNewGame, participation, preferenceFor, profileFor, recalculateLevel, rosterFor, teamHasRoom } from './demoRules'

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
  requests: [], notices: [], messages: [], chatReads: [], squads: [], withdrawals: [], alerts: [], skillRecords: [],
  profiles: [
    {
      id: demoAccounts[0].id, displayName: 'Jordan Rivera', neighborhood: 'downtown',
      travelRadiusMiles: 12, bio: 'I organize casual games after work. All skill levels welcome.',
      sports: [{ sport: 'soccer', skill: 'intermediate' }, { sport: 'basketball', skill: 'beginner' }],
    },
    {
      id: demoAccounts[1].id, displayName: 'Maya Chen', neighborhood: 'usf',
      travelRadiusMiles: 10, bio: 'Usually up for a small-sided soccer game near campus.',
      sports: [{ sport: 'soccer', skill: 'intermediate' }, { sport: 'volleyball', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000003', displayName: 'Andre Lewis', neighborhood: 'south-tampa',
      travelRadiusMiles: 15, bio: 'Weekend hoops, weeknight futsal.',
      sports: [{ sport: 'basketball', skill: 'advanced' }, { sport: 'soccer', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000004', displayName: 'Sofia Torres', neighborhood: 'seminole-heights',
      travelRadiusMiles: 8, bio: 'I like early games and a good doubles partner.',
      sports: [{ sport: 'pickleball', skill: 'intermediate' }, { sport: 'soccer', skill: 'beginner' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000005', displayName: 'Cam Brooks', neighborhood: 'west-tampa',
      travelRadiusMiles: 18, bio: 'Always looking for a regular volleyball group.',
      sports: [{ sport: 'volleyball', skill: 'advanced' }, { sport: 'basketball', skill: 'intermediate' }, { sport: 'soccer', skill: 'beginner' }],
    },
  ],
}

function read(): DemoData {
  const stored = localStorage.getItem(dataKey)
  const data: DemoData = stored ? { ...structuredClone(initialData), ...JSON.parse(stored) } : structuredClone(initialData)
  // Keep the original storage key and fill fields missing from v1 saves.
  return {
    ...data,
    games: data.games.map(game => ({
      ...game,
      teamSize: game.teamSize ?? null,
      joinMode: game.joinMode ?? 'invite_only',
      skillLevel: game.skillLevel ?? null,
      description: game.description ?? '',
      neighborhood: game.neighborhood ?? data.profiles.find(profile => profile.id === game.organizerId)?.neighborhood ?? 'other-tampa',
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
    skillRecords: [...data.skillRecords, ...data.profiles.flatMap(profile => profile.sports
      .filter(preference => !data.skillRecords.some(record => record.playerId === profile.id && record.sport === preference.sport))
      .map(preference => ({ playerId: profile.id, sport: preference.sport, starting: preference.skill,
        level: preference.skill, verified: false, ratingCount: 0 })))],
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
    return { ...profile, ...statsFor(data, id), ...ratingFor(data, id), reviews }
  },

  async saveProfile(input) {
    const id = requireUser()
    const profile: Profile = { ...input, id, displayName: input.displayName.trim(), bio: input.bio.trim() }
    requireRule(profile.displayName.length > 0 && profile.displayName.length <= 60 && profile.bio.length <= 300,
      'VALIDATION', 'Enter a name of 1–60 characters and a bio of up to 300 characters.')
    requireRule(Object.hasOwn(neighborhoods, profile.neighborhood) && integerBetween(profile.travelRadiusMiles, 1, 50),
      'VALIDATION', 'Choose a neighborhood and a travel radius from 1 to 50 miles.')
    requireRule(profile.sports.length > 0 && new Set(profile.sports.map(item => item.sport)).size === profile.sports.length &&
      profile.sports.every(item => Object.hasOwn(skills, item.skill)),
      'VALIDATION', 'Choose at least one sport with a skill level. Select each sport once.')
    return updateData(data => {
      requireRule(profile.sports.every(item => data.catalog.some(sport => sport.slug === item.sport)), 'VALIDATION', 'Choose a sport from the catalog.')
      const preferences = input.notificationPreferences ?? profileFor(data, id)?.notificationPreferences ?? defaultPreferences
      requireRule(typeof preferences.replacementAlerts === 'boolean' && typeof preferences.newGameAlerts === 'boolean', 'VALIDATION')
      profile.notificationPreferences = { ...preferences }
      profile.sports = profile.sports.map(item => {
        const record = data.skillRecords.find(row => row.playerId === id && row.sport === item.sport)
        if (record?.verified) {
          requireRule(!preferenceFor(profileFor(data, id), item.sport) || record.level === item.skill, 'LEVEL_LOCKED')
          return { sport: item.sport, skill: record.level, levelSource: 'verified', ratingCount: record.ratingCount }
        }
        if (record) {
          record.starting = item.skill
          record.level = item.skill
        } else {
          data.skillRecords.push({ playerId: id, sport: item.sport, starting: item.skill, level: item.skill, verified: false, ratingCount: 0 })
        }
        return { sport: item.sport, skill: item.skill, levelSource: 'self', ratingCount: record?.ratingCount ?? 0 }
      })
      data.profiles = [...data.profiles.filter(existing => existing.id !== id), profile]
      return profile
    })
  },

  async findPlayers(filters) {
    const id = requireUser()
    const data = read()
    const { sport, neighborhood, skill, gameId, match } = filters
    const name = filters.name?.trim().toLowerCase()
    requireRule((!sport || data.catalog.some(item => item.slug === sport)) && (!neighborhood || Object.hasOwn(neighborhoods, neighborhood)) &&
      (!skill || Object.hasOwn(skills, skill)) && (match !== 'travel' || (sport && neighborhood)), 'VALIDATION')

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
      if (profile.id === id || unavailable.has(profile.id) || (name && !profile.displayName.toLowerCase().includes(name))) continue
      if ((sport || skill) && !profile.sports.some(item => (!sport || item.sport === sport) && (!skill || item.skill === skill))) continue
      const distance = match === 'travel' ? neighborhoodDistance(profile.neighborhood, filters.neighborhood) : undefined
      if (distance !== undefined ? distance > profile.travelRadiusMiles : neighborhood && profile.neighborhood !== neighborhood) continue
      matches.push({
        ...profile,
        ...ratingFor(data, profile.id),
        ...statsFor(data, profile.id),
        distanceMiles: distance === undefined ? undefined : Math.round(distance * 10) / 10,
      })
    }

    return matches.sort((a, b) => {
      const byName = a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id)
      if (match !== 'travel') return byName
      return (a.distanceMiles ?? 0) - (b.distanceMiles ?? 0) || (b.avgRating ?? 0) - (a.avgRating ?? 0) || byName
    })
  },

  async createGame(input) {
    const organizerId = requireUser()
    const game: Game = {
      ...input, title: input.title.trim(), venue: input.venue.trim(),
      teamSize: input.teamSize ?? null, joinMode: input.joinMode ?? 'invite_only',
      skillLevel: input.skillLevel ?? null, description: input.description?.trim() ?? '',
      id: crypto.randomUUID(), organizerId, status: 'scheduled',
    }
    requireRule(Object.hasOwn(neighborhoods, game.neighborhood) && game.description.length <= 500 &&
      (game.joinMode === 'open' || game.joinMode === 'invite_only') && (!game.skillLevel || Object.hasOwn(skills, game.skillLevel)) &&
      game.title.length > 0 && game.title.length <= 80 && game.venue.length > 0 && game.venue.length <= 100 &&
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(game.startsAt) && isUpcoming(game),
      'VALIDATION', 'Choose a sport, name, venue, neighborhood, and future start time.')
    requireRule(integerBetween(game.maxPlayers, 2, 50), 'VALIDATION', 'Set capacity between 2 and 50 players.')
    requireRule(game.teamSize === null || (integerBetween(game.teamSize, 1, 25) && game.maxPlayers === game.teamSize * 2),
      'VALIDATION', 'Maximum players must be twice the team size.')
    return updateData(data => {
      requireRule(data.profiles.some(profile => profile.id === organizerId), 'PROFILE_REQUIRED')
      requireRule(data.catalog.some(sport => sport.slug === game.sport), 'VALIDATION', 'Choose a sport from the catalog.')
      data.games.push(game)
      data.roster.push({ gameId: game.id, playerId: organizerId, team: null, joinedAt: now() })
      notifyNewGame(data, game)
      return game.id
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
        .map(row => ({ ...row, playerName: displayName(data, row.playerId) })) : [],
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
      if (response === 'accepted') addToRoster(data, game, recipientId, invite.team)
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
        if (previous?.status === 'final') recalculateLevel(data, row.playerId, game.sport)
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
        recalculateLevel(data, row.playerId, game.sport)
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
      recalculateLevel(data, revieweeId, sport)
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
