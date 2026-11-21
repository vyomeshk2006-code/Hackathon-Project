
import { normalizePhone, normalizeUsername } from '../lib/account'
import { defaultPreferences, isActiveGame, neighborhoodLabel, skills } from '../types/domain'
import type { Profile } from '../types/domain'
import type { PickupService } from './contract'
import type { DemoContext } from './demoParticipation'
import { contactFor, profileFor, rosterFor } from './demoRules'
import { requireRule } from './errors'

type Methods = Pick<PickupService, 'saveProfile' | 'getAccountDetails' | 'usernameAvailable' | 'getGameContacts'>

export function demoAccount({ read, updateData, requireUser }: DemoContext): Methods {
  return {
    async getAccountDetails() {
      return { phoneNumber: contactFor(read(), requireUser()) ?? null }
    },

    async usernameAvailable(value) {
      const caller = requireUser()
      const username = normalizeUsername(value)
      requireRule(username, 'VALIDATION', 'Use 3–20 letters, digits, or underscores for your username.')
      return !read().profiles.some(profile => profile.id !== caller && profile.username === username)
    },

    async saveProfile(input) {
      const id = requireUser()
      const displayName = input.displayName.trim()
      const bio = input.bio.trim()
      const neighborhood = neighborhoodLabel(input.neighborhood.trim().replace(/\s+/g, ' '))
      requireRule(displayName.length > 0 && displayName.length <= 60 && bio.length <= 300,
        'VALIDATION', 'Enter a full name of 1–60 characters and a bio of up to 300 characters.')
      requireRule(neighborhood.length >= 2 && neighborhood.length <= 60,
        'VALIDATION', 'Enter a neighborhood or area of 2–60 characters.')
      const requestedName = input.username === undefined ? undefined : normalizeUsername(input.username)
      const requestedPhone = input.phoneNumber === undefined ? undefined : normalizePhone(input.phoneNumber)
      requireRule(requestedName !== null, 'VALIDATION', 'Use 3–20 letters, digits, or underscores for your username.')
      requireRule(requestedPhone !== null, 'VALIDATION', 'Enter an international phone number starting with + and a country code.')
      requireRule(input.sports.length > 0 && new Set(input.sports.map(item => item.sport)).size === input.sports.length &&
        input.sports.every(item => Object.hasOwn(skills, item.skill)), 'VALIDATION', 'Choose each sport once and select a skill level.')
      return updateData(data => {
        const prior = profileFor(data, id)
        const username = requestedName ?? prior?.username
        const phoneNumber = requestedPhone ?? contactFor(data, id)
        requireRule(username, 'VALIDATION', 'Choose a username to finish account setup.')
        requireRule(!prior?.username || prior.username === username, 'VALIDATION', 'Usernames are locked after setup.')
        requireRule(!data.profiles.some(profile => profile.id !== id && profile.username === username), 'USERNAME_TAKEN')
        requireRule(phoneNumber, 'CONTACT_REQUIRED')
        requireRule(input.sports.every(item => data.catalog.some(sport => sport.slug === item.sport)),
          'VALIDATION', 'Choose a sport from the catalog.')
        const preferences = input.notificationPreferences ?? prior?.notificationPreferences ?? defaultPreferences
        requireRule(typeof preferences.replacementAlerts === 'boolean' && typeof preferences.newGameAlerts === 'boolean', 'VALIDATION')
        const profile: Profile = {
          id, displayName, username, neighborhood, bio, notificationPreferences: { ...preferences },
          sports: input.sports.map(({ sport, skill }) => ({ sport, skill })),
        }
        data.profiles = [...data.profiles.filter(existing => existing.id !== id), profile]
        data.contacts = [...data.contacts.filter(row => row.playerId !== id), { playerId: id, phoneNumber }]
        return profile
      })
    },

    async getGameContacts(gameId) {
      const caller = requireUser()
      const data = read()
      const game = data.games.find(row => row.id === gameId)
      const roster = rosterFor(data, gameId)
      requireRule(game && (game.organizerId === caller || roster.some(row => row.playerId === caller)), 'FORBIDDEN')
      requireRule(isActiveGame(game), 'GAME_UNAVAILABLE', 'Game contacts are closed.')
      const ids = new Set([game.organizerId, ...roster.map(row => row.playerId)])
      ids.delete(caller)
      return [...ids].flatMap(playerId => {
        const phoneNumber = contactFor(data, playerId)
        const profile = profileFor(data, playerId)
        return phoneNumber && profile ? [{ playerId, name: profile.displayName, phoneNumber }] : []
      })
    },
  }
}
