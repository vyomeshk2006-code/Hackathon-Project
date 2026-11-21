
import { Bell } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { ActionNotice } from '../components/ActionNotice'
import { LoadError, Notice, PageTitle } from '../components/ui'
import { useAction } from '../hooks/useAction'
import { useResource } from '../hooks/useResource'
import { formatGameTime } from '../lib/time'
import { pickup } from '../services'
import type { Notification, Session } from '../types/domain'

function useNotifications(session: Session) {
  return useResource('notifications:' + session.userId, () => pickup.notifications(), pickup.subscribeToNotifications)
}

export function NotificationBell({ session }: { session: Session }) {
  const { state } = useNotifications(session)
  const count = state.status === 'ready' ? state.data.filter(item => !item.readAt).length : 0
  return <Link className="notification-bell" to="/notifications" aria-label={count ? 'Notifications, ' + count + ' unread' : 'Notifications'}>
    <Bell size={21} aria-hidden="true" />{count > 0 && <span aria-hidden="true">{count}</span>}
  </Link>
}

function destination(item: Notification) {
  if (item.type === 'invitation_received' && item.invitationId) return '/invitations?invitation=' + item.invitationId
  if (item.requestId && item.type === 'join_request_received' && item.gameId) return '/games/' + item.gameId + '?request=' + item.requestId
  if (item.gameId) return '/games/' + item.gameId
  if (item.squadId) return '/squads'
  return '/home'
}

export function Notifications({ session }: { session: Session }) {
  const { state, retry } = useNotifications(session)
  const action = useAction()
  const navigate = useNavigate()
  const anyUnread = state.status === 'ready' && state.data.some(item => !item.readAt)
  async function open(item: Notification) {
    if (!item.readAt && !await action.run(() => pickup.markNotificationsRead([item.id]), '')) return
    navigate(destination(item))
  }
  return <>
    <PageTitle title="Notifications" action={anyUnread && <button className="button secondary" disabled={action.pending}
      onClick={() => void action.run(() => pickup.markNotificationsRead(), 'All notifications marked read.')}>Mark all as read</button>} />
    <ActionNotice {...action} />
    {state.status === 'loading' && <Notice>Loading notifications…</Notice>}
    {state.status === 'error' && <LoadError error={state.error} retry={retry} />}
    {state.status === 'ready' && (!state.data.length ? <Notice>You have no notifications yet.</Notice> :
      <div className="section-stack">{state.data.map(item => <article key={item.id} className={'card notice-row' + (item.readAt ? '' : ' unread')}>
        <div><h2>{item.title}{!item.readAt && <span className="pill">Unread</span>}</h2>
          <p>{item.body}</p><time className="muted" dateTime={item.createdAt}>{formatGameTime(item.createdAt)}</time></div>
        <div className="flex flex-wrap gap-2">
          <button className="button secondary" disabled={action.pending} onClick={() => void open(item)}>Open</button>
          {!item.readAt && <button className="text-link" disabled={action.pending}
            onClick={() => void action.run(() => pickup.markNotificationsRead([item.id]), 'Notification marked read.')}>Mark as read</button>}
        </div>
      </article>)}</div>)}
  </>
}
