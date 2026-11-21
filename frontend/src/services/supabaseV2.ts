
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient, User } from '@supabase/supabase-js'
import type { GameInput, Neighborhood, Profile, ProfileInput, Response, Session, Skill, Team } from '../types/domain'
import { errorMessages, PickupError } from './errors'

type V2ProfileInput = Omit<ProfileInput, 'notificationPreferences'>
type V2GameInput = Omit<GameInput, 'teamSize' | 'joinMode' | 'skillLevel' | 'description'>
type V2Performance = { playerId: string; goals?: number; assists?: number; points?: number }
type V2SearchRow = {
  id: string; display_name: string; neighborhood: Neighborhood; travel_radius_miles: number; bio: string
  skill_level: Skill; distance_miles: number; avg_rating: number | null; review_count: number
}

function check(error: { message: string } | null) {
  if (!error) return
  const code = error.message as keyof typeof errorMessages
  if (Object.hasOwn(errorMessages, code)) throw new PickupError(code)
  throw new Error(error.message)
}

function sessionFor(user: User | undefined): Session {
  if (!user?.email) throw new Error('No email session is available. Check the Auth email-confirmation setting.')
  return { userId: user.id, email: user.email }
}

export function createSupabaseV2Adapter(url: string, publishableKey: string) {
  if (!publishableKey.startsWith('sb_publishable_')) throw new Error('Use a Supabase publishable key.')
  return supabaseV2Adapter(createClient(url, publishableKey))
}

/** Approved v2 boundary. The community application still selects the v3/v4 mock. */
export function supabaseV2Adapter(client: SupabaseClient) {
  const changes = new EventTarget()
  async function rpc<T>(name: string, args: Record<string, unknown>, write = true): Promise<T> {
    const { data, error } = await client.rpc(name, args)
    check(error)
    if (write) changes.dispatchEvent(new Event('change'))
    return data as T
  }
  async function getProfile(id: string): Promise<Profile | null> {
    const { data, error } = await client.from('profiles')
      .select('id,display_name,neighborhood,travel_radius_miles,bio,user_sports(sport_slug,skill_level)').eq('id', id).maybeSingle()
    check(error)
    if (!data) return null
    return { id: data.id, displayName: data.display_name, neighborhood: data.neighborhood,
      travelRadiusMiles: data.travel_radius_miles, bio: data.bio,
      sports: data.user_sports.map(row => ({ sport: row.sport_slug, skill: row.skill_level })),
    }
  }
  return {
    async getSession() {
      const { data, error } = await client.auth.getSession()
      check(error)
      return data.session ? sessionFor(data.session.user) : null
    },
    async signUp(email: string, password: string) {
      const { data, error } = await client.auth.signUp({ email, password })
      check(error)
      return sessionFor(data.session?.user)
    },
    async signIn(email: string, password: string) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      check(error)
      return sessionFor(data.session?.user)
    },
    async signOut() { check((await client.auth.signOut({ scope: 'local' })).error) },
    subscribe(listener: () => void) {
      let active = true
      const { data } = client.auth.onAuthStateChange(() => setTimeout(() => { if (active) listener() }, 0))
      changes.addEventListener('change', listener)
      return () => {
        active = false
        data.subscription.unsubscribe()
        changes.removeEventListener('change', listener)
      }
    },
    getProfile,
    async saveProfile(input: V2ProfileInput) {
      const id = await rpc<string>('save_profile', {
        p_display_name: input.displayName, p_neighborhood: input.neighborhood, p_travel_radius_miles: input.travelRadiusMiles,
        p_bio: input.bio, p_sports: input.sports.map(row => ({ sport_slug: row.sport, skill_level: row.skill })),
      })
      const profile = await getProfile(id)
      if (!profile) throw new Error('The saved profile could not be read.')
      return profile
    },
    searchPlayers(sport: string, neighborhood: Neighborhood, skill?: Skill, gameId?: string) {
      return rpc<V2SearchRow[]>('search_players', { p_sport_slug: sport, p_neighborhood: neighborhood,
        p_skill_level: skill ?? null, p_game_id: gameId ?? null }, false)
    },
    createGame: (input: V2GameInput) => rpc<string>('create_game', {
      p_title: input.title, p_sport_slug: input.sport, p_venue: input.venue, p_neighborhood: input.neighborhood,
      p_starts_at: input.startsAt, p_max_players: input.maxPlayers,
    }),
    invite: (gameId: string, recipientId: string) =>
      rpc<string>('send_invitation', { p_game_id: gameId, p_recipient_id: recipientId }),
    respond: (invitationId: string, response: Response) =>
      rpc<Response>('respond_to_invitation', { p_invitation_id: invitationId, p_response: response }),
    cancelInvitation: (invitationId: string) => rpc<'cancelled'>('cancel_invitation', { p_invitation_id: invitationId }),
    cancelGame: (gameId: string) => rpc<'cancelled'>('cancel_game', { p_game_id: gameId }),
    setTeam: (gameId: string, playerId: string, team: Team | null) =>
      rpc<Team | null>('set_team', { p_game_id: gameId, p_player_id: playerId, p_team: team }),
    autoAssignTeams: (gameId: string) => rpc<{ player_id: string; team: Team }[]>('auto_assign_teams', { p_game_id: gameId }),
    submitResults: (gameId: string, scoreA: number, scoreB: number, performances: V2Performance[]) =>
      rpc<'pending'>('submit_results', { p_game_id: gameId, p_team_a_score: scoreA, p_team_b_score: scoreB,
        p_performances: performances.map(({ playerId, goals, assists, points }) => ({ player_id: playerId, goals, assists, points })) }),
    confirmResults: (gameId: string) => rpc<'final'>('confirm_results', { p_game_id: gameId }),
    disputeResults: (gameId: string, reason: string) =>
      rpc<'disputed'>('dispute_results', { p_game_id: gameId, p_reason: reason }),
  }
}
