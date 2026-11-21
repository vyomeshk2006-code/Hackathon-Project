
import { defaultPreferences, isUpcoming, skills } from '../types/domain'
import type { Game, Notification, NotificationType, Participation, Profile, Skill, Sport, Team } from '../types/domain'
import { displayName, finalReviews, neighborhoodDistance } from './demoQueries'
import type { DemoData } from './demoQueries'
import { PickupError, requireRule } from './errors'

export const now = () => new Date().toISOString()
export const rosterFor = (data: DemoData, gameId: string) => data.roster.filter(row => row.gameId === gameId)
export const preferenceFor = (profile: Profile | undefined, sport: Sport) => profile?.sports.find(item => item.sport === sport)
export const profileFor = (data: DemoData, id: string) => data.profiles.find(profile => profile.id === id)
export const nearby = (profile: Profile, game: Game) => neighborhoodDistance(profile.neighborhood, game.neighborhood) <= profile.travelRadiusMiles

export function selfServiceIssue(profile: Profile | undefined, game: Game) {
  const preference = preferenceFor(profile, game.sport)
  if (!preference) return 'Add this sport to your profile to play in this game.'
  if (game.skillLevel && preference.skill !== game.skillLevel) {
    return 'This game requires the ' + skills[game.skillLevel] + ' skill level.'
  }
}

export function matchesLevel(profile: Profile | undefined, game: Game) {
  return !selfServiceIssue(profile, game)
}

export function canSeeGame(data: DemoData, game: Game, id: string) {
  return isUpcoming(game) || game.joinMode === 'open' || game.organizerId === id ||
    rosterFor(data, game.id).some(row => row.playerId === id) ||
    data.invitations.some(row => row.gameId === game.id && row.recipientId === id && row.status === 'pending') ||
    data.alerts.some(row => row.gameId === game.id && row.playerId === id) ||
    (game.skillLevel !== null && matchesLevel(profileFor(data, id), game))
}

export function participation(data: DemoData, game: Game, id: string): Participation {
  const roster = rosterFor(data, game.id)
  const isMember = roster.some(row => row.playerId === id)
  const available = isUpcoming(game) && roster.length < game.maxPlayers && !isMember
  const ineligibleReason = selfServiceIssue(profileFor(data, id), game)
  const eligible = available && !ineligibleReason
  const requestId = data.requests.find(row => row.gameId === game.id && row.playerId === id && row.status === 'pending')?.id
  return {
    isMember, requestId, ineligibleReason,
    invitationId: data.invitations.find(row => row.gameId === game.id && row.recipientId === id && row.status === 'pending')?.id,
    canJoin: eligible && game.joinMode === 'open',
    canRequest: eligible && game.joinMode === 'invite_only' && !requestId,
    canClaim: eligible && data.alerts.some(row => row.gameId === game.id && row.playerId === id),
  }
}

export function emit(data: DemoData, userId: string, type: NotificationType, title: string, body: string,
  links: Pick<Notification, 'gameId' | 'invitationId' | 'requestId' | 'squadId'> = {}) {
  data.notices.push({ id: crypto.randomUUID(), userId, type, title, body, ...links, readAt: null, createdAt: now() })
}

export function organize(data: DemoData, gameId: string, caller: string) {
  const game = data.games.find(item => item.id === gameId && item.organizerId === caller)
  requireRule(game, 'FORBIDDEN')
  return game
}

export function teamHasRoom(data: DemoData, game: Game, team: Team | null, except?: string) {
  return !team || game.teamSize === null || rosterFor(data, game.id)
    .filter(row => row.team === team && row.playerId !== except).length < game.teamSize
}

export function addToRoster(data: DemoData, game: Game, playerId: string, team: Team | null) {
  const roster = rosterFor(data, game.id)
  if (roster.some(row => row.playerId === playerId)) return
  requireRule(roster.length < game.maxPlayers, 'GAME_FULL')
  requireRule(teamHasRoom(data, game, team), 'TEAM_FULL')
  const at = now()
  data.roster.push({ gameId: game.id, playerId, team, joinedAt: at })
  for (const invite of data.invitations) {
    if (invite.gameId === game.id && invite.recipientId === playerId && invite.status === 'pending') {
      invite.status = 'accepted'
      invite.respondedAt = at
    }
  }
  for (const request of data.requests) {
    if (request.gameId === game.id && request.playerId === playerId && request.status === 'pending') {
      request.status = 'approved'
      request.respondedAt = at
    }
  }
}

