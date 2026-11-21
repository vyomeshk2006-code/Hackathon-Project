
import { useEffect, useId, useState } from 'react'
import { normalizeUsername } from '../lib/account'
import { pickup } from '../services'
import { neighborhoods } from '../types/domain'
import type { Profile } from '../types/domain'

export function AccountFields({ profile, phoneNumber }: { profile: Profile | null; phoneNumber: string | null }) {
  const [username, setUsername] = useState(profile?.username ?? '')
  const [availability, setAvailability] = useState<{ name: string; text: string }>()
  const list = useId()
  const locked = Boolean(profile?.username)
  const normalized = normalizeUsername(username)
  useEffect(() => {
    if (locked || !normalized) return
    let active = true
    const timer = window.setTimeout(() => {
      void pickup.usernameAvailable(normalized).then(
        free => { if (active) setAvailability({ name: normalized, text: free ? 'Username available.' : 'That username is already taken.' }) },
        () => { if (active) setAvailability({ name: normalized, text: 'Availability will be checked when you save.' }) },
      )
    }, 220)
    return () => { active = false; window.clearTimeout(timer) }
  }, [locked, normalized])

  return <div className="form-stack">
    <label>Full name<input name="name" defaultValue={profile?.displayName} required maxLength={60} autoComplete="name" /></label>
    <label>Username<input name="username" value={locked ? profile?.username : username} onChange={event => setUsername(event.target.value)}
      required readOnly={locked} pattern="[A-Za-z0-9_]{3,20}" maxLength={20} autoComplete="username" autoCapitalize="none" spellCheck={false} />
      <span className="field-hint">{locked ? 'Username set during account setup.' : '3–20 letters, digits, or underscores.'}</span>
    </label>
    {!locked && username && <p role="status" className="muted">{!normalized ? 'Enter a valid username.' :
      availability?.name === normalized ? availability.text : 'Checking username…'}</p>}
    <label>Contact phone number<input name="phone" type="tel" defaultValue={phoneNumber ?? ''} required maxLength={32}
      autoComplete="tel" placeholder="+1 202 555 0123" />
      <span className="field-hint">Include the country code. Shared with confirmed participants in your active games.</span>
    </label>
    <label>Neighborhood<input name="neighborhood" list={list} required minLength={2} maxLength={60}
      defaultValue={profile?.neighborhood} placeholder="Choose a suggestion or enter your area" /></label>
    <datalist id={list}>{Object.values(neighborhoods).map(area => <option key={area} value={area} />)}</datalist>
  </div>
}
