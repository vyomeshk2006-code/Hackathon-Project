import { CalendarPlus, MapPin, Search, UsersRound } from 'lucide-react'
import { useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Notice, PageTitle, SportBadge } from '../components/ui'
import { errorMessage } from '../hooks/useResource'
import { demo, pickup } from '../services'
import { sports } from '../types/domain'
import type { Sport } from '../types/domain'

export function Landing({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <section className="hero">
        <div className="wrap hero-content">
          <p className="hero-location"><MapPin size={17} aria-hidden="true" /> Tampa, Florida</p>
          <h1>Find your team.<br /><em>Get in the game.</em></h1>
          <p className="hero-copy">Find local players, organize a pickup game, and get your roster together.</p>
          <div className="flex flex-wrap gap-3">
            <Link className="button primary" to={signedIn ? '/home' : '/signup'}>{signedIn ? 'Open dashboard' : 'Get started'}</Link>
            <Link className="button hero-secondary" to={signedIn ? '/players' : '/login'}>{signedIn ? 'Find players' : demo ? 'Try the demo' : 'Log in'}</Link>
          </div>
        </div>
      </section>
      <section className="sports-strip" aria-label="Supported sports">
        <div className="wrap flex flex-wrap items-center justify-center gap-x-8 gap-y-3">
          {(Object.keys(sports) as Sport[]).map(sport => <SportBadge key={sport} sport={sport} />)}
        </div>
      </section>
      <section className="wrap landing-steps" aria-labelledby="how-heading">
        <h2 id="how-heading">Get a game going</h2>
        <div className="card-grid">
          <article className="card step"><CalendarPlus aria-hidden="true" /><h3>Set the game</h3><p>Pick a sport, a Tampa venue, and a time.</p></article>
          <article className="card step"><Search aria-hidden="true" /><h3>Find players</h3><p>Browse by sport and neighborhood, then invite someone to play.</p></article>
          <article className="card step"><UsersRound aria-hidden="true" /><h3>Fill the roster</h3><p>See who has accepted and how many spots are open.</p></article>
        </div>
      </section>
    </>
  )
}

export function AuthPage({ mode }: { mode: 'login' | 'signup' }) {
  const demoAccess = demo
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const isSignup = mode === 'signup'
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setBusy(true)
    setError('')
    const form = new FormData(event.currentTarget)
    try {
      const email = String(form.get('email'))
      const password = String(form.get('password'))
      if (isSignup) await pickup.signUp(email, password)
      else await pickup.signIn(email, password)
    } catch (error) {
      setError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="wrap auth-page">
      <PageTitle title={isSignup ? 'Create an account' : 'Log in'} subtitle={demo ? 'Use test credentials for this browser demo.' : undefined} />
      <form className="card form-stack" onSubmit={submit}>
        <label>Email<input name="email" type="email" required autoComplete="email" maxLength={254} placeholder={demo ? 'player@example.test' : 'you@example.com'} /></label>
        <label>Password<input name="password" type="password" required minLength={isSignup ? 8 : undefined} maxLength={128} autoComplete={isSignup ? 'new-password' : 'current-password'} placeholder={isSignup ? 'At least 8 characters' : 'Your password'} /></label>
        {error && <Notice tone="error">{error}</Notice>}
        <button className="button primary" disabled={busy}>{busy ? 'Please wait…' : isSignup ? 'Create account' : 'Log in'}</button>
        <p className="muted">{isSignup ? 'Already have an account?' : 'New to Pickup Tampa?'}{' '}
          <Link className="text-link" to={isSignup ? '/login' : '/signup'}>{isSignup ? 'Log in' : 'Sign up'}</Link>
        </p>
      </form>
      {demoAccess && <section className="card demo-options" aria-label="Demo accounts">
        <h2>Try a demo account</h2>
        <p className="muted">Switch between Jordan and Maya to see both sides of an invitation.</p>
        <div className="flex flex-wrap gap-2">
          {demoAccess.accounts.map(account => <button key={account.id} disabled={busy} className="button secondary" onClick={() => {
            try { demoAccess.signIn(account.id) } catch (error) { setError(errorMessage(error)) }
          }}>{account.label}</button>)}
        </div>
      </section>}
    </main>
  )
}
