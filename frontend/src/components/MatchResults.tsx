import { useState } from 'react'
import type { FormEvent } from 'react'
import { useAction } from '../hooks/useAction'
import { tampaInput } from '../lib/time'
import { pickup } from '../services'
import { statLabel } from '../types/domain'
import { useCatalog } from './SportPicker'
import type { GameDetails, GameResult, Performance } from '../types/domain'
import { ActionNotice } from './ActionNotice'
import { Notice } from './ui'

const statusLabel = { pending: 'Awaiting confirmation', final: 'Final', disputed: 'Disputed' }

function ResultsForm({ game, onSave }: { game: GameDetails; onSave: () => void }) {
  const action = useAction()
  const fields = useCatalog().find(sport => sport.slug === game.sport)?.fields ?? []
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const performances = fields.length ? game.roster.map(player => {
      const row: Performance = { playerId: player.id, metrics: Object.fromEntries(fields.map(field =>
        [field, Number(form.get(player.id + ':' + field))])) }
      return row
    }) : []
    const accepted = await action.run(() => pickup.submitResults(game.id, {
      teamAScore: Number(form.get('scoreA')), teamBScore: Number(form.get('scoreB')), performances,
    }), 'Results submitted.')
    if (accepted) onSave()
  }

  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <label>Team A score<input type="number" name="scoreA" required min={0} max={999} defaultValue={game.result?.teamAScore ?? 0} /></label>
        <label>Team B score<input type="number" name="scoreB" required min={0} max={999} defaultValue={game.result?.teamBScore ?? 0} /></label>
      </div>
      {fields.length > 0 && <fieldset>
        <legend>Player performance</legend>
        <div className="preference-grid">
          {game.roster.map(player => {
            const current = game.performances.find(row => row.playerId === player.id)
            return <fieldset className="preference-option" key={player.id}>
              <legend>{player.displayName} · Team {player.team}</legend>
              {fields.map(field => (
                <label key={field}><span className="capitalize">{statLabel(field)}</span>
                  <input name={`${player.id}:${field}`} type="number" min={0} max={32767}
                    defaultValue={current?.metrics[field] ?? 0} />
                </label>
              ))}
            </fieldset>
          })}
        </div>
      </fieldset>}
      <button className="button primary self-start" disabled={action.pending}>{action.pending ? 'Submitting…' : 'Submit results'}</button>
      <ActionNotice {...action} />
    </form>
  )
}

function Scorecard({ game, result }: { game: GameDetails; result: GameResult }) {
  const fields = useCatalog().find(sport => sport.slug === game.sport)?.fields ?? []
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pill">{statusLabel[result.status]}</span>
        <span className="muted">Revision {result.revision}</span>
      </div>
      <p className="score-line">Team A <strong>{result.teamAScore}–{result.teamBScore}</strong> Team B</p>
      {result.disputeReason && <Notice>Dispute reason: {result.disputeReason}</Notice>}
      {game.performances.length > 0 && <div className="table-scroll">
        <table className="stats-table">
          <caption>Player performance · Revision {result.revision}</caption>
          <thead><tr><th scope="col">Player</th><th scope="col">Team</th><th scope="col">Outcome</th>
            {fields.map(field => <th scope="col" className="capitalize" key={field}>{statLabel(field)}</th>)}</tr></thead>
          <tbody>{game.performances.map(row => <tr key={row.playerId}>
            <th scope="row">{game.roster.find(player => player.id === row.playerId)?.displayName}</th>
            <td>{row.team}</td><td className="capitalize">{row.outcome}</td>
            {fields.map(field => <td key={field}>{row.metrics[field] ?? 0}</td>)}
          </tr>)}</tbody>
        </table>
      </div>}
    </>
  )
}

function ResultResponse({ gameId }: { gameId: string }) {
  const action = useAction()
  const [disputing, setDisputing] = useState(false)
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = String(new FormData(event.currentTarget).get('reason'))
    void action.run(() => pickup.disputeResults(gameId, reason), 'Result disputed.')
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <button className="button primary" disabled={action.pending}
          onClick={() => void action.run(() => pickup.confirmResults(gameId), 'Result confirmed.')}>Confirm results</button>
        <button className="button secondary" disabled={action.pending} aria-expanded={disputing}
          onClick={() => setDisputing(open => !open)}>{disputing ? 'Close dispute form' : 'Dispute results'}</button>
      </div>
      {disputing && <form className="form-stack" onSubmit={submit}>
        <label>Reason for dispute<textarea name="reason" required maxLength={300} rows={3} /></label>
        <button className="button secondary self-start" disabled={action.pending}>Submit dispute</button>
      </form>}
      <ActionNotice {...action} />
    </>
  )
}

