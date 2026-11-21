import { tampaInput } from '../lib/time'
import { isUpcoming, neighborhoods, skills, sports, sportStatFields } from '../types/domain'
import type {
  DirectoryPlayer, Game, Invitation, PlayerGameStat, Profile, Team,
} from '../types/domain'
import type { PickupService } from './contract'
import { displayName, neighborhoodDistance, ratingFor, statsFor, summary } from './demoQueries'
import type { DemoData } from './demoQueries'
import { requireRule } from './errors'

const dataKey = 'pickup-tampa.demo.v1'
const sessionKey = 'pickup-tampa.session.v1'
const changes = new EventTarget()

export const demoAccounts = [
  { id: '10000000-0000-4000-8000-000000000001', label: 'Jordan · Organizer', email: 'jordan@example.test' },
  { id: '10000000-0000-4000-8000-000000000002', label: 'Maya · Player', email: 'maya@example.test' },
] as const

const initialData: DemoData = {
  accounts: [],
  games: [],
  roster: [],
  invitations: [],
  results: [],
  performances: [],
  reviews: [],
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
      sports: [{ sport: 'pickleball', skill: 'intermediate' }],
    },
    {
      id: '10000000-0000-4000-8000-000000000005', displayName: 'Cam Brooks', neighborhood: 'west-tampa',
      travelRadiusMiles: 18, bio: 'Always looking for a regular volleyball group.',
      sports: [{ sport: 'volleyball', skill: 'advanced' }, { sport: 'basketball', skill: 'intermediate' }],
    },
  ],
}

