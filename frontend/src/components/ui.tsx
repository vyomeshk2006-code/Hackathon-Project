import { CalendarDays, CircleDot, Dribbble, Goal, MapPin, Volleyball } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { useCatalog } from './SportPicker'
import { Link } from 'react-router-dom'
import { formatGameTime } from '../lib/time'
import { isUpcoming, skills, sportName } from '../types/domain'
import type { GameSummary, Sport } from '../types/domain'

const sportIcons: Partial<Record<string, LucideIcon>> = { soccer: Goal, basketball: Dribbble, volleyball: Volleyball, pickleball: CircleDot }

export function SportIcon({ sport }: { sport: Sport }) {
  const Icon = (Object.hasOwn(sportIcons, sport) ? sportIcons[sport] : undefined) ?? CircleDot
  return <Icon size={21} aria-hidden="true" />
}

export function SportBadge({ sport }: { sport: Sport }) {
  const catalog = useCatalog()
  return <span className="sport-badge"><SportIcon sport={sport} />{sportName(sport, catalog)}</span>
}

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="page-title">
      <div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {action}
    </header>
  )
}

export function Notice({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'error' | 'success' }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>
}

export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return <Notice tone="error">{error} <button className="text-link" onClick={retry}>Try again</button></Notice>
}

export function Avatar({ name }: { name: string }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map(word => Array.from(word)[0]).join('')
  const hue = (name.codePointAt(0) ?? 0) % 4
  return <span aria-hidden="true" className={`avatar avatar-${hue}`}>{initials}</span>
}

export function GameCard({ game }: { game: GameSummary }) {
  return (
    <article className="card game-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SportBadge sport={game.sport} />
        <div className="flex flex-wrap gap-2">
          <span className="pill">{game.confirmed} / {game.maxPlayers} confirmed</span>
          {game.status !== 'scheduled' && <span className="pill capitalize">{game.status}</span>}
        </div>
      </div>
      <p className="muted">{game.joinMode === 'open' ? 'Open' : 'Invite-only'} · {game.skillLevel ? skills[game.skillLevel] : 'All levels'}
        {game.teamSize && ' · ' + game.teamSize + 'v' + game.teamSize}</p>
      <h3><Link className="card-link" to={`/games/${game.id}`}>{game.title}</Link></h3>
      <p className="icon-line"><CalendarDays size={17} aria-hidden="true" />{formatGameTime(game.startsAt)}</p>
      {game.status === 'scheduled' && !isUpcoming(game) && <span className="pill">{game.endsAt && Date.parse(game.endsAt) > Date.now() ? 'Ongoing' : 'Past'}</span>}
      <VenueDetails venue={game.venue} address={game.venueAddress} />
      {game.endsAt && <p className="muted">Ends {formatGameTime(game.endsAt)}</p>}
      {game.result && <p className="muted">Team A {game.result.teamAScore}–{game.result.teamBScore} Team B · {game.result.status === 'pending' ? 'Awaiting confirmation' : game.result.status}</p>}
    </article>
  )
}


export function VenueDetails({ venue, address }: { venue: string; address: string }) {
  return <div>
    <p className="icon-line"><MapPin size={17} aria-hidden="true" />{venue}</p>
    {address && <><p className="venue-address">{address}</p>
      <a className="text-link" href={'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(address)}
        target="_blank" rel="noopener noreferrer">Open directions<span className="sr-only"> to {venue} (opens a new tab)</span></a>
    </>}
  </div>
}