function GameReviews({ game, userId }: { game: GameDetails; userId: string }) {
  const action = useAction()
  const others = game.roster.filter(player => player.id !== userId)
  const eligible = others.filter(player => !game.reviewedPlayerIds.includes(player.id))
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const element = event.currentTarget
    const form = new FormData(element)
    const saved = await action.run(() => pickup.submitReview(game.id, {
      revieweeId: String(form.get('reviewee')), rating: Number(form.get('rating')),
      skillRating: Number(form.get('skillRating')), comment: String(form.get('comment')),
    }), 'Review posted to the player’s profile.')
    if (saved) element.reset()
  }
  return (
    <section className="card form-stack editor">
      <h2>Review a player</h2>
      <p className="muted">Reviews are anonymous and open to teammates and opponents.</p>
      {eligible.length ? <form className="form-stack" onSubmit={submit}>
        <div className="form-grid">
          <label>Player to review<select name="reviewee" required defaultValue="">
            <option value="" disabled>Choose a player</option>
            {eligible.map(player => <option key={player.id} value={player.id}>{player.displayName}</option>)}
          </select></label>
          <label>Sportsmanship rating<select name="rating" required defaultValue="">
            <option value="" disabled>Choose a rating</option>
            {[5, 4, 3, 2, 1].map(rating => <option key={rating} value={rating}>{rating} / 5</option>)}
          </select></label>
        </div>
        <label>Skill rating<select name="skillRating" required defaultValue="">
          <option value="" disabled>Choose a rating</option>
          {[5, 4, 3, 2, 1].map(rating => <option key={rating} value={rating}>{rating} / 5</option>)}
        </select></label>
        <label>Comment (optional)<textarea name="comment" maxLength={500} rows={3} /></label>
        <button className="button primary self-start" disabled={action.pending}>Post review</button>
      </form> : <p className="muted">You’ve reviewed every other player from this game.</p>}
      <ActionNotice {...action} />
    </section>
  )
}

export function MatchResults({ game, userId }: { game: GameDetails; userId: string }) {
  const [editing, setEditing] = useState(false)
  const organizer = game.organizerId === userId
  const onRoster = game.roster.some(player => player.id === userId)
  if (!onRoster || game.status === 'cancelled') return null
  const { result } = game
  const gameDay = tampaInput(new Date(game.startsAt)).slice(0, 10) <= tampaInput(new Date()).slice(0, 10)
  const teamsReady = game.roster.every(player => player.team) &&
    game.roster.some(player => player.team === 'A') && game.roster.some(player => player.team === 'B')
  return (
    <>
      <section className="card form-stack">
        <h2>Match results</h2>
        {result && <Scorecard game={game} result={result} />}
        {result?.status === 'pending' && <p className="muted">A roster player other than the organizer must confirm before these stats count.</p>}
        {result?.status === 'pending' && result.submittedBy !== userId && <ResultResponse key={result.revision} gameId={game.id} />}
        {!result && !organizer && <p className="muted">The organizer hasn’t submitted a result yet.</p>}
        {organizer && (
          !gameDay ? <p className="muted">Results open on game day in Tampa.</p> :
          !teamsReady ? <p className="muted">Assign every roster player and put at least one player on each team to submit results.</p> :
          <>
            {result && <button className="button secondary self-start" aria-expanded={editing}
              onClick={() => setEditing(value => !value)}>{editing ? 'Close revision form' : 'Revise results'}</button>}
            {result?.status === 'final' && editing && <Notice>A revised result needs confirmation before it counts toward player stats again.</Notice>}
            {(!result || editing) && <ResultsForm key={result?.revision ?? 0} game={game} onSave={() => setEditing(false)} />}
          </>
        )}
      </section>
      {result?.status === 'final' && <GameReviews game={game} userId={userId} />}
    </>
  )
}