function read(): DemoData {
  const stored = localStorage.getItem(dataKey)
  if (!stored) return structuredClone(initialData)
  const data = JSON.parse(stored) as DemoData
  // Keep the original storage key and fill fields missing from v1 saves.
  return {
    ...data,
    games: data.games.map(game => ({
      ...game,
      neighborhood: game.neighborhood ?? data.profiles.find(profile => profile.id === game.organizerId)?.neighborhood ?? 'other-tampa',
    })),
    roster: data.roster.map(entry => ({
      ...entry,
      team: entry.team ?? null,
      joinedAt: entry.joinedAt ?? data.games.find(game => game.id === entry.gameId)?.startsAt ?? new Date(0).toISOString(),
    })),
    invitations: data.invitations.map(invite => ({ ...invite, respondedAt: invite.respondedAt ?? null })),
    results: data.results ?? [],
    performances: data.performances ?? [],
    reviews: data.reviews ?? [],
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

export const demoService: PickupService = {
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
    const reviews = data.reviews.filter(review => review.revieweeId === id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(review => ({ ...review, reviewerName: displayName(data, review.reviewerId) }))
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
      profile.sports.every(item => Object.hasOwn(sports, item.sport) && Object.hasOwn(skills, item.skill)),
      'VALIDATION', 'Choose at least one sport with a skill level. Select each sport once.')
    return updateData(data => {
      data.profiles = [...data.profiles.filter(existing => existing.id !== id), profile]
      return profile
    })
  },

  async findPlayers(filters) {
    const id = requireUser()
    const data = read()
    const { sport, neighborhood, skill, gameId, match } = filters
    requireRule((!sport || Object.hasOwn(sports, sport)) && (!neighborhood || Object.hasOwn(neighborhoods, neighborhood)) &&
      (!skill || Object.hasOwn(skills, skill)) && (match !== 'travel' || (sport && neighborhood)), 'VALIDATION')

    if (gameId) organizedGame(data, gameId, id)
    const unavailable = new Set<string>()
    if (gameId) {
      for (const entry of data.roster) if (entry.gameId === gameId) unavailable.add(entry.playerId)
      for (const invite of data.invitations) {
        if (invite.gameId === gameId && invite.status === 'pending') unavailable.add(invite.recipientId)
      }
    }

    const matches: DirectoryPlayer[] = []
    for (const profile of data.profiles) {
      if (profile.id === id || unavailable.has(profile.id)) continue
      if ((sport || skill) && !profile.sports.some(item => (!sport || item.sport === sport) && (!skill || item.skill === skill))) continue
      const distance = match === 'travel' ? neighborhoodDistance(profile.neighborhood, filters.neighborhood) : undefined
      if (distance !== undefined ? distance > profile.travelRadiusMiles : neighborhood && profile.neighborhood !== neighborhood) continue
      matches.push({
        ...profile,
        ...ratingFor(data, profile.id),
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
      id: crypto.randomUUID(), organizerId, status: 'scheduled',
    }
    requireRule(Object.hasOwn(sports, game.sport) && Object.hasOwn(neighborhoods, game.neighborhood) &&
      game.title.length > 0 && game.title.length <= 80 && game.venue.length > 0 && game.venue.length <= 100 &&
      /(?:Z|[+-]\d{2}:\d{2})$/i.test(game.startsAt) && isUpcoming(game),
      'VALIDATION', 'Choose a sport, name, venue, neighborhood, and future start time.')
    requireRule(integerBetween(game.maxPlayers, 2, 50), 'VALIDATION', 'Set capacity between 2 and 50 players.')
    return updateData(data => {
      requireRule(data.profiles.some(profile => profile.id === organizerId), 'PROFILE_REQUIRED')
      data.games.push(game)
      data.roster.push({ gameId: game.id, playerId: organizerId, team: null, joinedAt: now() })
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
    if (!organizer && !onRoster &&
      !data.invitations.some(invite => invite.gameId === id && invite.recipientId === userId && invite.status === 'pending')) return null

    return {
      ...summary(data, game, onRoster),
      roster: entries.map(entry => ({
        id: entry.playerId, displayName: displayName(data, entry.playerId), team: entry.team,
      })),
      performances: onRoster ? data.performances.filter(row => row.gameId === id) : [],
      sentInvitations: organizer ? data.invitations.filter(invite => invite.gameId === id).reverse()
        .map(invite => ({ ...invite, recipientName: displayName(data, invite.recipientId) })) : [],
      reviewedPlayerIds: onRoster ? data.reviews.filter(review => review.gameId === id && review.reviewerId === userId)
        .map(review => review.revieweeId) : [],
    }
  },

  async invite(gameId, recipientId) {
    const senderId = requireUser()
    return updateData(data => {
      const game = organizedGame(data, gameId, senderId)
      requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
      const latest = data.invitations.filter(invite => invite.gameId === gameId && invite.recipientId === recipientId).at(-1)
      if (latest?.status === 'pending') return latest.id
      requireRule(latest?.status !== 'declined', 'INVITATION_CLOSED', 'This player declined an invitation for this game.')
      requireRule(data.profiles.some(profile => profile.id === recipientId && profile.sports.some(item => item.sport === game.sport)),
        'VALIDATION', 'Choose a player who plays this sport.')
      requireRule(!data.roster.some(entry => entry.gameId === gameId && entry.playerId === recipientId),
        'VALIDATION', 'This player is already on the roster.')
      requireRule(summary(data, game).confirmed < game.maxPlayers, 'GAME_FULL')
      const id = crypto.randomUUID()
      data.invitations.push({ id, gameId, senderId, recipientId, status: 'pending', createdAt: now(), respondedAt: null })
      return id
    })
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
      if (response === 'accepted' && !data.roster.some(entry => entry.gameId === game.id && entry.playerId === recipientId)) {
        requireRule(summary(data, game).confirmed < game.maxPlayers, 'GAME_FULL')
        data.roster.push({ gameId: game.id, playerId: recipientId, team: null, joinedAt: now() })
      }
      closeInvitation(invite, response)
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
      return 'cancelled'
    })
  },

  async cancelGame(gameId) {
    const caller = requireUser()
    return updateData(data => {
      const game = organizedGame(data, gameId, caller)
      requireRule(game.status === 'scheduled', 'GAME_UNAVAILABLE')
      game.status = 'cancelled'
      closePending(data, game.id, 'cancelled')
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
      return ranked.map(({ entry }, index) => {
        const team = snakeOrder[index % snakeOrder.length]
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
      const fields = sportStatFields[game.sport]
      requireRule(performances.size === input.performances.length && input.performances.every(row =>
        roster.some(entry => entry.playerId === row.playerId) &&
        [row.goals, row.points, row.assists].every(value => value === undefined || integerBetween(value, 0, 32767))),
        'VALIDATION', 'Enter whole-number statistics for roster players only.')

      const rows: PlayerGameStat[] = roster.map(entry => {
        const team = entry.team as Team
        const margin = (input.teamAScore - input.teamBScore) * (team === 'A' ? 1 : -1)
        const source = performances.get(entry.playerId)
        return {
          gameId, playerId: entry.playerId, team, outcome: margin === 0 ? 'draw' : margin > 0 ? 'win' : 'loss',
          goals: fields.includes('goals') ? source?.goals ?? 0 : 0,
          assists: fields.includes('assists') ? source?.assists ?? 0 : 0,
          points: fields.includes('points') ? source?.points ?? 0 : 0,
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
      return 'disputed'
    })
  },

  async submitReview(gameId, input) {
    const reviewerId = requireUser()
    const comment = input.comment.trim()
    const { revieweeId, rating } = input
    requireRule(integerBetween(rating, 1, 5) && comment.length <= 500, 'VALIDATION')
    return updateData(data => {
      const players = new Set(data.roster.filter(entry => entry.gameId === gameId).map(entry => entry.playerId))
      requireRule(reviewerId !== revieweeId && players.has(reviewerId) && players.has(revieweeId) &&
        data.results.some(result => result.gameId === gameId && result.status === 'final'), 'NOT_ELIGIBLE')
      requireRule(!data.reviews.some(review => review.gameId === gameId &&
        review.reviewerId === reviewerId && review.revieweeId === revieweeId), 'ALREADY_REVIEWED')
      const id = crypto.randomUUID()
      data.reviews.push({ id, gameId, reviewerId, revieweeId, rating, comment, createdAt: now() })
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
