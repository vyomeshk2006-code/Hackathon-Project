import type {
  Game, GameResult, GameSummary, Invitation, PlayerGameStat,
  PlayerStats, Profile, RatingSummary, Review, SportStats, TeamAssignment,
  Notification, JoinRequest, SportDefinition, Squad, Team,
} from '../types/domain'

export type Account = { id: string; email: string; salt: string; verifier: string }
export type RosterEntry = TeamAssignment & { gameId: string; joinedAt: string }
export type DemoData = {
  catalog: SportDefinition[]
  requests: JoinRequest[]
  notices: (Notification & { userId: string })[]
  squads: (Omit<Squad, 'members'> & { memberIds: string[] })[]
  withdrawals: { id: string; gameId: string; playerId: string; team: Team | null; at: string; lastMinute: boolean }[]
  alerts: { gameId: string; withdrawalId: string; playerId: string; team: Team | null }[]
  contacts: { playerId: string; phoneNumber: string }[]
  accounts: Account[]
  profiles: Profile[]
  games: Game[]
  roster: RosterEntry[]
  invitations: Invitation[]
  results: GameResult[]
  performances: PlayerGameStat[]
  reviews: Review[]
}

export function ratingFor(data: DemoData, id: string): RatingSummary {
  const reviews = finalReviews(data, id)
  const sum = reviews.reduce((total, review) => total + review.rating, 0)
  return { avgRating: reviews.length ? Math.round(sum * 100 / reviews.length) / 100 : null, reviewCount: reviews.length }
}

const zeroStats = (): PlayerStats => ({
  gamesPlayed: 0, wins: 0, losses: 0, draws: 0, goals: 0, points: 0, assists: 0, metrics: {},
})

function record(stats: PlayerStats, row: PlayerGameStat) {
  stats.gamesPlayed += 1
  if (row.outcome === 'win') stats.wins += 1
  if (row.outcome === 'loss') stats.losses += 1
  if (row.outcome === 'draw') stats.draws += 1
  stats.goals += row.goals
  stats.points += row.points
  stats.assists += row.assists
  for (const [key, value] of Object.entries(row.metrics)) stats.metrics[key] = (stats.metrics[key] ?? 0) + value
}

export function statsFor(data: DemoData, playerId: string) {
  const finalized = new Set(data.results.filter(result => result.status === 'final').map(result => result.gameId))
  const games = new Map(data.games.map(game => [game.id, game.sport]))
  const stats = zeroStats()
  const perSport = new Map<SportStats['sport'], SportStats>()
  for (const row of data.performances) {
    const sport = games.get(row.gameId)
    if (!sport || row.playerId !== playerId || !finalized.has(row.gameId)) continue
    const totals = perSport.get(sport) ?? { sport, ...zeroStats() }
    record(stats, row)
    record(totals, row)
    perSport.set(sport, totals)
  }
  return { stats, sportStats: [...perSport.values()].sort((a, b) => a.sport.localeCompare(b.sport)) }
}

export function summary(data: DemoData, game: Game, includeResult = false): GameSummary {
  return {
    ...game,
    confirmed: data.roster.filter(entry => entry.gameId === game.id).length,
    result: includeResult ? data.results.find(result => result.gameId === game.id) ?? null : null,
  }
}

export function displayName(data: DemoData, id: string) {
  return data.profiles.find(profile => profile.id === id)?.displayName ?? 'Player'
}


export function finalReviews(data: DemoData, playerId: string) {
  const final = new Set(data.results.filter(result => result.status === 'final').map(result => result.gameId))
  return data.reviews.filter(review => review.revieweeId === playerId && final.has(review.gameId))
}
