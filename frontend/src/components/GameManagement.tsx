import { UsersRound } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAction } from '../hooks/useAction'
import { pickup } from '../services'
import { isUpcoming, skills } from '../types/domain'
import type { BulkInviteResult, GameDetails, Session, Team } from '../types/domain'
import { errorMessages } from '../services/errors'
import { useResource } from '../hooks/useResource'
import { ActionNotice } from './ActionNotice'
import { Avatar, LoadError, Notice } from './ui'

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
      {(['A', 'B', null] as const).map(team => {
        const members = game.roster.filter(row => row.team === team)
        if (team === null && !members.length) return null
        return <div key={team ?? 'unassigned'} className="section-stack">
          <h3>{team ? 'Team ' + team + (game.teamSize ? ' · ' + members.length + ' / ' + game.teamSize : '') : 'Unassigned'}</h3>
          {members.length === 0 && <p className="muted">No players assigned yet.</p>}
          <ul className="roster">
        {members.map(player => (
          <li key={player.id}>
            <Avatar name={player.displayName} />
            <Link to={`/players/${player.id}`} className="card-link">{player.displayName}</Link>
            <div><p className="muted">{player.skill ? skills[player.skill] + ' · ' : ''}{player.stats.gamesPlayed} played · {player.stats.wins} wins</p>
              {game.organizerId === player.id && <span className="pill">Organizer</span>}</div>
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
        </div>
      })}
      <ActionNotice {...action} />
    </section>
  )
}

export function GameAdministration({ game, session, focusRequest }: { game: GameDetails; session: Session; focusRequest: string | null }) {
  const action = useAction()
  const [confirmCancel, setConfirmCancel] = useState(false)
  return (
    <section className="card form-stack">
      <h2>Game management</h2>
      {isUpcoming(game) && <SquadInvites game={game} session={session} />}
      <h3>Join requests</h3>
      {game.joinRequests.length === 0 && <p className="muted">No join requests for this game.</p>}
      <div className="section-stack">
        {[...game.joinRequests].sort((a, b) => Number(b.id === focusRequest) - Number(a.id === focusRequest))
          .map(request => <JoinRequestControl key={request.id} request={request} upcoming={isUpcoming(game)} />)}
      </div>
      <h3>Sent invitations</h3>
      {game.sentInvitations.length === 0 && <p className="muted">No invitations sent for this game.</p>}
      <ul className="roster">
        {game.sentInvitations.map(invite => (
          <li key={invite.id}>
            <Link className="card-link" to={`/players/${invite.recipientId}`}>{invite.recipientName}</Link>
            <span className="pill capitalize">{invite.status}</span>{invite.team && <span className="pill">Team {invite.team}</span>}
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


export function TeamPicker({ team, onChange }: { team: Team | null; onChange: (value: Team | null) => void }) {
  return <label>Team<select value={team ?? ''} onChange={event => onChange((event.target.value || null) as Team | null)}>
    <option value="">Unassigned</option><option value="A">Team A</option><option value="B">Team B</option>
  </select></label>
}

export function InviteReport({ results, names }: { results: BulkInviteResult[] | null; names: Record<string, string> }) {
  if (!results) return null
  const sent = results.filter(row => row.invitationId).length
  return <div className="section-stack" role="status">
    <p>{sent} sent or already pending · {results.length - sent} skipped</p>
    {results.length === 0 && <p className="muted">No players outside the roster to invite.</p>}
    {results.filter(row => row.error).map(row => <p className="muted" key={row.recipientId}>
      {names[row.recipientId] ?? 'Player'}: {errorMessages[row.error as keyof typeof errorMessages] ?? row.error}
    </p>)}
  </div>
}

function SquadInvites({ game, session }: { game: GameDetails; session: Session }) {
  const { state, retry } = useResource('game-squad:' + session.userId, () => pickup.mySquads())
  const action = useAction()
  const [team, setTeam] = useState<Team | null>(null)
  const [selected, setSelected] = useState('')
  const [results, setResults] = useState<BulkInviteResult[] | null>(null)
  if (state.status === 'loading') return <Notice>Loading your squads…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  const squads = state.data.filter(squad => squad.sport === game.sport)
  const names = Object.fromEntries(squads.flatMap(squad => squad.members.map(member => [member.id, member.displayName])))
  if (!squads.length) return <p className="muted">No matching squads. <Link className="text-link" to="/squads">Manage squads</Link></p>
  return <div className="form-stack">
    <h3>Invite a squad</h3>
    <div className="form-grid">
      <label>Squad<select value={selected} onChange={event => setSelected(event.target.value)}>
        <option value="">Choose a squad</option>{squads.map(squad => <option key={squad.id} value={squad.id}>{squad.name}</option>)}
      </select></label>
      <TeamPicker team={team} onChange={setTeam} />
    </div>
    <button className="button secondary self-start" disabled={action.pending || !squads.some(squad => squad.id === selected)}
      onClick={() => void action.run(async () => {
        setResults(null)
        setResults(await pickup.inviteSquad(game.id, selected, team))
      }, '')}>Invite squad</button>
    <ActionNotice {...action} /><InviteReport results={results} names={names} />
  </div>
}

function JoinRequestControl({ request, upcoming }: { request: GameDetails['joinRequests'][number]; upcoming: boolean }) {
  const action = useAction()
  const [team, setTeam] = useState<Team | null>(null)
  return <div className="preference-option">
    <div className="flex flex-wrap gap-2 items-center"><Link className="card-link" to={'/players/' + request.playerId}>{request.playerName}</Link>
      <span className="pill capitalize">{request.status}</span></div>
    <p className="muted">{[request.username && '@' + request.username, request.neighborhood, request.skill && skills[request.skill]].filter(Boolean).join(' · ')}</p>
    {request.status === 'pending' && upcoming && <>
      <TeamPicker team={team} onChange={setTeam} />
      <div className="flex gap-2 flex-wrap">
        <button className="button primary" disabled={action.pending}
          onClick={() => void action.run(() => pickup.respondToJoinRequest(request.id, 'approved', team), 'Request approved.')}>Approve request</button>
        <button className="button secondary" disabled={action.pending}
          onClick={() => void action.run(() => pickup.respondToJoinRequest(request.id, 'declined'), 'Request declined.')}>Decline request</button>
      </div>
    </>}
    <ActionNotice {...action} />
  </div>
}

export function WithdrawGame({ game }: { game: GameDetails }) {
  const action = useAction()
  const navigate = useNavigate()
  const [confirm, setConfirm] = useState(false)
  const lastMinute = Date.parse(game.startsAt) - Date.now() <= 60 * 60_000
  async function withdraw() {
    if (await action.run(() => pickup.withdraw(game.id), 'You withdrew from this game.')) navigate('/games')
  }
  return <div className="form-stack">
    {confirm ? <>
      <p>The organizer will be notified.{lastMinute && ' Eligible players may receive a replacement alert.'}</p>
      <div className="flex gap-2 flex-wrap">
        <button className="button secondary" disabled={action.pending} onClick={() => setConfirm(false)}>Keep my spot</button>
        <button className="button danger" disabled={action.pending} onClick={() => void withdraw()}>Confirm withdrawal</button>
      </div>
    </> : <button className="button secondary self-start" onClick={() => setConfirm(true)}>Withdraw from game</button>}
    <ActionNotice {...action} />
  </div>
}
