
import { useId, useState } from 'react'
import { Link } from 'react-router-dom'
import { ActionNotice } from '../components/ActionNotice'
import { useCatalog } from '../components/SportPicker'
import { GameCard, LoadError, Notice, PageTitle } from '../components/ui'
import { useAction } from '../hooks/useAction'
import { useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { isUpcoming, neighborhoods } from '../types/domain'
import type { BrowseFilters, GameSummary, Neighborhood, Participation, Session } from '../types/domain'

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
  const catalog = useCatalog()
  const [filters, setFilters] = useState<BrowseFilters>({ openSpots: false })
  const badDates = Boolean(filters.from && filters.to && filters.from > filters.to)
  const { state, retry } = useResource('browse:' + session.userId + JSON.stringify(filters),
    () => badDates ? Promise.resolve([]) : pickup.browseGames(filters))
  return <>
    <PageTitle title="Browse games" action={<Link className="button primary" to="/games/new">Create a game</Link>} />
    <div className="card filter-bar expanded-filters">
      <label>Sport<select value={filters.sport ?? ''} onChange={event => setFilters({ ...filters, sport: event.target.value || undefined })}>
        <option value="">All sports</option>{catalog.map(sport => <option value={sport.slug} key={sport.slug}>{sport.name}</option>)}
      </select></label>
      <label>Neighborhood<select value={filters.neighborhood ?? ''} onChange={event => setFilters({
        ...filters, neighborhood: (event.target.value || undefined) as Neighborhood | undefined,
      })}>
        <option value="">All neighborhoods</option>{Object.entries(neighborhoods).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
      </select></label>
      <label>From date<input type="date" value={filters.from ?? ''} onChange={event => setFilters({ ...filters, from: event.target.value })} /></label>
      <label>Through date<input type="date" value={filters.to ?? ''} onChange={event => setFilters({ ...filters, to: event.target.value })} /></label>
      <label className="filter-check"><input type="checkbox" checked={filters.openSpots} onChange={event => setFilters({ ...filters, openSpots: event.target.checked })} /> Only games with open spots</label>
    </div>
    {badDates ? <Notice tone="error">The end date must be on or after the start date.</Notice> :
      state.status === 'loading' ? <Notice>Finding games…</Notice> :
      state.status === 'error' ? <LoadError error={state.error} retry={retry} /> :
      !state.data.length ? <Notice>No upcoming games match these filters.</Notice> :
      <div className="card-grid">{state.data.map(game => <div key={game.id} className="browse-card">
        <GameCard game={game} />
        <p className="muted">Hosted by {game.organizerName}{game.distanceMiles !== null && ' · ' + game.distanceMiles.toFixed(1) + ' mi away'}</p>
        <ParticipationActions game={game} access={game} />
      </div>)}</div>}
  </>
}
