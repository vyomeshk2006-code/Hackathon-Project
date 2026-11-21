
import { skillTier, weightedSkillScore, winRateScore } from '../lib/skillRating'
import type { SportSkillRating, SportStats } from '../types/domain'
import { finalReviews } from './demoQueries'
import type { DemoData } from './demoQueries'

export function skillRatingsFor(data: DemoData, playerId: string, stats: SportStats[]): SportSkillRating[] {
  const profile = data.profiles.find(row => row.id === playerId)
  const sports = new Set([...profile?.sports.map(item => item.sport) ?? [], ...stats.map(item => item.sport)])
  return [...sports].map(sport => {
    const totals = stats.find(item => item.sport === sport)
    const reviews = finalReviews(data, playerId).filter(review => review.sport === sport && review.skillRating !== null)
    const latestByPeer = new Map(reviews.map(review => [review.reviewerId, review]))
    const ratings = [...latestByPeer.values()]
    const peers = ratings.length
    const matches = totals?.gamesPlayed ?? 0
    const peerScore = peers ? 100 * ratings.reduce((sum, review) => sum + review.skillRating!, 0) / (peers * 5) : null
    const win = totals ? winRateScore(totals) : null
    const requiresStatNormalization = Boolean(data.catalog.find(item => item.slug === sport)?.fields.length)
    const score = weightedSkillScore(requiresStatNormalization ? 'stats-supported' : 'no-individual-stats', peerScore, win)
    const gameIds = new Set(data.performances.filter(row => row.playerId === playerId &&
      data.games.some(game => game.id === row.gameId && game.sport === sport)).map(row => row.gameId))
    const evidenceDates = [
      ...ratings.map(review => review.createdAt),
      ...data.results.filter(result => result.status === 'final' && gameIds.has(result.gameId))
        .map(result => result.confirmedAt ?? result.submittedAt),
    ]
    return {
      sport, score, tier: score === null ? null : skillTier(score), provisional: score === null || matches < 5 || peers < 3,
      matches, peers, peerScore, winRateScore: win, requiresStatNormalization,
      lastRecalculatedAt: evidenceDates.sort().at(-1) ?? null,
    }
  })
}
