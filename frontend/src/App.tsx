import { Goal } from 'lucide-react'
import { useState } from 'react'
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { LoadError, Notice, PageTitle } from './components/ui'
import { errorMessage, useResource } from './hooks/useResource'
import { CreateGame, Dashboard, GameDetail, Invitations, MyGames } from './pages/Games'
import { Discovery, PlayerProfile, ProfileEditor } from './pages/Players'
import { AuthPage, Landing } from './pages/PublicPages'
import { demo, pickup } from './services'
import type { Session } from './types/domain'

function Header({ session }: { session: Session | null }) {
  const [error, setError] = useState('')
  async function logout() {
    setError('')
    try {
      await pickup.signOut()
    } catch (error) {
      setError(errorMessage(error))
    }
  }
  return (
    <header className="site-header">
      <div className="wrap header-layout">
        <Link className="brand" to="/" aria-label="Pickup Sports Tampa home"><span className="brand-icon"><Goal size={23} aria-hidden="true" /></span><span>PICKUP <span>TAMPA</span></span></Link>
        {session ? <>
          <nav aria-label="Main navigation" className="app-nav">
            <NavLink to="/home">Home</NavLink>
            <NavLink to="/players">Find players</NavLink>
            <NavLink to="/games">My games</NavLink>
            <NavLink to="/invitations">Invitations</NavLink>
          </nav>
          <div className="account-actions">
            <Link className="text-link" to={`/players/${session.userId}`}>Profile</Link>
            <button className="button secondary" onClick={() => void logout()}>Log out</button>
          </div>
        </> : <div className="account-actions">
          <Link className="text-link" to="/login">Log in</Link>
          <Link className="button primary" to="/signup">Sign up</Link>
        </div>}
      </div>
      {error && <div className="wrap"><Notice tone="error">{error}</Notice></div>}
    </header>
  )
}

function AppPages({ session }: { session: Session | null }) {
  const location = useLocation()
  const { state, retry } = useResource(session?.userId ?? 'signed-out', () =>
    session ? pickup.getProfile(session.userId) : Promise.resolve(null))

  if (!session) return <Navigate to="/login" replace />
  if (state.status === 'loading') return <Notice>Loading your profile…</Notice>
  if (state.status === 'error') return <LoadError error={state.error} retry={retry} />
  const profile = state.data
  if (!profile) return location.pathname === '/onboarding' ? <ProfileEditor profile={null} /> : <Navigate to="/onboarding" replace />

  return (
    <Routes>
      <Route path="/home" element={<Dashboard profile={profile} session={session} />} />
      <Route path="/onboarding" element={<Navigate to="/home" replace />} />
      <Route path="/profile/edit" element={<ProfileEditor key={profile.id} profile={profile} />} />
      <Route path="/players" element={<Discovery session={session} />} />
      <Route path="/players/:id" element={<PlayerProfile session={session} />} />
      <Route path="/games" element={<MyGames session={session} />} />
      <Route path="/games/new" element={<CreateGame />} />
      <Route path="/games/:id" element={<GameDetail session={session} />} />
      <Route path="/invitations" element={<Invitations session={session} />} />
      <Route path="*" element={<><PageTitle title="Page unavailable" /><Link className="button secondary" to="/home">Back to dashboard</Link></>} />
    </Routes>
  )
}

export default function App() {
  const { state, retry } = useResource('session', () => pickup.getSession())
  const session = state.status === 'ready' ? state.data : null
  return (
    <>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <Header key={session?.userId ?? 'guest'} session={session} />
      {demo && <div className="demo-banner">Demo mode · Data stays in this browser</div>}
      <div id="main-content" tabIndex={-1}>
        {state.status === 'loading' && <main className="wrap app-content"><Notice>Restoring your session…</Notice></main>}
        {state.status === 'error' && <main className="wrap app-content"><LoadError error={state.error} retry={retry} /></main>}
        {state.status === 'ready' && <Routes>
          <Route path="/" element={<main><Landing signedIn={!!session} /></main>} />
          <Route path="/login" element={session ? <Navigate to="/home" replace /> : <AuthPage key="login" mode="login" />} />
          <Route path="/signup" element={session ? <Navigate to="/home" replace /> : <AuthPage key="signup" mode="signup" />} />
          <Route path="*" element={<main className="wrap app-content"><AppPages key={session?.userId ?? 'guest'} session={session} /></main>} />
        </Routes>}
      </div>
    </>
  )
}
