import { CalendarDays, CalendarPlus, Mail, MapPin, Search } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { GameAdministration, TeamRoster, WithdrawGame } from '../components/GameManagement'
import { GameContacts } from '../components/GameContacts'
import { SportPicker } from '../components/SportPicker'
import { ParticipationActions } from './Browse'
import { MatchResults } from '../components/MatchResults'
import { GameCard, LoadError, Notice, PageTitle, SportBadge, VenueDetails } from '../components/ui'
import { useGameClock } from '../hooks/useGameClock'
import { errorMessage, useResource } from '../hooks/useResource'
import { formatGameTime, tampaInput, tampaToIso } from '../lib/time'
import { pickup } from '../services'
import { isActiveGame, isUpcoming, skills } from '../types/domain'
import type { Game, GameEdit, GameSummary, InboxItem, Profile, Response, Session, Skill, Visibility } from '../types/domain'

function GameList({ title, games, empty }: { title: string; games: GameSummary[]; empty: string }) {
  return (
    <section className="section-stack">
      <h2>{title}</h2>
      {games.length ? <div className="card-grid">{games.map(game => <GameCard key={game.id} game={game} />)}</div> : <Notice>{empty}</Notice>}
    </section>
  )
}

function MyGameLists({ games, userId }: { games: GameSummary[]; userId: string }) {
  const now = useGameClock(games.flatMap(game => [game.startsAt, game.endsAt]))
  const upcoming = games.filter(game => isUpcoming(game, now))
  const ongoing = games.filter(game => isActiveGame(game, now) && !isUpcoming(game, now))
  const completed = games.filter(game => game.status === 'completed').reverse()
  const inactive = games.filter(game => !isUpcoming(game, now) && !isActiveGame(game, now) && game.status !== 'completed').reverse()
  return (
    <>
      <GameList title="Upcoming · You organize" games={upcoming.filter(game => game.organizerId === userId)} empty="You haven’t organized an upcoming game." />
      <GameList title="Upcoming · You’ve joined" games={upcoming.filter(game => game.organizerId !== userId)} empty="Accepted game invitations will appear here." />
      {!!ongoing.length && <GameList title="Ongoing games" games={ongoing} empty="" />}
      {!!completed.length && <GameList title="Completed games" games={completed} empty="" />}
      {!!inactive.length && <GameList title="Past and cancelled games" games={inactive} empty="" />}
    </>
  )
}

export function Dashboard({ session, profile }: { session: Session; profile: Profile }) {
  const games = useResource(session.userId, () => pickup.myGames())
  const inbox = useResource(session.userId, () => pickup.inbox())
  return (
    <>
      <section className="dashboard-banner">
        <div>
          <p><MapPin size={16} aria-hidden="true" /> Tampa, Florida</p>
          <h1>Welcome, {profile.displayName.split(/\s+/)[0]}.</h1>
          <p>Ready for your next pickup game?</p>
        </div>
        <Link className="button primary" to="/games/new"><CalendarPlus size={18} aria-hidden="true" /> Create a game</Link>
      </section>
      <div className="dashboard-links">
        <Link className="card quick-link" to="/players"><Search aria-hidden="true" /><span><strong>Find players</strong><small>Browse local players by sport and neighborhood</small></span></Link>
        <Link className="card quick-link" to="/invitations"><Mail aria-hidden="true" /><span><strong>Invitations</strong><small>{inbox.state.status === 'ready' ? `${inbox.state.data.length} pending` : 'Open your inbox'}</small></span></Link>
      </div>
      {games.state.status === 'loading' && <Notice>Loading your games…</Notice>}
      {games.state.status === 'error' && <LoadError error={games.state.error} retry={games.retry} />}
      {games.state.status === 'ready' && <GameList title="Coming up" games={games.state.data.filter(game => isUpcoming(game)).slice(0, 3)} empty="Your next organized or joined game will appear here." />}
    </>
  )
}