export function validateInvite(data: DemoData, gameId: string, caller: string, team: Team | null) {
  const game = organize(data, gameId, caller)
  requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
  requireRule(team === null || team === 'A' || team === 'B', 'VALIDATION')
  requireRule(teamHasRoom(data, game, team), 'TEAM_FULL')
  return game
}

export function inviteOne(data: DemoData, game: Game, recipientId: string, team: Team | null, squad?: { id: string; name: string }) {
  const latest = data.invitations.filter(row => row.gameId === game.id && row.recipientId === recipientId).at(-1)
  if (latest?.status === 'pending') return latest.id
  requireRule(latest?.status !== 'declined', 'INVITATION_CLOSED', 'This player already declined.')
  requireRule(preferenceFor(profileFor(data, recipientId), game.sport) &&
    !rosterFor(data, game.id).some(row => row.playerId === recipientId), 'VALIDATION', 'Choose a player of the sport who is not on the roster.')
  requireRule(rosterFor(data, game.id).length < game.maxPlayers, 'GAME_FULL')
  const id = crypto.randomUUID()
  data.invitations.push({
    id, gameId: game.id, senderId: game.organizerId, recipientId, team, squadId: squad?.id,
    status: 'pending', createdAt: now(), respondedAt: null,
  })
  const body = squad ? game.title + ' · ' + squad.name : game.title
  emit(data, recipientId, 'invitation_received', 'Game invitation', body, { gameId: game.id, invitationId: id })
  return id
}

export function inviteGroup(data: DemoData, game: Game, recipients: string[], team: Team | null, squad?: { id: string; name: string }) {
  return [...new Set(recipients)].map(recipientId => {
    try { return { recipientId, invitationId: inviteOne(data, game, recipientId, team, squad) } }
    catch (error) {
      if (!(error instanceof PickupError)) throw error
      return { recipientId, error: error.code }
    }
  })
}

export function notifyNewGame(data: DemoData, game: Game) {
  for (const profile of data.profiles) {
    if (profile.id !== game.organizerId && profile.notificationPreferences?.newGameAlerts &&
      matchesLevel(profile, game) && nearby(profile, game)) {
      emit(data, profile.id, 'new_game_nearby', 'New game nearby', game.title, { gameId: game.id })
    }
  }
}

export function replacementEnabled(profile: Profile) {
  return (profile.notificationPreferences ?? defaultPreferences).replacementAlerts
}

const startingScore: Record<Skill, number> = { beginner: 1.5, intermediate: 3, advanced: 4.5 }

export function recalculateLevel(data: DemoData, playerId: string, sport: Sport) {
  const record = data.skillRecords.find(row => row.playerId === playerId && row.sport === sport)
  if (!record) return
  const latest = new Map(finalReviews(data, playerId).filter(review => review.sport === sport && review.skillRating !== null)
    .map(review => [review.reviewerId, review]))
  const ranked = [...latest.values()].sort((a, b) => a.skillRating! - b.skillRating!)
  const counted = ranked.length >= 5 ? ranked.slice(1, -1) : ranked
  record.ratingCount = counted.length
  if (counted.length >= 3 && new Set(counted.map(review => review.gameId)).size >= 2) {
    record.verified = true
    const score = (3 * startingScore[record.starting] + counted.reduce((total, review) => total + review.skillRating!, 0)) / (3 + counted.length)
    const previous = record.level
    if (score >= 3.92) record.level = 'advanced'
    else if (score <= 2.08) record.level = 'beginner'
    else if ((previous === 'beginner' && score >= 2.58) || (previous === 'advanced' && score <= 3.42)) {
      record.level = 'intermediate'
    }
    if (record.level !== previous) {
      emit(data, playerId, 'level_changed', 'Verified skill level changed',
        (data.catalog.find(item => item.slug === sport)?.name ?? sport) + ': ' + record.level + ' · ' + counted.length + ' player ratings')
    }
  }
  const preference = preferenceFor(profileFor(data, playerId), sport)
  if (preference) {
    preference.skill = record.level
    preference.levelSource = record.verified ? 'verified' : 'self'
    preference.ratingCount = record.ratingCount
  }
}
