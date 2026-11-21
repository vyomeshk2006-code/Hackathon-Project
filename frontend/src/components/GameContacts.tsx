
import { pickup } from '../services'
import { useResource } from '../hooks/useResource'
import { LoadError, Notice } from './ui'

export function GameContacts({ gameId, userId }: { gameId: string; userId: string }) {
  const { state, retry } = useResource('contacts:' + userId + ':' + gameId, () => pickup.getGameContacts(gameId))
  return <section className="card form-stack">
    <h2>Game contacts</h2>
    <p className="muted">Available to confirmed players and the organizer until the game ends or closes.</p>
    {state.status === 'loading' && <Notice>Loading contacts…</Notice>}
    {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
    {state.status === 'ready' && (state.data.length
      ? <ul className="roster contact-list">{state.data.map(contact => <li key={contact.playerId}>
        <strong>{contact.name}</strong>
        <a className="text-link" href={'tel:' + contact.phoneNumber}>{contact.phoneNumber}</a>
      </li>)}</ul>
      : <p className="muted">Contacts appear when other players are confirmed.</p>)}
  </section>
}
