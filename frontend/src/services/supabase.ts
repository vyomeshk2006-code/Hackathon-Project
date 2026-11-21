// Live Supabase implementation of PickupService (backend: supabase/migrations 001–010).
// Every rule is enforced in the database; this file only translates shapes.
import { createClient } from '@supabase/supabase-js'
import type { RealtimeChannel, SupabaseClient, User } from '@supabase/supabase-js'
import { winRateScore } from '../lib/skillRating'
import type { PickupService } from './contract'
import { errorMessages, PickupError } from './errors'
import { defaultPreferences, isUpcoming, seededSports } from '../types/domain'
import type {
  BrowseGame, DirectoryPlayer, Game, GameResult, GameSummary, Notification, NotificationType, Participation,
  PlayerGameStat, PlayerStats, Profile, RatingSummary, Session, Skill, SportSkillRating, SportStats, Team,
} from '../types/domain'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

// Backend codes the UI doesn't know → closest UI code + message
const translated: Record<string, [keyof typeof errorMessages, string]> = {
  CONTACTS_CLOSED: ['GAME_UNAVAILABLE', 'Game contacts are closed.'],
  USERNAME_LOCKED: ['VALIDATION', 'Usernames are locked after setup.'],
  LEVEL_LOCKED: ['VALIDATION', 'That skill level is verified by other players and can’t be changed.'],
  DAILY_LIMIT_REACHED: ['VALIDATION', 'You can create up to 2 games per day.'],
}

function check(error: { message: string } | null) {
  if (!error) return
  const code = error.message
  if (Object.hasOwn(errorMessages, code)) throw new PickupError(code as keyof typeof errorMessages)
  if (Object.hasOwn(translated, code)) throw new PickupError(...translated[code])
  throw new Error(code)
}

function sessionFor(user: User | undefined | null): Session {
  if (!user?.email) throw new Error('No email session is available. Turn off email confirmation in Supabase Auth.')
  return { userId: user.id, email: user.email }
}

const emptyStats = (): PlayerStats => ({ gamesPlayed: 0, wins: 0, losses: 0, draws: 0, goals: 0, assists: 0, points: 0, metrics: {} })
const one = <T>(value: T | T[] | null | undefined): T | null => Array.isArray(value) ? value[0] ?? null : value ?? null

function toGame(g: Row): Game {
  const levels: string[] | null = g.skill_levels
  return {
    id: g.id, organizerId: g.organizer_id, sport: g.sport_slug, title: g.title, venue: g.venue,
    venueAddress: g.venue_address ?? '', startsAt: g.starts_at, endsAt: g.ends_at ?? null, maxPlayers: g.max_players,
    teamSize: g.team_size ?? null, joinMode: g.join_mode, skillLevel: levels?.length === 1 ? levels[0] as Skill : null,
    description: g.description ?? '', status: g.status,
  }
}

function toResult(r: Row | null): GameResult | null {
  if (!r) return null
  return {
    gameId: r.game_id, teamAScore: r.team_a_score ?? 0, teamBScore: r.team_b_score ?? 0, status: r.status,
    submittedBy: r.submitted_by, submittedAt: r.submitted_at, confirmedBy: r.confirmed_by ?? null,
    confirmedAt: r.confirmed_at ?? null, disputeReason: r.dispute_reason ?? null, revision: r.revision,
  }
}

const notificationType = (type: string) => (type === 'new_game_nearby' ? 'new_game_available' : type) as NotificationType

export function createSupabaseAdapter(url: string, publishableKey: string): PickupService {
  return supabaseAdapter(createClient(url, publishableKey))
}

