import { Star } from 'lucide-react'
import { sports, sportStatFields } from '../types/domain'
import type { PlayerDetails, PlayerStats, RatingSummary, StatField } from '../types/domain'

const labels = { gamesPlayed: 'Games played', wins: 'Wins', losses: 'Losses', draws: 'Draws', goals: 'Goals', assists: 'Assists', points: 'Points' }
const recordFields = ['gamesPlayed', 'wins', 'losses', 'draws'] as const
const allFields = ['goals', 'assists', 'points'] as const
const reviewDate = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'short', day: 'numeric',
})

export function Rating({ profile }: { profile: RatingSummary }) {
  if (profile.avgRating === null) return <p className="muted">No reviews yet</p>
  return (
    <p className="icon-line">
      <Star size={17} aria-hidden="true" />
      <span>{profile.avgRating.toFixed(2)} / 5 · {profile.reviewCount} {profile.reviewCount === 1 ? 'review' : 'reviews'}</span>
    </p>
  )
}

function StatGrid({ stats, fields }: { stats: PlayerStats; fields: readonly StatField[] }) {
  return (
    <dl className="stat-grid">
      {[...recordFields, ...fields].map(field => <div key={field}><dt>{labels[field]}</dt><dd>{stats[field]}</dd></div>)}
    </dl>
  )
}

export function PlayerRecord({ profile }: { profile: PlayerDetails }) {
  return (
    <>
      <section className="card form-stack">
        <h2>Player statistics</h2>
        <p className="muted">Totals include confirmed final results only.</p>
        <StatGrid stats={profile.stats} fields={allFields} />
        {profile.sportStats.map(stats => (
          <div className="section-stack" key={stats.sport}>
            <h3>{sports[stats.sport]}</h3>
            <StatGrid stats={stats} fields={sportStatFields[stats.sport]} />
          </div>
        ))}
      </section>
      <section className="card form-stack">
        <h2>Ratings and reviews</h2>
        <Rating profile={profile} />
        {profile.reviews.length > 0 && <ul className="review-list">
          {profile.reviews.map(review => <li key={review.id}>
            <div className="flex flex-wrap items-center gap-x-3">
              <strong>{review.reviewerName}</strong><span className="pill">{review.rating} / 5</span>
              <time className="muted" dateTime={review.createdAt}>{reviewDate.format(new Date(review.createdAt))}</time>
            </div>
            {review.comment && <p>{review.comment}</p>}
          </li>)}
        </ul>}
      </section>
    </>
  )
}
