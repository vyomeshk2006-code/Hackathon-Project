
import { defaultPreferences, isActiveGame, isUpcoming, skills } from '../types/domain'
import type { Game, Notification, NotificationType, Participation, Profile, Sport, Team } from '../types/domain'
import { displayName } from './demoQueries'
import type { DemoData } from './demoQueries'
import { PickupError, requireRule } from './errors'

export const now = () => new Date().toISOString()
export const rosterFor = (data: DemoData, gameId: string) => data.roster.filter(row => row.gameId === gameId)
export const preferenceFor = (profile: Profile | undefined, sport: Sport) => profile?.sports.find(item => item.sport === sport)
export const profileFor = (data: DemoData, id: string) => data.profiles.find(profile => profile.id === id)
export const contactFor = (data: DemoData, id: string) => data.contacts.find(row => row.playerId === id)?.phoneNumber
export function requireContact(data: DemoData, id: string) {
  requireRule(contactFor(data, id), 'CONTACT_REQUIRED')
}

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
  return isActiveGame(game) || game.joinMode === 'open' || game.organizerId === id ||
    rosterFor(data, game.id).some(row => row.playerId === id) ||
    data.invitations.some(row => row.gameId === game.id && row.recipientId === id && row.status === 'pending') ||
    data.alerts.some(row => row.gameId === game.id && row.playerId === id) ||
    (game.skillLevel !== null && matchesLevel(profileFor(data, id), game))
}

export function participation(data: DemoData, game: Game, id: string): Participation {
  const roster = rosterFor(data, game.id)
  const isMember = roster.some(row => row.playerId === id)
  const available = isActiveGame(game) && isUpcoming(game) && roster.length < game.maxPlayers && !isMember
  const ineligibleReason = selfServiceIssue(profileFor(data, id), game) ??
    (contactFor(data, id) ? undefined : 'Add a contact phone number in Settings before joining.')
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
  requireContact(data, playerId)
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
  requireRule(isUpcoming(game) && isActiveGame(game), 'GAME_UNAVAILABLE')
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
      matchesLevel(profile, game)) {
      emit(data, profile.id, 'new_game_available', 'New game available', game.title, { gameId: game.id })
    }
  }
}

export function replacementEnabled(profile: Profile) {
  return (profile.notificationPreferences ?? defaultPreferences).replacementAlerts
}
