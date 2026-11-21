import { CalendarDays, CalendarPlus, Mail, MapPin, Search } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { GameAdministration, TeamRoster } from '../components/GameManagement'
import { MatchResults } from '../components/MatchResults'
import { GameCard, LoadError, Notice, PageTitle, SportBadge } from '../components/ui'
import { errorMessage, useResource } from '../hooks/useResource'
import { formatGameTime, tampaInput, tampaToIso } from '../lib/time'
import { pickup } from '../services'
import { isUpcoming, neighborhoods, sports } from '../types/domain'
import type { GameSummary, InboxItem, Neighborhood, Profile, Response, Session, Sport } from '../types/domain'

function GameList({ title, games, empty }: { title: string; games: GameSummary[]; empty: string }) {
  return (
    <section className="section-stack">
      <h2>{title}</h2>
      {games.length ? <div className="card-grid">{games.map(game => <GameCard key={game.id} game={game} />)}</div> : <Notice>{empty}</Notice>}
    </section>
  )
}

function MyGameLists({ games, userId }: { games: GameSummary[]; userId: string }) {
  const upcoming = games.filter(isUpcoming)
  const completed = games.filter(game => game.status === 'completed').reverse()
  const inactive = games.filter(game => !isUpcoming(game) && game.status !== 'completed').reverse()
  return (
    <>
      <GameList title="Upcoming · You organize" games={upcoming.filter(game => game.organizerId === userId)} empty="You haven’t organized an upcoming game." />
      <GameList title="Upcoming · You’ve joined" games={upcoming.filter(game => game.organizerId !== userId)} empty="Accepted game invitations will appear here." />
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
      {games.state.status === 'ready' && <GameList title="Coming up" games={games.state.data.filter(isUpcoming).slice(0, 3)} empty="Your next organized or joined game will appear here." />}
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

export function CreateGame() {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const navigate = useNavigate()
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setError('')
    setBusy(true)
    try {
      const gameId = await pickup.createGame({
        title: String(form.get('title')),
        sport: String(form.get('sport')) as Sport,
        venue: String(form.get('venue')),
        neighborhood: String(form.get('neighborhood')) as Neighborhood,
        startsAt: tampaToIso(String(form.get('startsAt'))),
        maxPlayers: Number(form.get('capacity')),
      })
      navigate(`/games/${gameId}`, { replace: true })
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle title="Create a game" subtitle="Set the details, then invite players to fill the open spots." />
      <form className="card form-stack editor" onSubmit={submit}>
        <label>Game title<input name="title" required maxLength={80} placeholder="Saturday 5-a-side soccer" /></label>
        <div className="form-grid">
          <label>Sport<select name="sport" required defaultValue="">
            <option value="" disabled>Choose a sport</option>
            {Object.entries(sports).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label>Maximum players<input name="capacity" type="number" required min="2" max="50" defaultValue="10" /><span className="field-hint">Includes you as the organizer.</span></label>
        </div>
        <label>Venue<input name="venue" required maxLength={100} placeholder="Park, field, or court name" /></label>
        <label>Game neighborhood<select name="neighborhood" required defaultValue="">
          <option value="" disabled>Choose a Tampa area</option>
          {Object.entries(neighborhoods).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Start date and time (Tampa time)<input name="startsAt" type="datetime-local" required min={tampaInput(new Date())} /></label>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="button primary self-start" disabled={busy}>{busy ? 'Creating game…' : 'Create game'}</button>
      </form>
    </>
  )
}

export function GameDetail({ session }: { session: Session }) {
  const { id = '' } = useParams()
  const { state, retry } = useResource(`${session.userId}:${id}`, () => pickup.getGame(id))
  if (state.status === 'loading') return <Notice>Loading game and roster…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  if (!state.data) return <Notice>This game is unavailable. <Link className="text-link" to="/games">My games</Link></Notice>
  const game = state.data
  const remaining = Math.max(0, game.maxPlayers - game.confirmed)
  const organizer = game.organizerId === session.userId
  const canInvite = organizer && isUpcoming(game) && remaining > 0
  const gameStatus = isUpcoming(game) ? 'Upcoming' : game.status === 'scheduled' ? 'Past' : game.status
  return (
    <>
      <PageTitle title={game.title} action={canInvite && <Link className="button primary"
        to={`/players?match=travel&sport=${game.sport}&neighborhood=${game.neighborhood}&game=${game.id}`}>Find players to invite</Link>} />
      <div className="detail-grid">
        <section className="card form-stack" aria-label="Game details">
          <div className="flex flex-wrap items-center gap-2"><SportBadge sport={game.sport} /><span className="pill capitalize">{gameStatus}</span></div>
          <p className="icon-line"><CalendarDays size={19} aria-hidden="true" />{formatGameTime(game.startsAt)}</p>
          <p className="icon-line"><MapPin size={19} aria-hidden="true" />{game.venue} · {neighborhoods[game.neighborhood]}</p>
          <div className="capacity">
            <div className="flex flex-wrap justify-between gap-2"><strong>{game.confirmed} of {game.maxPlayers} confirmed</strong>
              {isUpcoming(game) && <span>{remaining} {remaining === 1 ? 'spot' : 'spots'} open</span>}
            </div>
            <progress value={game.confirmed} max={game.maxPlayers} aria-label="Confirmed players" />
          </div>
        </section>
        <TeamRoster key={game.id} game={game} organizer={organizer} />
      </div>
      <MatchResults key={`result:${game.id}`} game={game} userId={session.userId} />
      {organizer && <GameAdministration key={`manage:${game.id}`} game={game} />}
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
      <p className="muted">Invited by {item.senderName}</p>
      <p className="icon-line"><CalendarDays size={17} aria-hidden="true" />{formatGameTime(item.game.startsAt)}</p>
      <p className="icon-line"><MapPin size={17} aria-hidden="true" />{item.game.venue} · {neighborhoods[item.game.neighborhood]}</p>
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
  return (
    <>
      {confirmation && <Notice tone="success">{confirmation} {showGamesLink && <Link className="text-link" to="/games">My games</Link>}</Notice>}
      {state.status === 'loading' && <Notice>Loading invitations…</Notice>}
      {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
      {state.status === 'ready' && (state.data.length
        ? <div className="card-grid">{state.data.map(item => <PendingInvitation key={item.id} item={item} onResponse={setConfirmation} />)}</div>
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