export function MyGames({ session }: { session: Session }) {
  const { state, retry } = useResource(session.userId, () => pickup.myGames())
  return (
    <>
      <PageTitle title="My games" action={<Link className="button primary" to="/games/new"><CalendarPlus size={18} aria-hidden="true" /> Create a game</Link>} />
      {state.status === 'loading' && <Notice>Loading your games…</Notice>}
      {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
      {state.status === 'ready' && <MyGameLists games={state.data} userId={session.userId} />}
      <section className="section-stack">
        <h2>Pending invitations</h2>
        <InvitationList session={session} />
      </section>
    </>
  )
}


export function CreateGame() { return <GameForm /> }

export function EditGame({ session }: { session: Session }) {
  const { id = '' } = useParams()
  const { state, retry } = useResource('edit:' + session.userId + ':' + id, () => pickup.getGame(id))
  if (state.status === 'loading') return <Notice>Loading game…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  const game = state.data
  if (!game || game.organizerId !== session.userId || !isUpcoming(game)) {
    return <Notice>Game editing is available to organizers before kickoff. <Link className="text-link" to="/games">My games</Link></Notice>
  }
  return <GameForm key={game.id} existing={game} />
}

function GameForm({ existing }: { existing?: Game }) {
  const [sport, setSport] = useState('')
  const [teamSize, setTeamSize] = useState('5')
  const initialStart = existing ? tampaInput(new Date(existing.startsAt)).split('T') : []
  const initialEnd = existing?.endsAt ? tampaInput(new Date(existing.endsAt)).split('T') : []
  const [date, setDate] = useState(initialStart[0] ?? '')
  const [endDate, setEndDate] = useState(initialEnd[0] ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    try {
      const input: GameEdit = {
        title: String(form.get('title')), venue: String(form.get('venue')), venueAddress: String(form.get('address')),
        description: String(form.get('description')),
        startsAt: tampaToIso(date + 'T' + String(form.get('time'))),
        endsAt: tampaToIso((endDate || date) + 'T' + String(form.get('endTime'))),
      }
      if (Date.parse(input.endsAt) <= Date.parse(input.startsAt)) throw new Error('Choose an end time after the start.')
      if (existing) {
        await pickup.editGame(existing.id, input)
        navigate('/games/' + existing.id, { replace: true })
      } else {
        const id = await pickup.createGame({
          ...input, sport, maxPlayers: Number(teamSize) * 2, teamSize: Number(teamSize),
          joinMode: String(form.get('joinMode')) as Visibility,
          skillLevel: (String(form.get('skill')) || null) as Skill | null,
        })
        navigate('/games/' + id, { replace: true })
      }
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return <>
    <PageTitle title={existing ? 'Edit game' : 'Create a game'} subtitle={existing ? 'Update the schedule and venue before kickoff.' : 'Set the venue and schedule so players know where and when to meet.'} />
    <form className="card form-stack editor" onSubmit={submit}>
      <label>Game title<input name="title" required maxLength={80} defaultValue={existing?.title} /></label>
      {!existing && <>
        <SportPicker value={sport} onChange={setSport} create />
        <div className="form-grid">
          <label>Game type<select name="joinMode" defaultValue="open"><option value="open">Open</option><option value="invite_only">Invite-only</option></select></label>
          <label>Skill level<select name="skill"><option value="">All levels</option>
            {Object.entries(skills).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select></label>
          <label>Players per team<input type="number" min="1" max="25" required value={teamSize} onChange={event => setTeamSize(event.target.value)} /></label>
          <label>Maximum players<input value={teamSize ? Number(teamSize) * 2 : ''} readOnly /><span className="field-hint">Includes the organizer.</span></label>
        </div>
      </>}
      <label>Venue name<input name="venue" required maxLength={100} defaultValue={existing?.venue} /></label>
      <label>Exact venue address<input name="address" required minLength={3} maxLength={200} defaultValue={existing?.venueAddress}
        placeholder="Street address or unambiguous venue location" /></label>
      <div className="form-grid">
        <label>Game date (Tampa time)<input type="date" required min={tampaInput(new Date()).slice(0, 10)} value={date} onChange={event => setDate(event.target.value)} /></label>
        <label>Start time (Tampa time)<input name="time" type="time" required defaultValue={initialStart[1]} /></label>
        <label>End date (Tampa time)<input type="date" required min={date} value={endDate || date} onChange={event => setEndDate(event.target.value)} /></label>
        <label>End time (Tampa time)<input name="endTime" type="time" required defaultValue={initialEnd[1]} /></label>
      </div>
      <label>Description (optional)<textarea rows={3} name="description" maxLength={500} defaultValue={existing?.description} /></label>
      {!existing && !sport && <p className="muted">Select a suggested sport or choose “Use custom sport.”</p>}
      {error && <Notice tone="error">{error} {error.includes('Settings') && <Link className="text-link" to="/settings">Settings</Link>}</Notice>}
      <button className="button primary self-start" disabled={busy || (!existing && !sport)}>
        {busy ? 'Saving…' : existing ? 'Save game changes' : 'Create game'}
      </button>
    </form>
  </>
}

export function GameDetail({ session }: { session: Session }) {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const { state, retry } = useResource(`${session.userId}:${id}`, () => pickup.getGame(id))
  const clock = useGameClock(state.status === 'ready' && state.data ? [state.data.startsAt, state.data.endsAt] : [])
  if (state.status === 'loading') return <Notice>Loading game and roster…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  if (!state.data) return <Notice>This game is unavailable. <Link className="text-link" to="/games">My games</Link></Notice>
  const game = state.data
  const remaining = Math.max(0, game.maxPlayers - game.confirmed)
  const organizer = game.organizerId === session.userId
  const upcoming = isUpcoming(game, clock)
  const active = isActiveGame(game, clock)
  const canInvite = organizer && upcoming && active && remaining > 0
  const playerSearch = new URLSearchParams({ sport: game.sport, game: game.id })
  const replacements = new URLSearchParams(playerSearch)
  replacements.set('replacement', '1')
  if (game.skillLevel) replacements.set('skill', game.skillLevel)
  const gameStatus = upcoming ? 'Upcoming' : active ? 'Ongoing' : game.status === 'scheduled' ? 'Past' : game.status
  return (
    <>
      <PageTitle title={game.title} action={<div className="flex flex-wrap gap-2">
        {organizer && upcoming && <Link className="button secondary" to={'/games/' + game.id + '/edit'}>Edit game</Link>}
        {canInvite && <>
        <Link className="button primary" to={'/players?' + playerSearch}>Find players to invite</Link>
        <Link className="button secondary" to={'/players?' + replacements}>Find replacement</Link>
        </>}
      </div>} />
      <div className="detail-grid">
        <section className="card form-stack" aria-label="Game details">
          <div className="flex flex-wrap items-center gap-2"><SportBadge sport={game.sport} /><span className="pill capitalize">{gameStatus}</span></div>
          <p className="muted">{game.joinMode === 'open' ? 'Open game' : 'Invite-only'} · {game.skillLevel ? skills[game.skillLevel] : 'All levels'}
            {game.teamSize && ' · ' + game.teamSize + 'v' + game.teamSize}</p>
          <p className="icon-line"><CalendarDays size={19} aria-hidden="true" />{formatGameTime(game.startsAt)}</p>
          <VenueDetails venue={game.venue} address={game.venueAddress} />
          {game.endsAt ? <p className="muted">Ends {formatGameTime(game.endsAt)}</p> : <Notice>Organizer: add an exact address and end time to list this legacy game.</Notice>}
          {game.description && <p>{game.description}</p>}
          <div className="capacity">
            <div className="flex flex-wrap justify-between gap-2"><strong>{game.confirmed} of {game.maxPlayers} confirmed</strong>
              {upcoming && active && <span>{remaining} {remaining === 1 ? 'spot' : 'spots'} open</span>}
            </div>
            <progress value={game.confirmed} max={game.maxPlayers} aria-label="Confirmed players" />
          </div>
          {!organizer && active && <ParticipationActions game={game} access={game.participation} allowClaim />}
          {!organizer && game.participation.isMember && upcoming && <WithdrawGame game={game} />}
        </section>
        <TeamRoster key={game.id} game={game} organizer={organizer} />
      </div>
      {active && (organizer || game.participation.isMember) && <GameContacts key={game.id} gameId={game.id} userId={session.userId} />}
      <MatchResults key={`result:${game.id}`} game={game} userId={session.userId} />
      {organizer && <GameAdministration key={`manage:${game.id}`} game={game} session={session} focusRequest={params.get('request')} />}
    </>
  )
}

function PendingInvitation({ item, onResponse }: { item: InboxItem; onResponse: (message: string) => void }) {
  const [busy, setBusy] = useState<Response>()
  const [error, setError] = useState('')
  const full = item.game.confirmed >= item.game.maxPlayers
  async function respond(response: Response) {
    setError('')
    setBusy(response)
    try {
      await pickup.respond(item.id, response)
      onResponse(response === 'accepted' ? `You joined ${item.game.title}.` : `You declined ${item.game.title}.`)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(undefined)
    }
  }
  return (
    <article className="card form-stack">
      <SportBadge sport={item.game.sport} />
      <h2><Link className="card-link" to={`/games/${item.gameId}`}>{item.game.title}</Link></h2>
      <p className="muted">Invited by {item.senderName}{item.team && ' · Team ' + item.team}</p>
      <p className="icon-line"><CalendarDays size={17} aria-hidden="true" />{formatGameTime(item.game.startsAt)}</p>
      <VenueDetails venue={item.game.venue} address={item.game.venueAddress} />
      {full && <Notice>This game is full.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex flex-wrap gap-2">
        <button className="button primary" disabled={!!busy || full} onClick={() => void respond('accepted')}>{busy === 'accepted' ? 'Accepting…' : 'Accept'}</button>
        <button className="button secondary" disabled={!!busy} onClick={() => void respond('declined')}>{busy === 'declined' ? 'Declining…' : 'Decline'}</button>
      </div>
    </article>
  )
}

function InvitationList({ session, showGamesLink = false }: { session: Session; showGamesLink?: boolean }) {
  const { state, retry } = useResource(session.userId, () => pickup.inbox())
  const [confirmation, setConfirmation] = useState('')
  const [params] = useSearchParams()
  const selected = showGamesLink ? params.get('invitation') : null
  return (
    <>
      {confirmation && <Notice tone="success">{confirmation} {showGamesLink && <Link className="text-link" to="/games">My games</Link>}</Notice>}
      {state.status === 'loading' && <Notice>Loading invitations…</Notice>}
      {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
      {state.status === 'ready' && (state.data.length
        ? <div className="card-grid">{[...state.data].sort((a, b) => Number(b.id === selected) - Number(a.id === selected)).map(item => <PendingInvitation key={item.id} item={item} onResponse={setConfirmation} />)}</div>
        : <Notice>You have no pending invitations.</Notice>)}
    </>
  )
}

export function Invitations({ session }: { session: Session }) {
  return (
    <>
      <PageTitle title="Invitations" subtitle="Respond to invitations from Tampa game organizers." />
      <InvitationList session={session} showGamesLink />
    </>
  )
}
