
import { tampaInput } from '../lib/time'
import { isUpcoming } from '../types/domain'
import type { PickupService } from './contract'
import { displayName, neighborhoodDistance, summary } from './demoQueries'
import type { DemoData } from './demoQueries'
import {
  addToRoster, emit, matchesLevel, nearby, now, organize, participation, profileFor, selfServiceIssue,
  replacementEnabled, rosterFor, teamHasRoom, validateInvite, inviteGroup, inviteOne,
} from './demoRules'
import { requireRule } from './errors'

export type DemoContext = {
  read: () => DemoData
  updateData: <T>(mutate: (data: DemoData) => T) => Promise<T>
  requireUser: () => string
  subscribe: PickupService['subscribe']
}

type Methods = Pick<PickupService, 'browseGames' | 'joinGame' | 'requestToJoin' | 'cancelJoinRequest' |
  'respondToJoinRequest' | 'withdraw' | 'claimReplacement' | 'invite' | 'inviteMany'>

export function demoParticipation({ read, updateData, requireUser }: DemoContext): Methods {
  return {
    async browseGames(filters = {}) {
      const id = requireUser()
      const data = read()
      const profile = profileFor(data, id)
      return data.games.filter(game => {
        if (!isUpcoming(game)) return false
        const date = tampaInput(new Date(game.startsAt)).slice(0, 10)
        return (!filters.sport || game.sport === filters.sport) &&
          (!filters.neighborhood || game.neighborhood === filters.neighborhood) &&
          (!filters.from || date >= filters.from) && (!filters.to || date <= filters.to) &&
          (!filters.openSpots || rosterFor(data, game.id).length < game.maxPlayers)
      }).map(game => ({
        ...summary(data, game), ...participation(data, game, id),
        organizerName: displayName(data, game.organizerId),
        distanceMiles: profile ? Math.round(neighborhoodDistance(profile.neighborhood, game.neighborhood) * 10) / 10 : null,
      })).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    },

    async joinGame(gameId) {
      const id = requireUser()
      return updateData(data => {
        const game = data.games.find(row => row.id === gameId && row.joinMode === 'open')
        requireRule(game, 'FORBIDDEN')
        if (rosterFor(data, gameId).some(row => row.playerId === id)) return 'joined'
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        const issue = selfServiceIssue(profileFor(data, id), game)
        requireRule(!issue, 'NOT_ELIGIBLE', issue)
        addToRoster(data, game, id, null)
        emit(data, game.organizerId, 'player_joined', 'Player joined', displayName(data, id) + ' joined ' + game.title, { gameId })
        return 'joined'
      })
    },

    async requestToJoin(gameId) {
      const id = requireUser()
      return updateData(data => {
        const game = data.games.find(row => row.id === gameId && row.joinMode === 'invite_only')
        requireRule(game, 'FORBIDDEN')
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        const issue = selfServiceIssue(profileFor(data, id), game)
        requireRule(!issue, 'NOT_ELIGIBLE', issue)
        const roster = rosterFor(data, gameId)
        requireRule(!roster.some(row => row.playerId === id), 'VALIDATION', 'You are already on the roster.')
        const pending = data.requests.find(row => row.gameId === gameId && row.playerId === id && row.status === 'pending')
        if (pending) return pending.id
        requireRule(roster.length < game.maxPlayers, 'GAME_FULL')
        const requestId = crypto.randomUUID()
        data.requests.push({ id: requestId, gameId, playerId: id, status: 'pending', createdAt: now(), respondedAt: null })
        emit(data, game.organizerId, 'join_request_received', 'Join request', displayName(data, id) + ' requested to join ' + game.title, { gameId, requestId })
        return requestId
      })
    },

    async cancelJoinRequest(requestId) {
      const id = requireUser()
      return updateData(data => {
        const request = data.requests.find(row => row.id === requestId && row.playerId === id)
        requireRule(request, 'FORBIDDEN')
        requireRule(request.status === 'pending', 'VALIDATION', 'This request has already been handled.')
        request.status = 'cancelled'
        request.respondedAt = now()
        return 'cancelled'
      })
    },

    async respondToJoinRequest(requestId, decision, team = null) {
      const id = requireUser()
      requireRule((decision === 'approved' || decision === 'declined') && (team === null || team === 'A' || team === 'B'), 'VALIDATION')
      return updateData(data => {
        const request = data.requests.find(row => row.id === requestId)
        requireRule(request, 'FORBIDDEN')
        const game = organize(data, request.gameId, id)
        if (request.status === decision) return decision
        requireRule(request.status === 'pending', 'VALIDATION', 'This request has already been handled.')
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        if (decision === 'approved') {
          const issue = selfServiceIssue(profileFor(data, request.playerId), game)
          requireRule(!issue, 'NOT_ELIGIBLE', 'The requester no longer meets the sport or skill requirement.')
          addToRoster(data, game, request.playerId, team)
        }
        request.status = decision
        request.respondedAt = now()
        emit(data, request.playerId, decision === 'approved' ? 'join_request_approved' : 'join_request_declined',
          decision === 'approved' ? 'Join request approved' : 'Join request declined', game.title, { gameId: game.id, requestId })
        return decision
      })
    },

    async withdraw(gameId) {
      const id = requireUser()
      return updateData(data => {
        const game = data.games.find(row => row.id === gameId)
        requireRule(game && game.organizerId !== id, 'FORBIDDEN', 'Only roster players can withdraw. Organizers can cancel the game.')
        const member = rosterFor(data, gameId).find(row => row.playerId === id)
        if (!member && data.withdrawals.some(row => row.gameId === gameId && row.playerId === id)) return 'withdrawn'
        requireRule(member, 'FORBIDDEN')
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        data.roster = data.roster.filter(row => row !== member)
        data.chatReads = data.chatReads.filter(row => row.gameId !== gameId || row.playerId !== id)
        const lastMinute = Date.parse(game.startsAt) - Date.now() <= 60 * 60_000
        const withdrawalId = crypto.randomUUID()
        data.withdrawals.push({ id: withdrawalId, gameId, playerId: id, team: member.team, at: now(), lastMinute })
        emit(data, game.organizerId, 'player_withdrew', 'Player withdrew', displayName(data, id) + ' left ' + game.title, { gameId })
        if (lastMinute) {
          const excluded = new Set([id, ...rosterFor(data, gameId).map(row => row.playerId),
            ...data.alerts.filter(row => row.gameId === gameId).map(row => row.playerId)])
          for (const profile of data.profiles) {
            if (excluded.has(profile.id) || !replacementEnabled(profile) || !matchesLevel(profile, game) || !nearby(profile, game)) continue
            data.alerts.push({ gameId, withdrawalId, playerId: profile.id, team: member.team })
            emit(data, profile.id, 'replacement_needed', 'A spot opened near you', game.title, { gameId })
          }
        }
        return 'withdrawn'
      })
    },

    async claimReplacement(gameId) {
      const id = requireUser()
      return updateData(data => {
        const alert = data.alerts.find(row => row.gameId === gameId && row.playerId === id)
        requireRule(alert, 'NOT_ELIGIBLE', 'Only players who received a replacement alert can claim this spot.')
        const game = data.games.find(row => row.id === gameId)
        requireRule(game, 'GAME_UNAVAILABLE')
        if (rosterFor(data, gameId).some(row => row.playerId === id)) return 'joined'
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        requireRule(matchesLevel(profileFor(data, id), game), 'NOT_ELIGIBLE', 'Your sport or skill level no longer matches this game.')
        requireRule(rosterFor(data, gameId).length < game.maxPlayers, 'GAME_FULL', 'Someone else claimed the last spot.')
        addToRoster(data, game, id, teamHasRoom(data, game, alert.team) ? alert.team : null)
        emit(data, game.organizerId, 'replacement_joined', 'Replacement spot claimed', displayName(data, id) + ' joined ' + game.title, { gameId })
        return 'joined'
      })
    },

    async invite(gameId, recipientId, team = null) {
      const caller = requireUser()
      return updateData(data => {
        const game = organize(data, gameId, caller)
        requireRule(isUpcoming(game), 'GAME_UNAVAILABLE')
        requireRule(team === null || team === 'A' || team === 'B', 'VALIDATION')
        const pending = data.invitations.find(row => row.gameId === gameId && row.recipientId === recipientId && row.status === 'pending')
        if (pending) return pending.id
        return inviteOne(data, validateInvite(data, gameId, caller, team), recipientId, team)
      })
    },

    async inviteMany(gameId, recipients, team = null) {
      const caller = requireUser()
      requireRule(recipients.length >= 1 && recipients.length <= 25, 'VALIDATION', 'Choose from 1 to 25 players.')
      return updateData(data => inviteGroup(data, validateInvite(data, gameId, caller, team), recipients, team))
    },
  }
}
