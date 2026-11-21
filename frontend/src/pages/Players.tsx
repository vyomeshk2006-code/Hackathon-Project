import { MapPin, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { AccountFields } from '../components/AccountFields'
import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { PlayerRecord, Rating } from '../components/PlayerRecord'
import { InviteReport, TeamPicker } from '../components/GameManagement'
import { SportPicker, useCatalog } from '../components/SportPicker'
import { ActionNotice } from '../components/ActionNotice'
import { useAction } from '../hooks/useAction'
import { Avatar, LoadError, Notice, PageTitle, SportBadge } from '../components/ui'
import { errorMessage, useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { defaultPreferences, isActiveGame, isUpcoming, skills, sportName, statLabel } from '../types/domain'
import type { BulkInviteResult, PlayerFilters, Preference, Profile, Session, Skill, Team } from '../types/domain'


export function Discovery({ session }: { session: Session }) {
  const catalog = useCatalog()
  const [params, setParams] = useSearchParams()
  const [selected, setSelected] = useState<string[]>([])
  const [team, setTeam] = useState<Team | null>(null)
  const [report, setReport] = useState<{ results: BulkInviteResult[]; names: Record<string, string> } | null>(null)
  const action = useAction()
  const selectedSport = params.get('sport')
  const selectedSkill = params.get('skill') as Skill | null
  const sport = selectedSport && catalog.some(item => item.slug === selectedSport) ? selectedSport : undefined
  const skill = selectedSkill && Object.hasOwn(skills, selectedSkill) ? selectedSkill : undefined
  const gameId = params.get('game') || undefined
  const name = params.get('name') ?? ''
  const replacement = params.get('replacement') === '1'
  const filters: PlayerFilters = { sport, skill, gameId, name, replacement }
  const { state, retry } = useResource(`${session.userId}:${params}`, () => pickup.findPlayers(filters))

  const visible = state.status === 'ready' ? state.data : []
  const selectedVisible = visible.filter(player => selected.includes(player.id))
  const statFields = catalog.find(item => item.slug === sport)?.fields ?? []

  function updateFilter(field: string, value: string) {
    const next = new URLSearchParams(params)
    if (value) next.set(field, value)
    else next.delete(field)
    setParams(next, { replace: true })
  }

  return (
    <>
      <PageTitle title={replacement ? "Find replacement players" : "Find players"} subtitle="Search by name, sport, or skill level." />
      <div className="card filter-bar discovery-filters">
        <span className="filter-heading"><SlidersHorizontal size={19} aria-hidden="true" /> Filters</span>
        <label>Player name<input value={name} onChange={event => updateFilter('name', event.target.value)} placeholder="Search by name" /></label>
        <label>Sport<select value={sport ?? ''} onChange={event => updateFilter('sport', event.target.value)}>
          <option value="">All sports</option>
          {catalog.map(item => <option key={item.slug} value={item.slug}>{item.name}</option>)}
        </select></label>
        <label>Skill level<select value={skill ?? ''} onChange={event => updateFilter('skill', event.target.value)}>
          <option value="">Any skill</option>
          {Object.entries(skills).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
      </div>
      {gameId && <section className="card form-stack">
        <div className="flex flex-wrap gap-3 items-end">
          <TeamPicker team={team} onChange={setTeam} />
          <button className="button primary" disabled={action.pending || selectedVisible.length === 0} onClick={() => void action.run(async () => {
            const results = await pickup.inviteMany(gameId, selectedVisible.map(player => player.id), team)
            setReport({ results, names: Object.fromEntries(selectedVisible.map(player => [player.id, player.displayName])) })
            setSelected([])
          }, '')}>Invite selected ({selectedVisible.length})</button>
          <Link className="text-link" to={'/games/' + gameId}>Back to game</Link>
        </div>
        <ActionNotice {...action} />
        {report && <InviteReport {...report} />}
      </section>}
      {state.status === 'loading' && <Notice>Finding players…</Notice>}
      {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
      {state.status === 'ready' && (
        <>
          <p className="result-count" role="status">{state.data.length} {state.data.length === 1 ? 'player' : 'players'} found</p>
          {!state.data.length && <Notice>No players match these filters.</Notice>}
          <div className="card-grid">
            {state.data.map(profile => (
              <article className="card player-card" key={profile.id}>
                <div className="flex items-center gap-3">
                  <Avatar name={profile.displayName} />
                  <div><h2>{profile.displayName}</h2><p className="icon-line"><MapPin size={15} aria-hidden="true" />{profile.neighborhood}</p></div>
                </div>
                {profile.username && <p className="muted">@{profile.username}</p>}
                <Rating profile={profile} />
                <p className="muted">{profile.stats.gamesPlayed} played · {profile.stats.wins} wins · {profile.stats.losses} losses</p>
                {sport && statFields.length > 0 && <p className="muted">{statFields.map(field =>
                  statLabel(field) + ' ' + (profile.sportStats.find(stats => stats.sport === sport)?.metrics[field] ?? 0)).join(' · ')}</p>}
                <ul className="skill-list">
                  {profile.sports.map(({ sport, skill }) => <li key={sport}><SportBadge sport={sport} /><span>{skills[skill]}</span></li>)}
                </ul>
                {gameId && <label className="check-label flex gap-2 items-center"><input type="checkbox"
                  checked={selected.includes(profile.id)} disabled={action.pending || (selected.length >= 25 && !selected.includes(profile.id))}
                  onChange={event => {
                    const checked = event.target.checked
                    setSelected(current => checked ? [...current, profile.id] : current.filter(id => id !== profile.id))
                  }} /> Select {profile.displayName} to invite</label>}
                <Link className="button secondary" to={`/players/${profile.id}?${params}`}>View profile<span className="sr-only"> for {profile.displayName}</span></Link>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  )
}

export function ProfileEditor({ profile, settings = false }: { profile: Profile | null; settings?: boolean }) {
  const navigate = useNavigate()
  const catalog = useCatalog()
  const [selectedSport, setSport] = useState('')
  const [preferences, setPreferences] = useState<Preference[]>(profile?.sports ?? [])
  const account = useResource('settings-account:' + (profile?.id ?? 'new'), () => pickup.getAccountDetails())
  const [savedMessage, setSavedMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    setSavedMessage('')
    const form = new FormData(event.currentTarget)
    try {
      const saved = await pickup.saveProfile({
        displayName: String(form.get('name')), neighborhood: String(form.get('neighborhood')),
        username: String(form.get('username')), phoneNumber: String(form.get('phone')),
        bio: String(form.get('bio')), sports: preferences,
        notificationPreferences: { replacementAlerts: form.has('replacementAlerts'), newGameAlerts: form.has('newGameAlerts') },
      })
      if (settings) setSavedMessage('Account settings saved.')
      else navigate(profile ? '/players/' + saved.id : '/home', { replace: true })
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageTitle title={settings ? 'Settings' : profile ? 'Edit your profile' : 'Create your player profile'} />
      {account.state.status === 'loading' && <Notice>Loading account details…</Notice>}
      {account.state.status === 'error' && <LoadError error={account.state.error} retry={account.retry} />}
      {account.state.status === 'ready' && <form className="card form-stack editor" onSubmit={submit}>
        <AccountFields profile={profile} phoneNumber={account.state.data.phoneNumber} />
        <label>Bio (optional)<textarea name="bio" rows={3} defaultValue={profile?.bio} maxLength={300} placeholder="When and where do you like to play?" /></label>
        <fieldset>
          <legend>Sports and skill levels</legend>
          <div className="form-stack">
            <SportPicker key={preferences.length} value={selectedSport} onChange={setSport} create />
            <button className="button secondary self-start" type="button" disabled={!selectedSport || preferences.some(item => item.sport === selectedSport)}
              onClick={() => {
                const existing = profile?.sports.find(item => item.sport === selectedSport)
                setPreferences(current => [...current, existing ?? { sport: selectedSport, skill: 'beginner' }])
                setSport('')
              }}>Add sport to profile</button>
            <div className="preference-grid">{preferences.map(preference => {
              const label = sportName(preference.sport, catalog)
              return <div className="preference-option" key={preference.sport}>
                <label>{label} skill level<select value={preference.skill} onChange={event => {
                  const skill = event.target.value as Skill
                  setPreferences(current => current.map(item => item.sport === preference.sport ? { ...item, skill } : item))
                }}>{Object.entries(skills).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
                <p className="muted">Self-declared</p>
                <button type="button" className="text-link self-start" onClick={() =>
                  setPreferences(current => current.filter(item => item.sport !== preference.sport))}>Remove {label}</button>
              </div>
            })}</div>
          </div>
        </fieldset>
        <fieldset className="form-stack">
          <legend>Notification preferences</legend>
          <label className="check-label"><input type="checkbox" name="replacementAlerts" defaultChecked={profile?.notificationPreferences?.replacementAlerts ?? defaultPreferences.replacementAlerts} /> Emergency replacement alerts</label>
          <label className="check-label"><input type="checkbox" name="newGameAlerts" defaultChecked={profile?.notificationPreferences?.newGameAlerts ?? defaultPreferences.newGameAlerts} /> New games for my sports</label>
        </fieldset>
        {error && <Notice tone="error">{error}</Notice>}
        {savedMessage && <Notice tone="success">{savedMessage}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button className="button primary" disabled={busy || !preferences.length}>{busy ? 'Saving…' : 'Save profile'}</button>
          {profile && <Link className="button secondary" to={`/players/${profile.id}`}>Cancel</Link>}
        </div>
      </form>}
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
  const [team, setTeam] = useState<Team | null>(null)
  const games = state.status === 'ready' ? state.data.filter(game => game.organizerId === session.userId && isActiveGame(game) && isUpcoming(game) &&
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
      await pickup.invite(availableGame.id, player.id, team)
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
        <TeamPicker team={team} onChange={setTeam} />
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
            <div>{profile.username && <p className="muted">@{profile.username}</p>}
              <p className="icon-line"><MapPin size={17} aria-hidden="true" />{profile.neighborhood}</p></div>
          </div>
          {profile.bio && <p>{profile.bio}</p>}
          <h2>Sports</h2>
          <ul className="skill-list">
            {profile.sports.map(({ sport, skill }) => <li key={sport}><SportBadge sport={sport} /><span>{skills[skill]} · Self-declared</span></li>)}
          </ul>
        </section>
        {!own && <InvitePlayer key={id} player={profile} session={session} />}
      </div>
      <PlayerRecord profile={profile} />
    </>
  )
}