export function supabaseAdapter(client: SupabaseClient): PickupService {
  const changes = new EventTarget()
  const changed = () => changes.dispatchEvent(new Event('change'))
  let hoods: Promise<Record<string, string>> | null = null

  async function rpc<T>(name: string, args: Record<string, unknown> = {}, write = true): Promise<T> {
    const { data, error } = await client.rpc(name, args)
    check(error)
    if (write) changed()
    return data as T
  }
  async function rows(query: PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<Row[]> {
    const { data, error } = await query
    check(error)
    return (data ?? []) as Row[]
  }
  async function me(): Promise<string> {
    const { data } = await client.auth.getSession()
    if (!data.session) throw new PickupError('FORBIDDEN', 'Log in first.')
    return data.session.user.id
  }

  // ---------- neighborhoods: label text ↔ slug + area note ----------
  function neighborhoodNames() {
    hoods ??= rows(client.from('neighborhoods').select('slug,name'))
      .then(list => Object.fromEntries(list.map(row => [row.slug, row.name])))
    return hoods
  }
  async function toNeighborhood(text: string) {
    const value = text.trim().replace(/\s+/g, ' ')
    const names = await neighborhoodNames()
    const slug = Object.keys(names).find(key => key === value.toLowerCase() || names[key].toLowerCase() === value.toLowerCase())
    return slug ? { slug, note: '' } : { slug: 'other-tampa', note: value.slice(0, 80) }
  }
  const neighborhoodLabel = (slug: string, note: string | null, names: Record<string, string>) =>
    slug === 'other-tampa' && note ? note : names[slug] ?? slug

  // ---------- profiles, stats, ratings ----------
  const profileColumns = 'id,display_name,username,neighborhood,area_note,bio,replacement_alerts,new_game_alerts,user_sports(sport_slug,skill_level,level_source,rating_count)'
  function toProfile(row: Row, names: Record<string, string>): Profile {
    return {
      id: row.id, displayName: row.display_name, username: row.username ?? undefined,
      neighborhood: neighborhoodLabel(row.neighborhood, row.area_note, names), bio: row.bio ?? '',
      sports: (row.user_sports ?? []).map((us: Row) => ({ sport: us.sport_slug, skill: us.skill_level })),
      notificationPreferences: { replacementAlerts: row.replacement_alerts ?? true, newGameAlerts: row.new_game_alerts ?? false },
    }
  }
  async function getProfile(id: string) {
    const [list, names] = await Promise.all([rows(client.from('profiles').select(profileColumns).eq('id', id)), neighborhoodNames()])
    return list[0] ? toProfile(list[0], names) : null
  }

  async function statsFor(ids: string[]) {
    const result = new Map<string, { stats: PlayerStats; sportStats: SportStats[] } & RatingSummary>()
    for (const id of ids) result.set(id, { stats: emptyStats(), sportStats: [], avgRating: null, reviewCount: 0 })
    if (!ids.length) return result
    const [totals, bySport, metrics, ratings] = await Promise.all([
      rows(client.from('player_stats').select('*').in('player_id', ids)),
      rows(client.from('player_sport_stats').select('*').in('player_id', ids)),
      rows(client.from('player_sport_metric_totals').select('player_id,sport_slug,stat_key,total').in('player_id', ids)),
      rows(client.from('player_ratings').select('*').in('player_id', ids)),
    ])
    const base = (r: Row): PlayerStats => ({ gamesPlayed: r.games_played, wins: r.wins, losses: r.losses, draws: r.draws,
      goals: r.goals, assists: r.assists, points: r.points, metrics: {} })
    for (const r of totals) result.get(r.player_id)!.stats = base(r)
    for (const r of bySport) result.get(r.player_id)!.sportStats.push({ ...base(r), sport: r.sport_slug })
    for (const m of metrics) {
      const sport = result.get(m.player_id)!.sportStats.find(s => s.sport === m.sport_slug)
      if (sport) sport.metrics[m.stat_key] = m.total
    }
    for (const r of ratings) Object.assign(result.get(r.player_id)!, { avgRating: r.avg_rating === null ? null : Number(r.avg_rating), reviewCount: r.review_count })
    return result
  }

  async function phoneOnFile() {
    const list = await rows(client.from('private_contacts').select('phone_e164'))
    return list[0]?.phone_e164 as string | undefined
  }
  async function requirePhone() {
    if (!(await phoneOnFile())) throw new PickupError('CONTACT_REQUIRED')
  }

  // ---------- games ----------
  async function rosterCounts(ids: string[]) {
    const counts = new Map<string, number>()
    if (!ids.length) return counts
    for (const r of await rows(client.from('game_players').select('game_id').in('game_id', ids))) {
      counts.set(r.game_id, (counts.get(r.game_id) ?? 0) + 1)
    }
    return counts
  }
  async function summaries(games: Row[]): Promise<GameSummary[]> {
    const counts = await rosterCounts(games.map(g => g.id))
    return games.map(g => ({ ...toGame(g), confirmed: counts.get(g.id) ?? 0, result: toResult(one(g.game_results)) }))
  }

  const service: PickupService = {
    async getSession() {
      const { data, error } = await client.auth.getSession()
      check(error)
      return data.session ? sessionFor(data.session.user) : null
    },
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password })
      check(error)
      changed()
      return sessionFor(data.session?.user)
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password })
      check(error)
      changed()
      return sessionFor(data.session?.user)
    },
    async signOut() {
      check((await client.auth.signOut({ scope: 'local' })).error)
      changed()
    },
    subscribe(listener) {
      let active = true
      const { data } = client.auth.onAuthStateChange(() => setTimeout(() => { if (active) listener() }, 0))
      changes.addEventListener('change', listener)
      return () => { active = false; data.subscription.unsubscribe(); changes.removeEventListener('change', listener) }
    },

    getProfile,
    async getPlayerDetails(id) {
      const profile = await getProfile(id)
      if (!profile) return null
      const [stats, reviews, levels] = await Promise.all([
        statsFor([id]),
        rows(client.from('public_reviews').select('id,sport_slug,rating,skill_rating,comment').eq('reviewee_id', id)),
        rows(client.from('user_sports').select('sport_slug,skill_level,level_source,rating_count').eq('user_id', id)),
      ])
      const s = stats.get(id)!
      const skillRatings: SportSkillRating[] = levels.map(level => {
        const sport = s.sportStats.find(item => item.sport === level.sport_slug)
        const verified = level.level_source === 'verified'
        return {
          sport: level.sport_slug, score: null, tier: verified ? level.skill_level : null, provisional: !verified,
          matches: sport?.gamesPlayed ?? 0, peers: level.rating_count ?? 0, peerScore: null,
          winRateScore: sport ? winRateScore(sport) : null, requiresStatNormalization: false, lastRecalculatedAt: null,
        }
      })
      return {
        ...profile, ...s, skillRatings,
        reviews: reviews.map(r => ({ id: r.id, sport: r.sport_slug, rating: r.rating, skillRating: r.skill_rating ?? null, comment: r.comment ?? '' })),
      }
    },
    async saveProfile(input) {
      const id = await me()
      const existing = (await rows(client.from('profiles').select('travel_radius_miles').eq('id', id)))[0]
      if (!existing && !input.phoneNumber) throw new PickupError('CONTACT_REQUIRED')
      const hood = await toNeighborhood(input.neighborhood)
      await rpc<string>('save_profile', {
        p_display_name: input.displayName, p_neighborhood: hood.slug, p_travel_radius_miles: existing?.travel_radius_miles ?? 10,
        p_bio: input.bio, p_sports: input.sports.map(item => ({ sport_slug: item.sport, skill_level: item.skill })),
        p_replacement_alerts: input.notificationPreferences?.replacementAlerts ?? null,
        p_new_game_alerts: input.notificationPreferences?.newGameAlerts ?? null,
        p_username: input.username ?? null, p_phone: input.phoneNumber ?? null, p_area_note: hood.note,
      })
      const profile = await getProfile(id)
      if (!profile) throw new Error('The saved profile could not be read.')
      return profile
    },
    async getAccountDetails() {
      return { phoneNumber: (await phoneOnFile()) ?? null }
    },
    usernameAvailable: username => rpc<boolean>('username_available', { p_username: username }, false),
    async getGameContacts(gameId) {
      const caller = await me()
      const list = await rpc<Row[]>('get_game_contacts', { p_game_id: gameId }, false)
      return list.filter(c => c.player_id !== caller).map(c => ({ playerId: c.player_id, name: c.display_name, phoneNumber: c.phone_e164 }))
    },
    async findPlayers(filters) {
      const [list, names] = await Promise.all([rpc<Row[]>('find_players', {
        p_sport: filters.sport || null, p_skill: filters.skill || null, p_game_id: filters.gameId || null,
        p_name: filters.name?.trim() || null, p_replacement: filters.replacement ?? false,
      }, false), neighborhoodNames()])
      const stats = await statsFor(list.map(r => r.id))
      return list.map((r): DirectoryPlayer => ({
        id: r.id, displayName: r.display_name, username: r.username ?? undefined, bio: r.bio ?? '',
        neighborhood: neighborhoodLabel(r.neighborhood, r.area_note, names),
        sports: (r.sports as Row[]).map(s => ({ sport: s.sport_slug, skill: s.skill_level })),
        ...stats.get(r.id)!,
      }))
    },

    async createGame(input) {
      const id = await me()
      const area = (await rows(client.from('profiles').select('neighborhood').eq('id', id)))[0]?.neighborhood ?? 'other-tampa'
      const minutes = Math.round((Date.parse(input.endsAt) - Date.parse(input.startsAt)) / 60000)
      return rpc<string>('create_game', {
        p_sport_slug: input.sport, p_title: input.title, p_venue: input.venue, p_neighborhood: area,
        p_starts_at: input.startsAt, p_max_players: input.maxPlayers, p_join_mode: input.joinMode ?? 'invite_only',
        p_skill_levels: input.skillLevel ? [input.skillLevel] : null, p_team_size: input.teamSize ?? null,
        p_description: input.description ?? null, p_venue_address: input.venueAddress, p_duration_minutes: minutes,
      })
    },
    async editGame(gameId, input) {
      await rpc('edit_game', {
        p_game_id: gameId, p_title: input.title, p_venue: input.venue, p_venue_address: input.venueAddress,
        p_starts_at: input.startsAt, p_ends_at: input.endsAt, p_description: input.description ?? null,
      })
    },
    async myGames() {
      const id = await me()
      const ids = (await rows(client.from('game_players').select('game_id').eq('player_id', id))).map(r => r.game_id)
      if (!ids.length) return []
      const games = await rows(client.from('games').select('*,game_results(*)').in('id', ids))
      return (await summaries(games)).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
    },
    async getGame(id) {
      const caller = await me()
      const game = (await rows(client.from('games').select('*,game_results(*)').eq('id', id)))[0]
      if (!game) return null
      const [roster, part] = await Promise.all([
        rows(client.from('game_players').select('player_id,team,profiles(display_name,user_sports(sport_slug,skill_level))').eq('game_id', id)),
        rpc<Row[]>('game_participation', { p_game_id: id }, false),
      ])
      const p = part[0] ?? {}
      const organizer = game.organizer_id === caller
      const onRoster = roster.some(r => r.player_id === caller)
      const stats = await statsFor(roster.map(r => r.player_id))
      const skillIn = (sports: Row[] | undefined) => sports?.find(s => s.sport_slug === game.sport_slug)?.skill_level as Skill | undefined
      const [requests, invitations, perf, values, reviews, names] = await Promise.all([
        organizer ? rows(client.from('join_requests').select('*,profiles(display_name,username,neighborhood,area_note,user_sports(sport_slug,skill_level))')
          .eq('game_id', id).order('created_at', { ascending: false })) : Promise.resolve([]),
        organizer ? rows(client.from('invitations').select('*,profiles!invitations_recipient_id_fkey(display_name)')
          .eq('game_id', id).order('created_at', { ascending: false })) : Promise.resolve([]),
        onRoster ? rows(client.from('player_game_stats').select('*').eq('game_id', id)) : Promise.resolve([]),
        onRoster ? rows(client.from('player_game_stat_values').select('player_id,stat_key,value').eq('game_id', id)) : Promise.resolve([]),
        onRoster ? rows(client.from('reviews').select('reviewee_id').eq('game_id', id).eq('reviewer_id', caller)) : Promise.resolve([]),
        neighborhoodNames(),
      ])
      return {
        ...toGame(game), confirmed: roster.length, result: toResult(one(game.game_results)),
        roster: roster.map(r => ({ id: r.player_id, displayName: one(r.profiles)?.display_name ?? 'Player', team: r.team ?? null,
          skill: skillIn(one(r.profiles)?.user_sports), stats: stats.get(r.player_id)!.stats })),
        participation: {
          isMember: p.is_member ?? onRoster, canJoin: p.can_join ?? false, canRequest: p.can_request ?? false,
          canClaim: p.can_claim ?? false, ineligibleReason: p.ineligible_reason ?? undefined,
          requestId: p.request_id ?? undefined, invitationId: p.invitation_id ?? undefined,
        },
        joinRequests: requests.map(r => {
          const who = one(r.profiles) ?? {}
          return { id: r.id, gameId: r.game_id, playerId: r.player_id, status: r.status, createdAt: r.created_at,
            respondedAt: r.responded_at ?? null, playerName: who.display_name ?? 'Player', username: who.username ?? undefined,
            neighborhood: who.neighborhood ? neighborhoodLabel(who.neighborhood, who.area_note, names) : undefined,
            skill: skillIn(who.user_sports) }
        }),
        performances: perf.map((r): PlayerGameStat => ({
          gameId: r.game_id, playerId: r.player_id, team: r.team, outcome: r.outcome,
          goals: r.goals, assists: r.assists, points: r.points,
          metrics: Object.fromEntries(values.filter(v => v.player_id === r.player_id).map(v => [v.stat_key, v.value])),
        })),
        sentInvitations: invitations.map(i => ({ id: i.id, gameId: i.game_id, senderId: i.sender_id, recipientId: i.recipient_id,
          team: i.team ?? null, squadId: i.squad_id ?? undefined, status: i.status, createdAt: i.created_at,
          respondedAt: i.responded_at ?? null, recipientName: one(i.profiles)?.display_name ?? 'Player' })),
        reviewedPlayerIds: reviews.map(r => r.reviewee_id),
      }
    },

    invite: (gameId, recipientId, team = null) =>
      rpc<string>('send_invitation', { p_game_id: gameId, p_recipient_id: recipientId, p_team: team }),
    async inviteMany(gameId, recipients, team = null) {
      const list = await rpc<Row[]>('send_invitations', { p_game_id: gameId, p_recipient_ids: recipients, p_team: team })
      return list.map(r => ({ recipientId: r.recipient_id, invitationId: r.invitation_id ?? undefined, error: r.error ?? undefined }))
    },
    async inbox() {
      const id = await me()
      const list = await rows(client.from('invitations')
        .select('*,games(*,game_results(*)),sender:profiles!invitations_sender_id_fkey(display_name)')
        .eq('recipient_id', id).eq('status', 'pending').order('created_at', { ascending: false }))
      const games = await summaries(list.map(r => one(r.games)).filter((g): g is Row => Boolean(g)))
      return list.flatMap(r => {
        const game = games.find(g => g.id === r.game_id)
        if (!game || !isUpcoming(game)) return []
        return [{ id: r.id, gameId: r.game_id, senderId: r.sender_id, recipientId: r.recipient_id, team: r.team ?? null,
          squadId: r.squad_id ?? undefined, status: r.status, createdAt: r.created_at, respondedAt: r.responded_at ?? null,
          game, senderName: one(r.sender)?.display_name ?? 'Organizer' }]
      })
    },
    async respond(invitationId, response) {
      if (response === 'accepted') await requirePhone()
      return rpc('respond_to_invitation', { p_invitation_id: invitationId, p_response: response })
    },
    cancelInvitation: invitationId => rpc('cancel_invitation', { p_invitation_id: invitationId }),
    cancelGame: gameId => rpc('cancel_game', { p_game_id: gameId }),
    setTeam: (gameId, playerId, team) => rpc<Team | null>('set_team', { p_game_id: gameId, p_player_id: playerId, p_team: team }),
    async autoAssignTeams(gameId) {
      const list = await rpc<Row[]>('auto_assign_teams', { p_game_id: gameId })
      return list.map(r => ({ playerId: r.player_id, team: r.team ?? null }))
    },
    submitResults: (gameId, input) => rpc('submit_results', {
      p_game_id: gameId, p_team_a_score: input.teamAScore, p_team_b_score: input.teamBScore,
      p_performances: input.performances.map(({ playerId, metrics, ...flat }) => {
        const legacy = Object.fromEntries(Object.entries(flat).filter(([key, value]) => value !== undefined && !(metrics && key in metrics)))
        return { player_id: playerId, ...legacy, ...(metrics ? { metrics } : {}) }
      }),
    }),
    confirmResults: gameId => rpc('confirm_results', { p_game_id: gameId }),
    disputeResults: (gameId, reason) => rpc('dispute_results', { p_game_id: gameId, p_reason: reason }),
    submitReview: (gameId, input) => rpc<string>('submit_review', {
      p_game_id: gameId, p_reviewee_id: input.revieweeId, p_rating: input.rating, p_comment: input.comment ?? '',
      p_skill_rating: input.skillRating ?? null,
    }),

    async listSports() {
      const list = await rows(client.from('sports').select('slug,name,sport_stat_definitions(stat_key,sort_order)'))
      const order = (slug: string) => { const i = seededSports.findIndex(s => s.slug === slug); return i < 0 ? 999 : i }
      return list
        .map(s => ({ slug: s.slug, name: s.name,
          fields: [...(s.sport_stat_definitions ?? [])].sort((a: Row, b: Row) => a.sort_order - b.sort_order).map((d: Row) => d.stat_key as string) }))
        .sort((a, b) => order(a.slug) - order(b.slug) || a.name.localeCompare(b.name))
    },
    async createSport(name) {
      const r = (await rpc<Row[]>('create_sport', { p_name: name }))[0]
      const fields = (await rows(client.from('sport_stat_definitions').select('stat_key,sort_order').eq('sport_slug', r.slug).order('sort_order')))
        .map(d => d.stat_key as string)
      return { slug: r.slug, name: r.name, fields }
    },
    async browseGames(filters = {}) {
      const caller = await me()
      const [list, requests, profile, phone] = await Promise.all([
        rpc<Row[]>('browse_games', {
          p_sport_query: filters.sportName?.trim() || null, p_join_mode: filters.joinMode ?? null,
          p_from: filters.from || null, p_to: filters.to || null, p_only_open_spots: filters.openSpots ?? false, p_limit: 100,
        }, false),
        rows(client.from('join_requests').select('id,game_id').eq('player_id', caller).eq('status', 'pending')),
        getProfile(caller),
        phoneOnFile(),
      ])
      return list.map((g): BrowseGame => {
        const preference = profile?.sports.find(s => s.sport === g.sport_slug)
        const levels: string[] | null = g.skill_levels
        const ineligibleReason = !preference ? 'Add this sport to your profile to play in this game.'
          : levels && !levels.includes(preference.skill) ? 'This game is for ' + levels.join(' or ') + ' players.'
          : !phone ? 'Add a contact phone number in Settings before joining.' : undefined
        const participation: Participation = {
          isMember: g.is_member, canJoin: g.can_join && !ineligibleReason, canRequest: g.can_request && !ineligibleReason,
          canClaim: false, ineligibleReason, requestId: requests.find(r => r.game_id === g.id)?.id,
        }
        return { ...toGame({ ...g, status: 'scheduled', organizer_id: g.organizer_id }), confirmed: g.player_count, result: null,
          ...participation, organizerName: g.organizer_name }
      })
    },
    async joinGame(gameId) { await requirePhone(); return rpc('join_game', { p_game_id: gameId }) },
    async requestToJoin(gameId) { await requirePhone(); return rpc<string>('request_to_join', { p_game_id: gameId }) },
    cancelJoinRequest: requestId => rpc('cancel_join_request', { p_request_id: requestId }),
    respondToJoinRequest: (requestId, decision, team = null) =>
      rpc('respond_to_join_request', { p_request_id: requestId, p_response: decision, p_team: team }),
    withdraw: gameId => rpc('withdraw_from_game', { p_game_id: gameId }),
    async claimReplacement(gameId) { await requirePhone(); return rpc('claim_replacement_spot', { p_game_id: gameId }) },

    async notifications() {
      await me()
      const list = await rows(client.from('notifications').select('*').order('created_at', { ascending: false }).limit(100))
      return list.map((n): Notification => ({
        id: n.id, type: notificationType(n.type), title: n.title, body: n.body ?? '', createdAt: n.created_at,
        readAt: n.read_at ?? null, gameId: n.game_id ?? undefined, invitationId: n.invitation_id ?? undefined,
        requestId: n.join_request_id ?? undefined, squadId: n.data?.squad_id ?? undefined,
      }))
    },
    markNotificationsRead: ids => rpc<number>('mark_notifications_read', { p_ids: ids ?? null }),
    async getNotificationPreferences() {
      const profile = await getProfile(await me())
      return profile?.notificationPreferences ?? { ...defaultPreferences }
    },
    async setNotificationPreferences(preferences) {
      await rpc('set_notification_preferences', {
        p_replacement_alerts: preferences.replacementAlerts, p_new_game_alerts: preferences.newGameAlerts })
    },
    subscribeToNotifications(listener) {
      let channel: RealtimeChannel | null = null
      let closed = false
      me().then(id => {
        if (closed) return
        channel = client.channel('notifications-' + id)
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: 'user_id=eq.' + id }, () => listener())
          .subscribe()
      }).catch(() => undefined)
      return () => { closed = true; if (channel) void client.removeChannel(channel) }
    },

    async mySquads() {
      const squads = await rows(client.from('my_squads').select('*'))
      if (!squads.length) return []
      const members = await rows(client.from('squad_members').select('squad_id,profiles(id,display_name)').in('squad_id', squads.map(s => s.id)))
      return squads.map(s => ({
        id: s.id, name: s.name, sport: s.sport_slug, captainId: s.captain_id, joinCode: s.join_code,
        members: members.filter(m => m.squad_id === s.id).map(m => ({ id: one(m.profiles)?.id, displayName: one(m.profiles)?.display_name ?? 'Player' })),
      }))
    },
    async createSquad(name, sport) { return (await rpc<Row[]>('create_squad', { p_name: name, p_sport_slug: sport }))[0].id },
    joinSquad: code => rpc<string>('join_squad', { p_join_code: code }),
    leaveSquad: squadId => rpc('leave_squad', { p_squad_id: squadId }),
    removeSquadMember: (squadId, playerId) => rpc('remove_squad_member', { p_squad_id: squadId, p_player_id: playerId }),
    deleteSquad: squadId => rpc('delete_squad', { p_squad_id: squadId }),
    async inviteSquad(gameId, squadId, team = null) {
      const list = await rpc<Row[]>('invite_squad', { p_game_id: gameId, p_squad_id: squadId, p_team: team })
      return list.map(r => ({ recipientId: r.recipient_id, invitationId: r.invitation_id ?? undefined, error: r.error ?? undefined }))
    },
  }
  return service
}
