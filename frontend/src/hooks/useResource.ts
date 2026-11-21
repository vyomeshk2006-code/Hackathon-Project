import { useEffect, useEffectEvent, useState } from 'react'
import { pickup } from '../services'

export const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.'

type State<T> = { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: string }

export function useResource<T>(key: string, load: () => Promise<T>, subscribe = pickup.subscribe) {
  const [result, setResult] = useState<{ key: string; state: State<T> }>()
  const [retryCount, setRetryCount] = useState(0)
  const loadCurrent = useEffectEvent(load)

  useEffect(() => {
    let version = 0
    function refresh() {
      const request = ++version
      void loadCurrent().then(
        data => {
          if (request === version) setResult({ key, state: { status: 'ready', data } })
        },
        error => {
          if (request === version) setResult({ key, state: { status: 'error', error: errorMessage(error) } })
        },
      )
    }
    const unsubscribe = subscribe(refresh)
    refresh()
    return () => {
      version += 1
      unsubscribe()
    }
  }, [key, retryCount, subscribe])

  return {
    state: result?.key === key ? result.state : { status: 'loading' } as const,
    retry: () => setRetryCount(count => count + 1),
  }
}
