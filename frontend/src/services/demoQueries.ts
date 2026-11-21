import type {
  Game, GameResult, GameSummary, Invitation, Neighborhood, PlayerGameStat,
  PlayerStats, Profile, RatingSummary, Review, SportStats, TeamAssignment,
} from '../types/domain'

export type Account = { id: string; email: string; salt: string; verifier: string }
export type RosterEntry = TeamAssignment & { gameId: string; joinedAt: string }
export type DemoData = {
  accounts: Account[]
  profiles: Profile[]
  games: Game[]
  roster: RosterEntry[]
  invitations: Invitation[]
  results: GameResult[]
  performances: PlayerGameStat[]
  reviews: Review[]
}

const centers: Record<Neighborhood, readonly [number, number]> = {
  downtown: [27.9490, -82.4572],
  'seminole-heights': [27.9963, -82.4514],
  'south-tampa': [27.9065, -82.4950],
  usf: [28.0587, -82.4139],
  'west-tampa': [27.9623, -82.4860],
  'other-tampa': [27.9780, -82.4580],
}

export function neighborhoodDistance(from: Neighborhood, to: Neighborhood) {
  const [fromLat, fromLng] = centers[from]
  const [toLat, toLng] = centers[to]
  const radians = Math.PI / 180
  const arc = Math.sin((toLat - fromLat) * radians / 2) ** 2 +
    Math.cos(fromLat * radians) * Math.cos(toLat * radians) * Math.sin((toLng - fromLng) * radians / 2) ** 2
  return 2 * 3958.76 * Math.asin(Math.sqrt(arc))
}

export function ratingFor(data: DemoData, id: string): RatingSummary {
  const reviews = data.reviews.filter(review => review.revieweeId === id)
  const sum = reviews.reduce((total, review) => total + review.rating, 0)
  return { avgRating: reviews.length ? Math.round(sum * 100 / reviews.length) / 100 : null, reviewCount: reviews.length }
}

const zeroStats = (): PlayerStats => ({
  gamesPlayed: 0, wins: 0, losses: 0, draws: 0, goals: 0, points: 0, assists: 0,
})

function record(stats: PlayerStats, row: PlayerGameStat) {
  stats.gamesPlayed += 1
  if (row.outcome === 'win') stats.wins += 1
  if (row.outcome === 'loss') stats.losses += 1
  if (row.outcome === 'draw') stats.draws += 1
  stats.goals += row.goals
  stats.points += row.points
  stats.assists += row.assists
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
