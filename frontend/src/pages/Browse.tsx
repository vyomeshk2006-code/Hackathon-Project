
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionNotice } from '../components/ActionNotice'
import { GameCard, LoadError, Notice, PageTitle } from '../components/ui'
import { useAction } from '../hooks/useAction'
import { useGameClock } from '../hooks/useGameClock'
import { useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { isActiveGame, isUpcoming } from '../types/domain'
import type { BrowseFilters, GameSummary, Participation, Session, Visibility } from '../types/domain'

export function ParticipationActions({ game, access, allowClaim = false }: { game: GameSummary; access: Participation; allowClaim?: boolean }) {
  const action = useAction()
  const explanationId = useId()
  const showClaim = allowClaim && access.canClaim
  const full = game.confirmed >= game.maxPlayers
  if (access.isMember) return <p className="pill">Joined</p>
  if (!isUpcoming(game)) return null
  return <div className="form-stack">
    <div className="flex flex-wrap gap-2 items-center">
      {showClaim && <button className="button primary" disabled={action.pending}
        onClick={() => void action.run(() => pickup.claimReplacement(game.id), 'Replacement spot claimed.')}>Claim spot</button>}
      {access.canJoin && !showClaim && <button className="button primary" disabled={action.pending}
        onClick={() => void action.run(() => pickup.joinGame(game.id), 'You joined the game.')}>Join game</button>}
      {access.canRequest && !showClaim && <button className="button primary" disabled={action.pending}
        onClick={() => void action.run(() => pickup.requestToJoin(game.id), 'Request sent.')}>Request to join</button>}
      {access.canClaim && !allowClaim && <Link className="button secondary" to={'/games/' + game.id}>View replacement spot</Link>}
      {access.invitationId && <Link className="button secondary" to={'/invitations?invitation=' + access.invitationId}>Respond to invitation</Link>}
      {access.requestId && <>
        <span className="pill">Request pending</span>
        <button className="button secondary" disabled={action.pending} onClick={() => {
          const id = access.requestId
          if (id) void action.run(() => pickup.cancelJoinRequest(id), 'Request cancelled.')
        }}>Cancel request</button>
      </>}
      {access.requestId && full && <span className="pill">Game full</span>}
      {!access.canJoin && !access.canRequest && !showClaim && !access.requestId && <>
        <button className="button secondary" disabled aria-describedby={explanationId}>
          {game.joinMode === 'invite_only' ? 'Request to join' : 'Join game'}
        </button>
        <p id={explanationId} className="muted">{full ? 'Game full.' : access.ineligibleReason ?? 'This action is unavailable.'}</p>
      </>}
    </div>
    <ActionNotice {...action} />
  </div>
}

export function BrowseGames({ session }: { session: Session }) {
  const [filters, setFilters] = useState<BrowseFilters>({ openSpots: false })
  const badDates = Boolean(filters.from && filters.to && filters.from > filters.to)
  const { state, retry } = useResource('browse:' + session.userId + JSON.stringify(filters),
    () => badDates ? Promise.resolve([]) : pickup.browseGames(filters))
  const results = state.status === 'ready' ? state.data : []
  const now = useGameClock(results.flatMap(game => [game.startsAt, game.endsAt]))
  const active = results.filter(game => isActiveGame(game, now))
  return <>
    <PageTitle title="Browse games" action={<Link className="button primary" to="/games/new">Create a game</Link>} />
    <div className="card filter-bar expanded-filters">
      <label>Search by sport<input value={filters.sportName ?? ''} onChange={event => setFilters({ ...filters, sportName: event.target.value })}
        placeholder="Soccer, disc golf…" /></label>
      <label>Game type<select value={filters.joinMode ?? ''} onChange={event => setFilters({
        ...filters, joinMode: (event.target.value || undefined) as Visibility | undefined,
      })}><option value="">All game types</option><option value="open">Open</option><option value="invite_only">Invite-only</option></select></label>
      <label>From date<input type="date" value={filters.from ?? ''} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label>
      <label>Through date<input type="date" value={filters.to ?? ''} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label>
      <label className="filter-check"><input type="checkbox" checked={filters.openSpots} onChange={event => setFilters({ ...filters, openSpots: event.target.checked })} /> Only games with open spots</label>
    </div>
    {badDates ? <Notice tone="error">The end date must be on or after the start date.</Notice> :
      state.status === 'loading' ? <Notice>Finding games…</Notice> :
      state.status === 'error' ? <LoadError error={state.error} retry={retry} /> :
      !active.length ? <Notice>No active games match these filters.</Notice> :
      <div className="card-grid">{active.map(game => <div key={game.id} className="browse-card">
        <GameCard game={game} />
        <p className="muted">Hosted by {game.organizerName}</p>
        <ParticipationActions game={game} access={game} />
      </div>)}</div>}
  </>
}
