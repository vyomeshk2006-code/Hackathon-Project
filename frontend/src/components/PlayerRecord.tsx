
import { Star } from 'lucide-react'
import { useState } from 'react'
import { skills, sportName, statLabel } from '../types/domain'
import type { PlayerDetails, PlayerStats, RatingSummary } from '../types/domain'
import { useCatalog } from './SportPicker'

export function Rating({ profile }: { profile: RatingSummary }) {
  if (profile.avgRating === null) return <p className="muted">No reviews yet</p>
  return <p className="icon-line"><Star size={17} aria-hidden="true" />
    <span>{profile.avgRating.toFixed(2)} / 5 sportsmanship · {profile.reviewCount} {profile.reviewCount === 1 ? 'review' : 'reviews'}</span>
  </p>
}

function StatGrid({ stats, fields }: { stats?: PlayerStats; fields: readonly string[] }) {
  const games = stats?.gamesPlayed ?? 0
  const wins = stats?.wins ?? 0
  const items: [string, string | number][] = [
    ['Matches played', games], ['Wins', wins], ['Losses', stats?.losses ?? 0], ['Draws', stats?.draws ?? 0],
    ['Win percentage', (games ? Math.round(wins / games * 100) : 0) + '%'],
    ...fields.map((field): [string, number] => [statLabel(field), stats?.metrics[field] ?? 0]),
  ]
  return <dl className="stat-grid">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

export function PlayerRecord({ profile }: { profile: PlayerDetails }) {
  const catalog = useCatalog()
  const [sport, setSport] = useState('')
  const options = [...new Set([...profile.sports.map(item => item.sport), ...profile.sportStats.map(item => item.sport)])]
  const selected = options.includes(sport) ? sport : options[0]
  const totals = profile.sportStats.find(item => item.sport === selected)
  const preference = profile.sports.find(item => item.sport === selected)
  const fields = catalog.find(item => item.slug === selected)?.fields ?? []
  const reviews = profile.reviews.filter(item => item.sport === selected)
  const rating = profile.skillRatings.find(item => item.sport === selected)
  return <>
    <section className="card form-stack">
      <h2>Player statistics</h2>
      <p className="muted">Only finalized matches count.</p>
      <h3>All sports</h3><StatGrid stats={profile.stats} fields={[]} />
      {selected && <div className="form-stack sport-record">
        <label>Sport dashboard<select value={selected} onChange={event => setSport(event.target.value)}>
          {options.map(value => <option value={value} key={value}>{sportName(value, catalog)}</option>)}
        </select></label>
        <h3>{sportName(selected, catalog)}</h3>
        {preference && <p>Self-declared skill · {skills[preference.skill]}</p>}
        {rating && <div className="preference-option">
          <h3>Computed skill rating</h3>
          {rating.score !== null && rating.tier && <p><strong>{rating.score} / 100 · {skills[rating.tier]}</strong></p>}
          {rating.provisional && <span className="pill">Provisional</span>}
          <p className="muted">{rating.matches} confirmed {rating.matches === 1 ? 'match' : 'matches'} · {rating.peers} eligible {rating.peers === 1 ? 'peer' : 'peers'}</p>
          {rating.requiresStatNormalization ? <p className="muted">Scoring awaits approved benchmarks for this sport’s individual statistics.</p> :
            rating.provisional && <p className="muted">A settled tier requires five confirmed matches and three distinct eligible peers.</p>}
        </div>}
        {(!totals || !totals.gamesPlayed) && <p className="muted">No finalized matches in this sport yet.</p>}
        <StatGrid stats={totals} fields={fields} />
      </div>}
    </section>
    <section className="card form-stack">
      <h2>Sportsmanship and anonymous reviews</h2>
      <Rating profile={profile} />
      {reviews.length > 0 ? <ul className="review-list">{reviews.map(review => <li key={review.id}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="pill">Sportsmanship {review.rating} / 5</span>
          {review.skillRating !== null && <span className="pill">Skill {review.skillRating} / 5</span>}
        </div>
        {review.comment && <p>{review.comment}</p>}
      </li>)}</ul> : selected && <p className="muted">No reviews for {sportName(selected, catalog)} yet.</p>}
    </section>
  </>
}
