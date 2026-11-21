
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ActionNotice } from '../components/ActionNotice'
import { useCatalog } from '../components/SportPicker'
import { LoadError, Notice, PageTitle, SportBadge } from '../components/ui'
import { useAction } from '../hooks/useAction'
import { useResource } from '../hooks/useResource'
import { pickup } from '../services'
import { sportName } from '../types/domain'
import type { Profile, Session, Squad } from '../types/domain'

function SquadCard({ squad, session }: { squad: Squad; session: Session }) {
  const action = useAction()
  const [confirm, setConfirm] = useState(false)
  const captain = squad.captainId === session.userId
  return <article className="card form-stack">
    <div className="flex flex-wrap gap-2 items-center"><h2>{squad.name}</h2><SportBadge sport={squad.sport} /></div>
    <p>Join code <strong className="join-code">{squad.joinCode}</strong> · {squad.members.length} / 25 members</p>
    <ul className="roster">{squad.members.map(player => <li key={player.id}>
      <Link className="card-link" to={'/players/' + player.id}>{player.displayName}</Link>
      {player.id === squad.captainId && <span className="pill">Captain</span>}
      {captain && player.id !== squad.captainId && <button className="button secondary" disabled={action.pending}
        onClick={() => void action.run(() => pickup.removeSquadMember(squad.id, player.id), 'Member removed.')}
        aria-label={'Remove ' + player.displayName}>Remove</button>}
    </li>)}</ul>
    {captain ? confirm ? <div className="flex flex-wrap items-center gap-2">
      <button className="button secondary" disabled={action.pending} onClick={() => setConfirm(false)}>Keep squad</button>
      <button className="button danger" disabled={action.pending}
        onClick={() => void action.run(() => pickup.deleteSquad(squad.id), 'Squad deleted.')}>Confirm deletion</button>
    </div> : <button className="button danger self-start" onClick={() => setConfirm(true)}>Delete squad</button> :
      <button className="button secondary self-start" disabled={action.pending}
        onClick={() => void action.run(() => pickup.leaveSquad(squad.id), 'You left the squad.')}>Leave squad</button>}
    <ActionNotice {...action} />
  </article>
}

export function Squads({ session, profile }: { session: Session; profile: Profile }) {
  const catalog = useCatalog()
  const { state, retry } = useResource('squads:' + session.userId, () => pickup.mySquads())
  const create = useAction()
  const join = useAction()
  async function submit(event: FormEvent<HTMLFormElement>, mode: 'create' | 'join') {
    event.preventDefault()
    const element = event.currentTarget
    const fields = new FormData(element)
    const action = mode === 'create' ? create : join
    const done = await action.run(() => mode === 'create'
      ? pickup.createSquad(String(fields.get('name')), String(fields.get('sport')))
      : pickup.joinSquad(String(fields.get('code'))), mode === 'create' ? 'Squad created.' : 'You joined the squad.')
    if (done) element.reset()
  }

  return <>
    <PageTitle title="Squads" subtitle="Save a group for one sport and give players a code to join." />
    <div className="detail-grid">
      <form className="card form-stack" onSubmit={event => void submit(event, 'create')}>
        <h2>Create a squad</h2>
        <label>Squad name<input name="name" required maxLength={40} /></label>
        <label>Squad sport<select name="sport" required defaultValue=""><option value="">Choose a sport</option>
          {profile.sports.map(preference => <option key={preference.sport} value={preference.sport}>{sportName(preference.sport, catalog)}</option>)}
        </select></label>
        <button className="button primary self-start" disabled={create.pending}>Create squad</button>
        <ActionNotice {...create} />
      </form>
      <form className="card form-stack" onSubmit={event => void submit(event, 'join')}>
        <h2>Join with a code</h2>
        <label>Squad join code<input name="code" required minLength={8} maxLength={8} autoComplete="off" /></label>
        <button className="button primary self-start" disabled={join.pending}>Join squad</button>
        <ActionNotice {...join} />
      </form>
    </div>
    {state.status === 'loading' && <Notice>Loading squads…</Notice>}
    {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
    {state.status === 'ready' && (!state.data.length ? <Notice>You haven’t joined a squad yet.</Notice> :
      <div className="card-grid">{state.data.map(squad => <SquadCard key={squad.id} squad={squad} session={session} />)}</div>)}
  </>
}
