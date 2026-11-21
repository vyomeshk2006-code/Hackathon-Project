import { UsersRound } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAction } from '../hooks/useAction'
import { pickup } from '../services'
import type { GameDetails, Team } from '../types/domain'
import { ActionNotice } from './ActionNotice'
import { Avatar } from './ui'

export function TeamRoster({ game, organizer }: { game: GameDetails; organizer: boolean }) {
  const action = useAction()
  const editable = organizer && game.status === 'scheduled'
  return (
    <section className="card form-stack">
      <h2 className="icon-line"><UsersRound size={22} aria-hidden="true" /> Confirmed roster</h2>
      {editable && game.roster.length >= 2 && (
        <button className="button secondary self-start" disabled={action.pending}
          onClick={() => void action.run(() => pickup.autoAssignTeams(game.id), 'Teams assigned by skill and win rate.')}>
          Auto-assign teams
        </button>
      )}
      <ul className="roster">
        {game.roster.map(player => (
          <li key={player.id}>
            <Avatar name={player.displayName} />
            <Link to={`/players/${player.id}`} className="card-link">{player.displayName}</Link>
            {game.organizerId === player.id && <span className="pill">Organizer</span>}
            {editable ? (
              <select className="team-select" aria-label={`Team for ${player.displayName}`} value={player.team ?? ''}
                disabled={action.pending} onChange={event => {
                  const team = (event.target.value || null) as Team | null
                  void action.run(() => pickup.setTeam(game.id, player.id, team), 'Team saved.')
                }}>
                <option value="">Unassigned</option><option value="A">Team A</option><option value="B">Team B</option>
              </select>
            ) : <span className="pill">{player.team ? `Team ${player.team}` : 'Unassigned'}</span>}
          </li>
        ))}
      </ul>
      <ActionNotice {...action} />
    </section>
  )
}

export function GameAdministration({ game }: { game: GameDetails }) {
  const action = useAction()
  const [confirmCancel, setConfirmCancel] = useState(false)
  return (
    <section className="card form-stack">
      <h2>Game management</h2>
      <h3>Sent invitations</h3>
      {game.sentInvitations.length === 0 && <p className="muted">No invitations sent for this game.</p>}
      <ul className="roster">
        {game.sentInvitations.map(invite => (
          <li key={invite.id}>
            <Link className="card-link" to={`/players/${invite.recipientId}`}>{invite.recipientName}</Link>
            <span className="pill capitalize">{invite.status}</span>
            {invite.status === 'pending' && <button className="button secondary" disabled={action.pending}
              aria-label={`Cancel invitation for ${invite.recipientName}`}
              onClick={() => void action.run(() => pickup.cancelInvitation(invite.id), `Invitation for ${invite.recipientName} cancelled.`)}>
              Cancel invitation
            </button>}
          </li>
        ))}
      </ul>
      {game.status === 'scheduled' && (confirmCancel ? (
        <div className="form-stack">
          <p>Cancelling this game also cancels every pending invitation.</p>
          <div className="flex flex-wrap gap-2">
            <button className="button secondary" disabled={action.pending} onClick={() => setConfirmCancel(false)}>Keep game</button>
            <button className="button danger" disabled={action.pending} onClick={() => void action.run(() => pickup.cancelGame(game.id), 'Game cancelled.')}>
              Confirm game cancellation
            </button>
          </div>
        </div>
      ) : <button className="button danger self-start" disabled={action.pending} onClick={() => setConfirmCancel(true)}>Cancel game</button>)}
      <ActionNotice {...action} />
    </section>
  )
}
