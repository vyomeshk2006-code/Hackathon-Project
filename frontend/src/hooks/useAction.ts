import { useState } from 'react'
import { errorMessage } from './useResource'

export function useAction() {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function run(action: () => Promise<unknown>, success: string) {
    setPending(true)
    setError('')
    setMessage('')
    try {
      await action()
      setMessage(success)
      return true
    } catch (error) {
      setError(errorMessage(error))
      return false
    } finally {
      setPending(false)
    }
  }
  return { pending, error, message, run }
}
