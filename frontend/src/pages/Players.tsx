import { MapPin, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PlayerRecord, Rating } from '../components/PlayerRecord'
import { Avatar, LoadError, Notice, PageTitle, SportBadge } from '../components/ui'
import { errorMessage, useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { isUpcoming, neighborhoods, skills, sports } from '../types/domain'
import type { Neighborhood, PlayerFilters, Preference, Profile, Session, Skill, Sport } from '../types/domain'

const sportOptions = Object.entries(sports) as [Sport, string][]
const neighborhoodOptions = Object.entries(neighborhoods) as [Neighborhood, string][]

export function Discovery({ session }: { session: Session }) {
  const [params, setParams] = useSearchParams()
  const selectedSport = params.get('sport') as Sport | null
  const selectedNeighborhood = params.get('neighborhood') as Neighborhood | null
  const selectedSkill = params.get('skill') as Skill | null
  const sport = selectedSport && Object.hasOwn(sports, selectedSport) ? selectedSport : undefined
  const neighborhood = selectedNeighborhood && Object.hasOwn(neighborhoods, selectedNeighborhood) ? selectedNeighborhood : undefined
  const skill = selectedSkill && Object.hasOwn(skills, selectedSkill) ? selectedSkill : undefined
  const gameId = params.get('game') || undefined
  const travel = params.get('match') === 'travel'
  const filters: PlayerFilters | null = travel
    ? sport && neighborhood ? { match: 'travel', sport, neighborhood, skill, gameId } : null
    : { match: 'exact', sport, neighborhood, skill, gameId }
  const { state, retry } = useResource(`${session.userId}:${params}`, () => filters ? pickup.findPlayers(filters) : Promise.resolve([]))

  function updateFilter(field: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(field, value)
    else next.delete(field)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageTitle title="Find players" subtitle="Search a neighborhood or find players whose travel radius reaches your game." />
      <div className="card filter-bar discovery-filters">
        <span className="filter-heading"><SlidersHorizontal size={19} aria-hidden="true" /> Filters</span>
        <label>Match by<select value={travel ? 'travel' : 'exact'} onChange={event => updateFilter('match', event.target.value)}>
          <option value="exact">Home neighborhood</option>
          <option value="travel">Player travel radius</option>
        </select></label>
        <label>Sport<select value={sport ?? ''} onChange={event => updateFilter('sport', event.target.value)}>
          <option value="">{travel ? 'Choose a sport' : 'All sports'}</option>
          {sportOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>{travel ? 'Game neighborhood' : 'Home neighborhood'}<select value={neighborhood ?? ''} onChange={event => updateFilter('neighborhood', event.target.value)}>
          <option value="">{travel ? 'Choose the game area' : 'All Tampa areas'}</option>
          {neighborhoodOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Skill level<select value={skill ?? ''} onChange={event => updateFilter('skill', event.target.value)}>
          <option value="">Any skill</option>
          {Object.entries(skills).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
      </div>
      {!filters && <Notice>Choose a sport and a game neighborhood to search by travel radius.</Notice>}
      {filters && state.status === 'loading' && <Notice>Finding players…</Notice>}
      {filters && state.status === 'error' && <LoadError error={state.error} retry={retry} />}
      {filters && state.status === 'ready' && (
        <>
          <p className="result-count" role="status">{state.data.length} {state.data.length === 1 ? 'player' : 'players'} found</p>
          {!state.data.length && <Notice>No players match these filters. Try another sport or neighborhood.</Notice>}
          <div className="card-grid">
            {state.data.map(profile => (
              <article className="card player-card" key={profile.id}>
                <div className="flex items-center gap-3">
                  <Avatar name={profile.displayName} />
                  <div><h2>{profile.displayName}</h2><p className="icon-line"><MapPin size={15} aria-hidden="true" />{neighborhoods[profile.neighborhood]}</p></div>
                </div>
                <p className="muted">{profile.distanceMiles !== undefined && `${profile.distanceMiles.toFixed(1)} mi from game area · `}
                  Travels up to {profile.travelRadiusMiles} mi</p>
                <Rating profile={profile} />
                <ul className="skill-list">
                  {profile.sports.map(({ sport, skill }) => <li key={sport}><SportBadge sport={sport} /><span>{skills[skill]}</span></li>)}
                </ul>
                <Link className="button secondary" to={`/players/${profile.id}?${params}`}>View profile<span className="sr-only"> for {profile.displayName}</span></Link>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  )
}

export function ProfileEditor({ profile }: { profile: Profile | null }) {
  const navigate = useNavigate()
  const [preferences, setPreferences] = useState<Preference[]>(profile?.sports ?? [])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  function toggleSport(sport: Sport, checked: boolean) {
    setPreferences(current => checked
      ? [...current, { sport, skill: 'beginner' }]
      : current.filter(preference => preference.sport !== sport))
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const saved = await pickup.saveProfile({
        displayName: String(form.get('name')), neighborhood: String(form.get('neighborhood')) as Neighborhood,
        travelRadiusMiles: Number(form.get('radius')), bio: String(form.get('bio')), sports: preferences,
      })
      navigate(profile ? `/players/${saved.id}` : '/home', { replace: true })
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle title={profile ? 'Edit your profile' : 'Create your player profile'} subtitle="Share the sports you play and your general area in Tampa." />
      <form className="card form-stack editor" onSubmit={submit}>
        <label>Display name<input name="name" defaultValue={profile?.displayName} required maxLength={60} autoComplete="nickname" /></label>
        <div className="form-grid">
          <label>Neighborhood<select name="neighborhood" required defaultValue={profile?.neighborhood ?? ''}>
            <option value="" disabled>Choose a Tampa area</option>
            {neighborhoodOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select></label>
          <label>Travel radius (miles)<input name="radius" type="number" min="1" max="50" defaultValue={profile?.travelRadiusMiles ?? 10} required /></label>
        </div>
        <label>Bio (optional)<textarea name="bio" rows={3} defaultValue={profile?.bio} maxLength={300} placeholder="When and where do you like to play?" /></label>
        <fieldset>
          <legend>Sports and skill levels</legend>
          <div className="preference-grid">
            {sportOptions.map(([sport, name]) => {
              const selected = preferences.find(preference => preference.sport === sport)
              return (
                <div className="preference-option" key={sport}>
                  <label className="check-label">
                    <input type="checkbox" checked={!!selected} onChange={event => toggleSport(sport, event.target.checked)} />
                    {name}
                  </label>
                  {selected && <label>{name} skill level<select value={selected.skill} onChange={event => {
                    const skill = event.target.value as Skill
                    setPreferences(current => current.map(preference => preference.sport === sport ? { sport, skill } : preference))
                  }}>{Object.entries(skills).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>}
                </div>
              )
            })}
          </div>
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button className="button primary" disabled={busy}>{busy ? 'Saving…' : 'Save profile'}</button>
          {profile && <Link className="button secondary" to={`/players/${profile.id}`}>Cancel</Link>}
        </div>
      </form>
    </>
  )
}

function InvitePlayer({ player, session }: { player: Profile; session: Session }) {
  const { state, retry } = useResource(session.userId, () => pickup.myGames())
  const [params] = useSearchParams()
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sentTo, setSentTo] = useState('')
  const games = state.status === 'ready' ? state.data.filter(game => game.organizerId === session.userId && isUpcoming(game) &&
    game.confirmed < game.maxPlayers && player.sports.some(preference => preference.sport === game.sport)) : []
  const gameId = selected || games.find(game => game.id === params.get('game'))?.id || (games.length === 1 ? games[0].id : '')
  const availableGame = games.find(game => game.id === gameId)
  const detail = useResource(`invite:${session.userId}:${availableGame?.id}`, () => availableGame ? pickup.getGame(availableGame.id) : Promise.resolve(null))
  if (state.status === 'loading') return <Notice>Loading your games…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />

  const game = detail.state.status === 'ready' ? detail.state.data : null
  const latest = game?.sentInvitations.find(invite => invite.recipientId === player.id)
  const blocked = game?.roster.some(member => member.id === player.id) ? 'This player is on the roster.' :
    latest?.status === 'pending' ? 'This player already has a pending invitation.' :
    latest?.status === 'declined' ? 'This player declined their invitation for this game.' : ''

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!availableGame || !game || blocked) return
    setBusy(true)
    setError('')
    setSentTo('')
    try {
      await pickup.invite(availableGame.id, player.id)
      setSentTo(availableGame.title)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card form-stack" aria-labelledby="invite-header">
      <h2 id="invite-header">Invite to a game</h2>
      {games.length ? <form className="form-stack" onSubmit={send}>
        <label>Your game<select required value={availableGame?.id ?? ''} onChange={event => {
          setSelected(event.target.value)
          setError('')
          setSentTo('')
        }}>
          <option value="" disabled>Choose a game</option>
          {games.map(game => <option key={game.id} value={game.id}>{game.title}</option>)}
        </select></label>
        {availableGame && detail.state.status === 'loading' && <Notice>Checking invitation status…</Notice>}
        {detail.state.status === 'error' && <LoadError error={detail.state.error} retry={detail.retry} />}
        {blocked && <p className="muted">{blocked}</p>}
        <button className="button primary self-start" disabled={busy || !game || !!blocked}>{busy ? 'Sending…' : 'Send invitation'}</button>
      </form> : <>
        <p className="muted">You don’t have an upcoming game with an open spot for any of this player’s sports.</p>
        <Link className="button secondary self-start" to="/games/new">Create a game</Link>
      </>}
      {error && <Notice tone="error">{error}</Notice>}
      {sentTo && latest?.status === 'pending' && <Notice tone="success">Invitation sent for {sentTo}.</Notice>}
    </section>
  )
}

export function PlayerProfile({ session }: { session: Session }) {
  const { id = '' } = useParams()
  const [params] = useSearchParams()
  const { state, retry } = useResource(`${session.userId}:${id}`, () => pickup.getPlayerDetails(id))
  if (state.status === 'loading') return <Notice>Loading player profile…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  if (!state.data) return <Notice>Player profile unavailable. <Link className="text-link" to="/players">Browse players</Link></Notice>
  const profile = state.data
  const own = session.userId === id
  return (
    <>
      <PageTitle title={profile.displayName} action={own ? <Link className="button secondary" to="/profile/edit">Edit profile</Link> : <Link className="text-link" to={`/players?${params}`}>Back to player search</Link>} />
      <div className="detail-grid">
        <section className="card form-stack" aria-label="Player information">
          <div className="flex items-center gap-3">
            <Avatar name={profile.displayName} />
            <div><p className="icon-line"><MapPin size={17} aria-hidden="true" />{neighborhoods[profile.neighborhood]}</p><p className="muted">Travels up to {profile.travelRadiusMiles} miles</p></div>
          </div>
          {profile.bio && <p>{profile.bio}</p>}
          <h2>Sports</h2>
          <ul className="skill-list">
            {profile.sports.map(({ sport, skill }) => <li key={sport}><SportBadge sport={sport} /><span>{skills[skill]}</span></li>)}
          </ul>
        </section>
        {!own && <InvitePlayer key={id} player={profile} session={session} />}
      </div>
      <PlayerRecord profile={profile} />
    </>
  )
}
