
import { defaultPreferences } from '../types/domain'
import type { PickupService } from './contract'
import type { DemoContext } from './demoParticipation'
import { displayName } from './demoQueries'
import type { DemoData } from './demoQueries'
import { emit, inviteGroup, now, preferenceFor, profileFor, rosterFor, validateInvite } from './demoRules'
import { requireRule } from './errors'

type Methods = Pick<PickupService, 'listSports' | 'createSport' | 'notifications' | 'markNotificationsRead' |
  'getNotificationPreferences' | 'setNotificationPreferences' |
  'subscribeToNotifications' | 'mySquads' | 'createSquad' | 'joinSquad' |
  'leaveSquad' | 'removeSquadMember' | 'deleteSquad' | 'inviteSquad'>

function requireProfile(data: DemoData, id: string) {
  const profile = profileFor(data, id)
  requireRule(profile, 'PROFILE_REQUIRED')
  return profile
}

export function demoCommunity({ read, updateData, requireUser, subscribe }: DemoContext): Methods {
  return {
    async listSports() { return read().catalog.sort((a, b) => a.name.localeCompare(b.name)) },

    async createSport(input) {
      requireUser()
      const name = input.normalize('NFKC').trim().replace(/\s+/g, ' ')
      requireRule(name.length >= 2 && name.length <= 40 &&
        /^[\p{L}\p{N}][\p{L}\p{M}\p{N} '&’×/-]*$/u.test(name), 'VALIDATION',
        'Use 2–40 characters with letters, numbers, spaces, or common sport-name punctuation.')
      const normalized = name.toLowerCase()
      return updateData(data => {
        const existing = data.catalog.find(sport => sport.name.toLowerCase() === normalized)
        if (existing) return existing
        const base = normalized.normalize('NFKD').replace(/\p{M}/gu, '')
          .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
        let slug = base
        let suffix = 2
        while (data.catalog.some(sport => sport.slug === slug)) slug = base + '-' + suffix++
        const definition = { slug, name, fields: [] }
        data.catalog.push(definition)
        return definition
      })
    },

    async notifications() {
      const caller = requireUser()
      return read().notices.filter(row => row.userId === caller).reverse().map(({ userId: _, ...notice }) => notice)
    },

    async markNotificationsRead(ids) {
      const caller = requireUser()
      return updateData(data => {
        let count = 0
        const selected = ids ? new Set(ids) : null
        const at = now()
        for (const notice of data.notices) {
          if (notice.userId === caller && !notice.readAt && (!selected || selected.has(notice.id))) {
            notice.readAt = at
            count++
          }
        }
        return count
      })
    },

    async getNotificationPreferences() {
      return requireProfile(read(), requireUser()).notificationPreferences ?? { ...defaultPreferences }
    },

    async setNotificationPreferences(preferences) {
      const caller = requireUser()
      requireRule(typeof preferences.replacementAlerts === 'boolean' && typeof preferences.newGameAlerts === 'boolean', 'VALIDATION')
      await updateData(data => { requireProfile(data, caller).notificationPreferences = { ...preferences } })
    },

    subscribeToNotifications(listener) { return subscribe(listener) },

    async mySquads() {
      const caller = requireUser()
      const data = read()
      return data.squads.filter(row => row.memberIds.includes(caller)).map(({ memberIds, ...squad }) => ({
        ...squad, members: memberIds.map(id => ({ id, displayName: displayName(data, id) })),
      }))
    },

    async createSquad(input, sport) {
      const caller = requireUser()
      const name = input.trim()
      requireRule(name.length >= 1 && name.length <= 40, 'VALIDATION', 'Enter a squad name of 1–40 characters.')
      return updateData(data => {
        requireRule(preferenceFor(requireProfile(data, caller), sport), 'VALIDATION', 'Add this sport to your profile before creating a squad.')
        let joinCode = crypto.randomUUID().slice(0, 8).toUpperCase()
        while (data.squads.some(row => row.joinCode === joinCode)) joinCode = crypto.randomUUID().slice(0, 8).toUpperCase()
        const id = crypto.randomUUID()
        data.squads.push({ id, captainId: caller, sport, name, joinCode, memberIds: [caller] })
        return id
      })
    },

    async joinSquad(code) {
      const caller = requireUser()
      return updateData(data => {
        const squad = data.squads.find(row => row.joinCode === code.trim().toUpperCase())
        requireRule(squad, 'FORBIDDEN', 'No squad matches that join code.')
        if (squad.memberIds.includes(caller)) return squad.id
        requireRule(preferenceFor(requireProfile(data, caller), squad.sport), 'VALIDATION', 'Add this squad’s sport to your profile before joining.')
        requireRule(squad.memberIds.length < 25, 'VALIDATION', 'This squad already has 25 members.')
        squad.memberIds.push(caller)
        emit(data, squad.captainId, 'squad_member_joined', 'New squad member', displayName(data, caller) + ' joined ' + squad.name, { squadId: squad.id })
        return squad.id
      })
    },

    async leaveSquad(squadId) {
      const caller = requireUser()
      return updateData(data => {
        const squad = data.squads.find(row => row.id === squadId && row.memberIds.includes(caller))
        requireRule(squad && squad.captainId !== caller, 'FORBIDDEN', 'A captain can delete their squad.')
        squad.memberIds = squad.memberIds.filter(id => id !== caller)
        return 'left'
      })
    },

    async removeSquadMember(squadId, playerId) {
      const caller = requireUser()
      return updateData(data => {
        const squad = data.squads.find(row => row.id === squadId && row.captainId === caller)
        requireRule(squad && caller !== playerId, 'FORBIDDEN')
        requireRule(squad.memberIds.includes(playerId), 'VALIDATION')
        squad.memberIds = squad.memberIds.filter(id => id !== playerId)
        return 'removed'
      })
    },

    async deleteSquad(squadId) {
      const caller = requireUser()
      return updateData(data => {
        const squad = data.squads.find(row => row.id === squadId && row.captainId === caller)
        requireRule(squad, 'FORBIDDEN')
        data.squads = data.squads.filter(row => row !== squad)
        return 'deleted'
      })
    },

    async inviteSquad(gameId, squadId, team = null) {
      const caller = requireUser()
      return updateData(data => {
        const game = validateInvite(data, gameId, caller, team)
        const squad = data.squads.find(row => row.id === squadId && row.sport === game.sport)
        requireRule(squad, 'VALIDATION', 'Choose a squad for this game’s sport.')
        const roster = rosterFor(data, gameId)
        const candidates = squad.memberIds.filter(id => id !== caller && !roster.some(row => row.playerId === id))
        return inviteGroup(data, game, candidates, team, squad)
      })
    },
  }
}
