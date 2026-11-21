
import { useCallback, useState } from 'react'
import type { FormEvent } from 'react'
import { ActionNotice } from './ActionNotice'
import { LoadError, Notice } from './ui'
import { useAction } from '../hooks/useAction'
import { useResource } from '../hooks/useResource'
import { formatGameTime } from '../lib/time'
import { pickup } from '../services'
import type { GameDetails } from '../types/domain'

export function GameChat({ game, userId }: { game: GameDetails; userId: string }) {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const action = useAction()
  const subscribe = useCallback((listener: () => void) => pickup.subscribeToChat(game.id, listener), [game.id])
  const status = useResource('chat-status:' + userId + ':' + game.id, () => pickup.getChatStatus(game.id), subscribe)
  const history = useResource('chat:' + userId + ':' + game.id + ':' + open,
    () => open ? pickup.getChat(game.id) : Promise.resolve([]), subscribe)
  const hasNew = status.state.status === 'ready' && status.state.data.hasNew
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (await action.run(() => pickup.sendMessage(game.id, message), '')) setMessage('')
  }

  return <section className="card form-stack">
    <div className="flex flex-wrap justify-between items-center gap-2">
      <h2>Game chat {hasNew && <span className="pill">New messages</span>}</h2>
      <button className="button secondary" aria-expanded={open} disabled={action.pending} onClick={() => {
        if (open) { setOpen(false); return }
        setOpen(true)
        void action.run(() => pickup.markChatRead(game.id), '')
      }}>{open ? 'Close chat' : 'Open chat'}</button>
    </div>
    {open && <>
      {history.state.status === 'loading' && <Notice>Loading messages…</Notice>}
      {history.state.status === 'error' && <LoadError error={history.state.error} retry={history.retry} />}
      {history.state.status === 'ready' && (history.state.data.length ? <ul className="chat-list" aria-label="Game messages">
        {history.state.data.map(row => <li key={row.id}><strong>{row.senderName}</strong>
          <time dateTime={row.createdAt} className="muted">{formatGameTime(row.createdAt)}</time><p>{row.body}</p></li>)}
      </ul> : <p className="muted">No messages yet.</p>)}
      {hasNew && <button className="text-link self-start" disabled={action.pending}
        onClick={() => void action.run(() => pickup.markChatRead(game.id), 'Chat marked read.')}>Mark chat as read</button>}
      {game.status !== 'cancelled' ? <form className="form-stack" onSubmit={send}>
        <label>Message<textarea value={message} onChange={event => setMessage(event.target.value)} maxLength={1000} rows={2} required /></label>
        <button className="button primary self-start" disabled={action.pending || !message.trim()}>Send message</button>
      </form> : <p className="muted">This cancelled game’s chat is read-only.</p>}
    </>}
    <ActionNotice {...action} />
  </section>
}
