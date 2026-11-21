
import { useEffect, useReducer } from 'react'

/** Reevaluate on the next known game boundary and on return from a throttled tab. */
export function useGameClock(timestamps: readonly (string | null)[]) {
  const [, refresh] = useReducer((version: number) => version + 1, 0)
  const now = Date.now()
  const next = Math.min(...timestamps.map(value => value ? Date.parse(value) : Infinity)
    .filter(time => time > now))

  useEffect(() => {
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    const timer = Number.isFinite(next)
      ? window.setTimeout(refresh, Math.min(2_147_483_647, Math.max(0, next - Date.now())))
      : undefined
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
      window.clearTimeout(timer)
    }
  }, [next])
  return now
}
