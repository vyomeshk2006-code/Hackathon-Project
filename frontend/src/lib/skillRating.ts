
import type { PlayerStats, Skill } from '../types/domain'

export const skillTier = (score: number): Skill => score < 40 ? 'beginner' : score < 70 ? 'intermediate' : 'advanced'

export function winRateScore(stats: Pick<PlayerStats, 'wins' | 'draws' | 'losses'>) {
  const decided = stats.wins + stats.draws + stats.losses
  return decided ? 100 * (stats.wins + 0.5 * stats.draws) / decided : null
}

export function weightedSkillScore(
  model: 'stats-supported' | 'no-individual-stats',
  peer: number | null,
  win: number | null,
  normalizedStats: number | null = null,
) {
  if (peer === null || win === null) return null
  if (model === 'stats-supported') {
    if (normalizedStats === null) return null
    return Math.round(0.50 * peer + 0.30 * normalizedStats + 0.20 * win)
  }
  return Math.round(0.60 * peer + 0.40 * win)
}
